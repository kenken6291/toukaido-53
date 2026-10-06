/**
 * 仮想東海道五十三次ラリー｜歩いて京へ - バックエンド (Google Apps Script)
 * 構成: スプレッドシート(members / records) + Google Drive(写真) + Gemini API(旅の一言コメント)
 *
 * 【デプロイ前に スクリプトのプロパティ に以下を設定してください】
 *   SPREADSHEET_ID   : このアプリ専用のスプレッドシートID
 *   DRIVE_FOLDER_ID  : 写真保存用Googleドライブフォルダの ID
 *   GEMINI_API_KEY   : Gemini APIキー
 *   PEPPER           : パスワードハッシュ用の固定文字列（自分で好きな文字列を設定。例: ランダムな32文字）
 *
 * 【スプレッドシートの準備】
 *   1シート目のタブ名は何でもOK。members / records シートは初回アクセス時に自動生成されます。
 *
 * 【更新履歴】
 *   - 道中記（現在地・累計距離）の公開/非公開設定（members.progressVisibility）を追加
 *   - 番付・レースページ用の getRanking を追加（総合／今月／今週）
 *   - みんなの旅の「○○宿 付近」表示は、道中記を公開している人だけに限定
 *   - 記録ごとの公開/非公開（records.visibility）と、会員同士の励ましコメント（comments シート）に対応
 *     getFeed / addComment / deleteComment を追加
 *   - 写真の表示URLを lh3.googleusercontent.com 形式で返すよう変更（uc?id= 形式は表示されないことがあるため）
 *   - タイムラインの記録の修正（日付・歩数・写真差し替え/削除）と削除に対応（updateRecord / deleteRecord）
 *   - 写真のDriveファイルIDを records.driveFileId に保存するよう修正（削除・差し替え時にゴミ箱へ移動）
 *   - getState の日付を yyyy-MM-dd 形式に統一して返すよう修正
 */

const SS_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
const DRIVE_FOLDER_ID = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const PEPPER = PropertiesService.getScriptProperties().getProperty('PEPPER');

const SESSION_TTL_SEC = 60 * 60 * 24; // セッション有効期限 24時間
const MAX_FAILED = 5;                 // ログイン失敗許容回数
const LOCK_MINUTES = 15;              // ロック時間(分)
const MAX_STEPS = 200000;             // 1記録あたりの歩数上限（入力ミス防止）
const MAX_COMMENT_LEN = 200;          // コメントの最大文字数
const FEED_PAGE_SIZE = 20;            // みんなの旅 1回の取得件数

// ============ 東海道五十三次 宿場データ（日本橋からの累計距離 km）============
const STATIONS = [
  {name:'日本橋', km:0.0},
  {name:'品川宿', km:7.9}, {name:'川崎宿', km:17.7}, {name:'神奈川宿', km:27.5},
  {name:'保土ヶ谷宿', km:32.4}, {name:'戸塚宿', km:41.2}, {name:'藤沢宿', km:49.1},
  {name:'平塚宿', km:62.8}, {name:'大磯宿', km:65.7}, {name:'小田原宿', km:81.4},
  {name:'箱根宿', km:98.0}, {name:'三島宿', km:112.8}, {name:'沼津宿', km:118.7},
  {name:'原宿', km:124.6}, {name:'吉原宿', km:136.4}, {name:'蒲原宿', km:147.6},
  {name:'由比宿', km:151.5}, {name:'興津宿', km:160.7}, {name:'江尻宿', km:164.8},
  {name:'府中宿', km:175.4}, {name:'鞠子宿', km:181.1}, {name:'岡部宿', km:189.0},
  {name:'藤枝宿', km:195.8}, {name:'島田宿', km:204.5}, {name:'金谷宿', km:208.4},
  {name:'日坂宿', km:214.9}, {name:'掛川宿', km:222.0}, {name:'袋井宿', km:231.6},
  {name:'見付宿', km:237.5}, {name:'浜松宿', km:254.0}, {name:'舞坂宿', km:264.9},
  {name:'新居宿', km:270.8}, {name:'白須賀宿', km:277.3}, {name:'二川宿', km:283.1},
  {name:'吉田宿', km:289.2}, {name:'御油宿', km:299.5}, {name:'赤坂宿', km:301.2},
  {name:'藤川宿', km:310.0}, {name:'岡崎宿', km:316.7}, {name:'池鯉鮒宿', km:331.7},
  {name:'鳴海宿', km:342.8}, {name:'宮宿', km:349.3}, {name:'桑名宿', km:373.8},
  {name:'四日市宿', km:386.5}, {name:'石薬師宿', km:397.3}, {name:'庄野宿', km:400.0},
  {name:'亀山宿', km:407.9}, {name:'関宿', km:413.8}, {name:'坂下宿', km:420.3},
  {name:'土山宿', km:430.1}, {name:'水口宿', km:440.7}, {name:'石部宿', km:454.4},
  {name:'草津宿', km:466.2}, {name:'大津宿', km:480.6}, {name:'京・三条大橋', km:492.4}
];

// ============ シート取得 ============
function getSS_() { return SpreadsheetApp.openById(SS_ID); }

function getMembersSheet_() {
  const ss = getSS_();
  let sh = ss.getSheetByName('members');
  if (!sh) {
    sh = ss.insertSheet('members');
    sh.appendRow(['memberId','nickname','email','passwordHash','salt','mustChangePassword','failedAttempts','lockUntil','createdAt','progressVisibility']);
  } else if (sh.getRange(1, 10).getValue() !== 'progressVisibility') {
    // 旧バージョンのシートに列を追加（既存会員は空欄＝非公開扱い）
    sh.getRange(1, 10).setValue('progressVisibility');
  }
  return sh;
}
function getRecordsSheet_() {
  const ss = getSS_();
  let sh = ss.getSheetByName('records');
  if (!sh) {
    sh = ss.insertSheet('records');
    sh.appendRow(['recordId','memberId','date','steps','distanceKm','driveFileId','photoUrl','comment','createdAt','visibility']);
  } else if (sh.getRange(1, 10).getValue() !== 'visibility') {
    // 旧バージョンのシートに visibility 列を追加（既存の記録は空欄＝非公開扱い）
    sh.getRange(1, 10).setValue('visibility');
  }
  return sh;
}
function getCommentsSheet_() {
  const ss = getSS_();
  let sh = ss.getSheetByName('comments');
  if (!sh) {
    sh = ss.insertSheet('comments');
    sh.appendRow(['commentId','recordId','memberId','text','createdAt']);
  }
  return sh;
}

// ============ エントリポイント ============
function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({ok:true, message:'toukaido-53 API is running'}))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return respond_({ok:false, error:'invalid_request'});
  }
  try {
    switch (body.action) {
      case 'register':             return respond_(register_(body));
      case 'login':                return respond_(login_(body));
      case 'changePassword':       return respond_(changePassword_(body));
      case 'requestPasswordReset': return respond_(requestPasswordReset_(body));
      case 'logout':               return respond_(logout_(body));
      case 'submitRecord':         return respond_(submitRecord_(body));
      case 'updateRecord':         return respond_(updateRecord_(body));
      case 'deleteRecord':         return respond_(deleteRecord_(body));
      case 'getState':             return respond_(getState_(body));
      case 'getFeed':              return respond_(getFeed_(body));
      case 'addComment':           return respond_(addComment_(body));
      case 'deleteComment':        return respond_(deleteComment_(body));
      case 'setProgressVisibility':return respond_(setProgressVisibility_(body));
      case 'getRanking':           return respond_(getRanking_(body));
      default: return respond_({ok:false, error:'unknown_action'});
    }
  } catch (err) {
    return respond_({ok:false, error:'server_error', detail:String(err)});
  }
}

// text/plain で返す（GitHub PagesからのCORSプリフライト回避のため、フロント側もtext/plainで送信すること）
function respond_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.TEXT);
}

// ============ パスワードハッシュ ============
function makeSalt_() { return Utilities.getUuid(); }

function hashPassword_(password, salt) {
  const raw = password + ':' + salt + ':' + PEPPER;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, raw, Utilities.Charset.UTF_8);
  return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
}

function genTempPassword_() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(0,O,1,I等)を除外
  let s = '';
  for (let i = 0; i < 8; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

function findMemberByEmail_(data, email) {
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][2]).toLowerCase() === email) return {row: i + 1, values: data[i]};
  }
  return null;
}

// ============ 会員登録 ============
function register_(body) {
  const nickname = (body.nickname || '').trim();
  const email = (body.email || '').trim().toLowerCase();
  if (!nickname || !email) return {ok:false, error:'missing_fields'};
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return {ok:false, error:'invalid_email'};

  const sh = getMembersSheet_();
  const data = sh.getDataRange().getValues();
  if (findMemberByEmail_(data, email)) return {ok:false, error:'email_exists'};

  const memberId = Utilities.getUuid();
  const tempPassword = genTempPassword_();
  const salt = makeSalt_();
  const hash = hashPassword_(tempPassword, salt);
  sh.appendRow([memberId, nickname, email, hash, salt, true, 0, '', new Date()]);

  try {
    MailApp.sendEmail({
      to: email,
      subject: '【仮想東海道五十三次ラリー】仮パスワードのお知らせ',
      body: nickname + ' 様\n\n仮想東海道五十三次ラリーへのご登録ありがとうございます。\n' +
            '下記の仮パスワードでログインし、初回ログイン後に必ずパスワードを変更してください。\n\n' +
            '仮パスワード: ' + tempPassword + '\n\n' +
            '▼ログインはこちら\nhttps://kenken6291.github.io/toukaido-53/\n'
    });
  } catch (err) {
    return {ok:false, error:'mail_failed'};
  }
  return {ok:true};
}

// ============ ログイン ============
function login_(body) {
  const email = (body.email || '').trim().toLowerCase();
  const password = body.password || '';
  if (!email || !password) return {ok:false, error:'missing_fields'};

  const sh = getMembersSheet_();
  const data = sh.getDataRange().getValues();
  const found = findMemberByEmail_(data, email);
  if (!found) return {ok:false, error:'invalid_credentials'};

  const [memberId, nickname, , passwordHash, salt, mustChange, failedAttempts, lockUntil] = found.values;

  if (lockUntil && new Date(lockUntil).getTime() > Date.now()) {
    return {ok:false, error:'locked', lockUntil: lockUntil};
  }

  const hash = hashPassword_(password, salt);
  if (hash !== passwordHash) {
    const newFailed = (Number(failedAttempts) || 0) + 1;
    let newLock = '';
    if (newFailed >= MAX_FAILED) newLock = new Date(Date.now() + LOCK_MINUTES * 60 * 1000).toISOString();
    sh.getRange(found.row, 7).setValue(newFailed);
    sh.getRange(found.row, 8).setValue(newLock);
    if (newLock) return {ok:false, error:'locked', lockUntil:newLock};
    return {ok:false, error:'invalid_credentials', remaining: MAX_FAILED - newFailed};
  }

  sh.getRange(found.row, 7).setValue(0);
  sh.getRange(found.row, 8).setValue('');

  const sessionToken = Utilities.getUuid();
  CacheService.getScriptCache().put('session_' + sessionToken, memberId, SESSION_TTL_SEC);

  return {ok:true, sessionToken, memberId, nickname, mustChangePassword: !!mustChange};
}

function requireSession_(sessionToken) {
  if (!sessionToken) return null;
  return CacheService.getScriptCache().get('session_' + sessionToken);
}

// ============ パスワード変更・再発行 ============
function changePassword_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};
  const newPassword = body.newPassword || '';
  if (newPassword.length < 8) return {ok:false, error:'password_too_short'};

  const sh = getMembersSheet_();
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === memberId) {
      const salt = makeSalt_();
      sh.getRange(i + 1, 4).setValue(hashPassword_(newPassword, salt));
      sh.getRange(i + 1, 5).setValue(salt);
      sh.getRange(i + 1, 6).setValue(false);
      return {ok:true};
    }
  }
  return {ok:false, error:'member_not_found'};
}

function requestPasswordReset_(body) {
  const email = (body.email || '').trim().toLowerCase();
  if (!email) return {ok:false, error:'missing_fields'};
  const sh = getMembersSheet_();
  const data = sh.getDataRange().getValues();
  const found = findMemberByEmail_(data, email);
  if (!found) return {ok:true}; // メールアドレスの存在有無は漏らさない

  const tempPassword = genTempPassword_();
  const salt = makeSalt_();
  sh.getRange(found.row, 4).setValue(hashPassword_(tempPassword, salt));
  sh.getRange(found.row, 5).setValue(salt);
  sh.getRange(found.row, 6).setValue(true);
  sh.getRange(found.row, 7).setValue(0);
  sh.getRange(found.row, 8).setValue('');

  try {
    MailApp.sendEmail({
      to: email,
      subject: '【仮想東海道五十三次ラリー】仮パスワード再発行',
      body: '仮パスワードを再発行しました。\n\n仮パスワード: ' + tempPassword + '\n\nログイン後、新しいパスワードに変更してください。'
    });
  } catch (err) {
    return {ok:false, error:'mail_failed'};
  }
  return {ok:true};
}

function logout_(body) {
  CacheService.getScriptCache().remove('session_' + body.sessionToken);
  return {ok:true};
}

// ============ 宿場の位置計算 ============
function stationInfo_(cumKm) {
  let idx = 0;
  for (let i = 0; i < STATIONS.length; i++) {
    if (cumKm >= STATIONS[i].km) idx = i; else break;
  }
  const current = STATIONS[idx];
  const next = STATIONS[idx + 1] || null;
  return {
    passedCount: idx, // 日本橋出発後、品川到達で1
    currentStation: current.name,
    nextStation: next ? next.name : null,
    remainingToNextKm: next ? Math.round((next.km - cumKm) * 10) / 10 : 0,
    isComplete: idx >= STATIONS.length - 1
  };
}

// ============ 共通ヘルパー ============
function stepsToKm_(steps) { return Math.round(steps * 0.7) / 1000; } // 1歩=0.7mで換算

function validateSteps_(v) {
  const steps = Math.round(Number(v));
  if (!isFinite(steps) || steps <= 0 || steps > MAX_STEPS) return null;
  return steps;
}

function validateDate_(v) {
  const s = String(v || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  return s;
}

// シートの日付セル（Date型 or 文字列）を yyyy-MM-dd に揃える
function formatDateCell_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return String(v || '');
}

// 写真をDriveに保存して {fileId, url} を返す。失敗時は null
function savePhoto_(memberId, date, base64, mimeType) {
  try {
    const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
    const bytes = Utilities.base64Decode(String(base64).split(',').pop());
    const blob = Utilities.newBlob(bytes, mimeType || 'image/jpeg', memberId + '_' + date + '_' + Date.now() + '.jpg');
    const file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return {fileId: file.getId(), url: 'https://drive.google.com/uc?id=' + file.getId()};
  } catch (err) {
    return null;
  }
}

// 写真ファイルをゴミ箱へ移動（driveFileIdが空の旧データはURLからIDを取り出す）
function trashPhoto_(driveFileId, photoUrl) {
  let id = String(driveFileId || '');
  if (!id && photoUrl) {
    const m = String(photoUrl).match(/[?&]id=([^&]+)/);
    if (m) id = m[1];
  }
  if (!id) return;
  try { DriveApp.getFileById(id).setTrashed(true); } catch (err) { /* 見つからなくても続行 */ }
}

function normalizeVisibility_(v) { return v === 'public' ? 'public' : 'private'; }

// 写真の表示用URL（ファイルIDがあれば lh3 形式に変換）
function photoDisplayUrl_(driveFileId, photoUrl) {
  let id = String(driveFileId || '');
  if (!id && photoUrl) {
    const m = String(photoUrl).match(/[?&]id=([^&]+)/);
    if (m) id = m[1];
  }
  return id ? 'https://lh3.googleusercontent.com/d/' + id : String(photoUrl || '');
}

// 会員ID→ニックネームの対応表
function memberNameMap_() {
  const data = getMembersSheet_().getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) map[data[i][0]] = data[i][1];
  return map;
}

// 会員ID→道中記を公開しているか
function memberProgressPublicMap_() {
  const data = getMembersSheet_().getDataRange().getValues();
  const map = {};
  for (let i = 1; i < data.length; i++) map[data[i][0]] = normalizeVisibility_(data[i][9]) === 'public';
  return map;
}

// recordId→コメント配列（古い順）
function commentsByRecord_(myId, recordOwnerMap, nameMap, tz) {
  const data = getCommentsSheet_().getDataRange().getValues();
  const result = {};
  for (let i = 1; i < data.length; i++) {
    const [commentId, recordId, memberId, text, createdAt] = data[i];
    if (!commentId) continue;
    const ownerId = recordOwnerMap[recordId];
    if (ownerId === undefined) continue; // 削除済みの記録
    (result[recordId] = result[recordId] || []).push({
      commentId: String(commentId),
      nickname: nameMap[memberId] || '（退会した会員）',
      text: String(text),
      time: createdAt instanceof Date ? Utilities.formatDate(createdAt, tz, 'M/d HH:mm') : '',
      ts: createdAt instanceof Date ? createdAt.getTime() : 0,
      isMine: memberId === myId,
      canDelete: memberId === myId || ownerId === myId
    });
  }
  Object.keys(result).forEach(k => result[k].sort((a, b) => a.ts - b.ts));
  return result;
}

// 1つの記録のコメントだけ返す
function commentsForRecord_(myId, recordId, ownerId) {
  const tz = getSS_().getSpreadsheetTimeZone() || 'Asia/Tokyo';
  const ownerMap = {}; ownerMap[recordId] = ownerId;
  return commentsByRecord_(myId, ownerMap, memberNameMap_(), tz)[recordId] || [];
}

// recordIdで行を探す
function findRecord_(sh, recordId) {
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(recordId)) return {row: i + 1, values: data[i]};
  }
  return null;
}

// ============ 歩みの記録 ============
function submitRecord_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};

  const steps = validateSteps_(body.steps);
  if (!steps) return {ok:false, error:'invalid_steps'};
  const date = body.date ? validateDate_(body.date) : Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  if (!date) return {ok:false, error:'invalid_date'};
  const distanceKm = stepsToKm_(steps);

  let driveFileId = '', photoUrl = '';
  if (body.photoBase64) {
    const saved = savePhoto_(memberId, date, body.photoBase64, body.photoMimeType);
    if (saved) { driveFileId = saved.fileId; photoUrl = saved.url; }
  }

  const recSh = getRecordsSheet_();
  const recData = recSh.getDataRange().getValues();
  let priorKm = 0;
  for (let i = 1; i < recData.length; i++) {
    if (recData[i][1] === memberId) priorKm += Number(recData[i][4]) || 0;
  }
  const newCumKm = priorKm + distanceKm;
  const info = stationInfo_(newCumKm);
  const comment = generateGeminiComment_(info, distanceKm, steps);

  const visibility = normalizeVisibility_(body.visibility);
  const recordId = Utilities.getUuid();
  recSh.appendRow([recordId, memberId, date, steps, distanceKm, driveFileId, photoUrl, comment, new Date(), visibility]);

  return {
    ok: true,
    record: {recordId, date, steps, distanceKm, photoUrl: photoDisplayUrl_(driveFileId, photoUrl), comment, visibility},
    progress: Object.assign({cumulativeKm: Math.round(newCumKm * 100) / 100}, info)
  };
}

// ============ 記録の修正 ============
// body: recordId, steps, date, visibility(任意), removePhoto(任意), photoBase64/photoMimeType(任意・差し替え)
function updateRecord_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};
  if (!body.recordId) return {ok:false, error:'missing_fields'};

  const steps = validateSteps_(body.steps);
  if (!steps) return {ok:false, error:'invalid_steps'};
  const date = validateDate_(body.date);
  if (!date) return {ok:false, error:'invalid_date'};

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return {ok:false, error:'busy'};
  try {
    const sh = getRecordsSheet_();
    const found = findRecord_(sh, body.recordId);
    if (!found) return {ok:false, error:'record_not_found'};
    if (found.values[1] !== memberId) return {ok:false, error:'forbidden'};

    let driveFileId = found.values[5];
    let photoUrl = found.values[6];

    if (body.photoBase64) {
      // 新しい写真を先に保存し、成功したら古い写真をゴミ箱へ
      const saved = savePhoto_(memberId, date, body.photoBase64, body.photoMimeType);
      if (!saved) return {ok:false, error:'photo_failed'};
      trashPhoto_(driveFileId, photoUrl);
      driveFileId = saved.fileId;
      photoUrl = saved.url;
    } else if (body.removePhoto) {
      trashPhoto_(driveFileId, photoUrl);
      driveFileId = '';
      photoUrl = '';
    }

    // 列: 3=date, 4=steps, 5=distanceKm, 6=driveFileId, 7=photoUrl
    sh.getRange(found.row, 3, 1, 5).setValues([[date, steps, stepsToKm_(steps), driveFileId, photoUrl]]);
    if (body.visibility) sh.getRange(found.row, 10).setValue(normalizeVisibility_(body.visibility));
    return {ok:true};
  } finally {
    lock.releaseLock();
  }
}

// ============ 記録の削除 ============
function deleteRecord_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};
  if (!body.recordId) return {ok:false, error:'missing_fields'};

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return {ok:false, error:'busy'};
  try {
    const sh = getRecordsSheet_();
    const found = findRecord_(sh, body.recordId);
    if (!found) return {ok:false, error:'record_not_found'};
    if (found.values[1] !== memberId) return {ok:false, error:'forbidden'};

    trashPhoto_(found.values[5], found.values[6]);
    sh.deleteRow(found.row);

    // この記録へのコメントも削除（下の行から消す）
    const cSh = getCommentsSheet_();
    const cData = cSh.getDataRange().getValues();
    for (let i = cData.length - 1; i >= 1; i--) {
      if (String(cData[i][1]) === String(body.recordId)) cSh.deleteRow(i + 1);
    }
    return {ok:true};
  } finally {
    lock.releaseLock();
  }
}

function generateGeminiComment_(info, distanceKm, steps) {
  if (!GEMINI_API_KEY) return '';
  try {
    const prompt = 'あなたは江戸時代の東海道を旅する道連れです。以下の情報をもとに、歩き旅を労い次の宿場への期待を持たせる一言を' +
      '40字以内・句読点含む・絵文字なしの日本語で1つだけ作ってください。前置きや説明は不要で、一言だけを出力してください。\n' +
      '現在地: ' + info.currentStation + '\n' +
      '本日の歩数: ' + steps + '歩（約' + distanceKm + 'km）\n' +
      (info.nextStation ? ('次の宿場: ' + info.nextStation + '（あと約' + info.remainingToNextKm + 'km）') : 'まもなく京・三条大橋に到着します');

    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY;
    const res = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({contents: [{parts: [{text: prompt}]}]}),
      muteHttpExceptions: true
    });
    const json = JSON.parse(res.getContentText());
    const text = json.candidates && json.candidates[0] && json.candidates[0].content.parts[0].text;
    return text ? text.trim() : '';
  } catch (err) {
    return '';
  }
}

// ============ 状態取得（進捗・タイムライン） ============
function getState_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};

  const nameMap = memberNameMap_();
  const nickname = nameMap[memberId] || '';

  const tz = getSS_().getSpreadsheetTimeZone() || 'Asia/Tokyo';
  const recData = getRecordsSheet_().getDataRange().getValues();
  const timeline = [];
  const ownerMap = {};
  let cumKm = 0, cumSteps = 0;
  for (let i = 1; i < recData.length; i++) {
    const r = recData[i];
    ownerMap[r[0]] = r[1];
    if (r[1] === memberId) {
      cumSteps += Number(r[3]) || 0;
      cumKm += Number(r[4]) || 0;
      timeline.push({
        recordId: String(r[0]),
        date: formatDateCell_(r[2], tz),
        steps: r[3],
        distanceKm: r[4],
        photoUrl: photoDisplayUrl_(r[5], r[6]),
        comment: r[7],
        createdAt: r[8] instanceof Date ? r[8].getTime() : 0,
        visibility: normalizeVisibility_(r[9])
      });
    }
  }
  const comments = commentsByRecord_(memberId, ownerMap, nameMap, tz);
  timeline.forEach(t => { t.comments = comments[t.recordId] || []; });

  // 日付順（同日は投稿順）
  timeline.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt));
  const info = stationInfo_(cumKm);

  return {
    ok: true, nickname,
    cumulativeSteps: cumSteps,
    cumulativeKm: Math.round(cumKm * 100) / 100,
    progress: info,
    progressVisibility: memberProgressPublicMap_()[memberId] ? 'public' : 'private',
    timeline,
    stations: STATIONS
  };
}

// ============ みんなの旅（公開記録のフィード） ============
// body: offset(任意)
function getFeed_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};
  const offset = Math.max(0, Number(body.offset) || 0);

  const nameMap = memberNameMap_();
  const tz = getSS_().getSpreadsheetTimeZone() || 'Asia/Tokyo';
  const recData = getRecordsSheet_().getDataRange().getValues();

  const cumByMember = {};
  const ownerMap = {};
  const publicRecs = [];
  for (let i = 1; i < recData.length; i++) {
    const r = recData[i];
    if (!r[0]) continue;
    ownerMap[r[0]] = r[1];
    cumByMember[r[1]] = (cumByMember[r[1]] || 0) + (Number(r[4]) || 0);
    if (normalizeVisibility_(r[9]) === 'public') publicRecs.push(r);
  }

  const items = publicRecs.map(r => ({
    recordId: String(r[0]),
    ownerId: r[1],
    nickname: nameMap[r[1]] || '（退会した会員）',
    isMine: r[1] === memberId,
    date: formatDateCell_(r[2], tz),
    steps: r[3],
    distanceKm: r[4],
    photoUrl: photoDisplayUrl_(r[5], r[6]),
    comment: r[7],
    createdAt: r[8] instanceof Date ? r[8].getTime() : 0,
    visibility: 'public'
  }));
  // 新しい順
  items.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : b.createdAt - a.createdAt));

  const page = items.slice(offset, offset + FEED_PAGE_SIZE);
  const progressPublic = memberProgressPublicMap_();
  const comments = commentsByRecord_(memberId, ownerMap, nameMap, tz);
  page.forEach(it => {
    // 道中記を公開している人（と自分）だけ現在地を出す
    it.memberStation = (it.isMine || progressPublic[it.ownerId])
      ? stationInfo_(cumByMember[it.ownerId] || 0).currentStation : '';
    it.comments = comments[it.recordId] || [];
    delete it.ownerId;
  });

  return {ok:true, items: page, hasMore: offset + FEED_PAGE_SIZE < items.length, nextOffset: offset + page.length};
}

// ============ コメント ============
// body: recordId, text
function addComment_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};
  const text = String(body.text || '').trim();
  if (!text) return {ok:false, error:'comment_empty'};
  if (text.length > MAX_COMMENT_LEN) return {ok:false, error:'comment_too_long'};

  const found = findRecord_(getRecordsSheet_(), body.recordId);
  if (!found) return {ok:false, error:'record_not_found'};
  const ownerId = found.values[1];
  // 非公開の記録には本人以外コメント不可
  if (normalizeVisibility_(found.values[9]) !== 'public' && ownerId !== memberId) {
    return {ok:false, error:'forbidden'};
  }

  getCommentsSheet_().appendRow([Utilities.getUuid(), String(body.recordId), memberId, text, new Date()]);
  return {ok:true, recordId: String(body.recordId), comments: commentsForRecord_(memberId, String(body.recordId), ownerId)};
}

// body: commentId（コメントした本人 または 記録の持ち主が削除可）
function deleteComment_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};
  if (!body.commentId) return {ok:false, error:'missing_fields'};

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return {ok:false, error:'busy'};
  try {
    const cSh = getCommentsSheet_();
    const cData = cSh.getDataRange().getValues();
    let row = -1, recordId = '', authorId = '';
    for (let i = 1; i < cData.length; i++) {
      if (String(cData[i][0]) === String(body.commentId)) {
        row = i + 1; recordId = String(cData[i][1]); authorId = cData[i][2]; break;
      }
    }
    if (row < 0) return {ok:false, error:'comment_not_found'};

    const rec = findRecord_(getRecordsSheet_(), recordId);
    const ownerId = rec ? rec.values[1] : '';
    if (authorId !== memberId && ownerId !== memberId) return {ok:false, error:'forbidden'};

    cSh.deleteRow(row);
    return {ok:true, recordId, comments: commentsForRecord_(memberId, recordId, ownerId)};
  } finally {
    lock.releaseLock();
  }
}

// ============ 道中記の公開設定 ============
// body: visibility ('public' | 'private')
function setProgressVisibility_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};
  const v = normalizeVisibility_(body.visibility);
  const sh = getMembersSheet_();
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === memberId) {
      sh.getRange(i + 1, 10).setValue(v);
      return {ok:true, progressVisibility: v};
    }
  }
  return {ok:false, error:'member_not_found'};
}

// ============ 番付・レース ============
// body: period ('total' | 'month' | 'week')
function getRanking_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};
  const period = ['total','month','week'].indexOf(body.period) >= 0 ? body.period : 'total';

  const tz = getSS_().getSpreadsheetTimeZone() || 'Asia/Tokyo';
  const now = new Date();
  const today = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const dow = Number(Utilities.formatDate(now, tz, 'u')); // 1=月曜 … 7=日曜
  const weekStart = Utilities.formatDate(new Date(now.getTime() - (dow - 1) * 86400000), tz, 'yyyy-MM-dd');
  const monthStart = today.slice(0, 8) + '01';
  const from = period === 'week' ? weekStart : period === 'month' ? monthStart : '';

  // 会員情報
  const memData = getMembersSheet_().getDataRange().getValues();
  const members = {};
  for (let i = 1; i < memData.length; i++) {
    members[memData[i][0]] = {nickname: memData[i][1], isPublic: normalizeVisibility_(memData[i][9]) === 'public'};
  }

  // 記録を集計
  const recData = getRecordsSheet_().getDataRange().getValues();
  const agg = {};
  for (let i = 1; i < recData.length; i++) {
    const r = recData[i];
    if (!r[0] || !members[r[1]]) continue;
    const date = formatDateCell_(r[2], tz);
    const a = agg[r[1]] || (agg[r[1]] = {km:0, steps:0, pKm:0, pSteps:0, days:{}, lastDate:''});
    const km = Number(r[4]) || 0, steps = Number(r[3]) || 0;
    a.km += km; a.steps += steps;
    a.days[date] = true;
    if (date > a.lastDate) a.lastDate = date;
    if (!from || (date >= from && date <= today)) { a.pKm += km; a.pSteps += steps; }
  }

  const totalKm = STATIONS[STATIONS.length - 1].km;
  const rows = Object.keys(agg).map(id => {
    const a = agg[id];
    const info = stationInfo_(a.km);
    return {
      id,
      nickname: members[id].nickname,
      isPublic: members[id].isPublic,
      isMine: id === memberId,
      totalKm: Math.round(a.km * 100) / 100,
      totalSteps: a.steps,
      periodKm: Math.round(a.pKm * 100) / 100,
      periodSteps: a.pSteps,
      station: info.currentStation,
      nextStation: info.nextStation,
      passedCount: info.passedCount,
      isComplete: info.isComplete,
      pct: Math.min(100, Math.round(a.km / totalKm * 1000) / 10),
      walkDays: Object.keys(a.days).length,
      lastDate: a.lastDate
    };
  });

  const metric = r => period === 'total' ? r.totalKm : r.periodSteps;
  const sorter = (x, y) => metric(y) - metric(x) || y.totalKm - x.totalKm;

  // 公開している人だけで順位を付ける（期間ランキングは期間内に歩いた人のみ）
  let pub = rows.filter(r => r.isPublic && (period === 'total' || r.periodSteps > 0)).sort(sorter);
  let rank = 0, prev = null;
  pub.forEach((r, i) => { if (prev === null || metric(r) !== prev) { rank = i + 1; prev = metric(r); } r.rank = rank; });

  // 自分（非公開でも本人には参考順位を返す）
  let me = rows.find(r => r.isMine) || null;
  if (me) {
    if (me.isPublic && me.rank) {
      // pub 内の自分をそのまま使う
    } else {
      const better = pub.filter(r => metric(r) > metric(me)).length;
      me.rank = (period !== 'total' && me.periodSteps === 0) ? null : better + 1;
    }
    // 1つ上の人との差
    const above = pub.filter(r => !r.isMine && metric(r) > metric(me)).sort((x, y) => metric(x) - metric(y))[0];
    me.gapToAbove = above ? {nickname: above.nickname, value: Math.round((metric(above) - metric(me)) * 100) / 100} : null;
  }

  // 全体の合計（公開者のみ）
  const groupKm = rows.filter(r => r.isPublic).reduce((s, r) => s + r.totalKm, 0);
  const groupPeriodSteps = pub.reduce((s, r) => s + r.periodSteps, 0);

  const strip = r => { const o = Object.assign({}, r); delete o.id; return o; };
  return {
    ok: true,
    period,
    periodFrom: from,
    today,
    entries: pub.slice(0, 50).map(strip),
    participants: pub.length,
    me: me ? strip(me) : null,
    groupKm: Math.round(groupKm * 10) / 10,
    groupLaps: Math.round(groupKm / totalKm * 10) / 10,
    groupReach: groupKm < totalKm ? stationInfo_(groupKm).currentStation : '',
    groupPeriodSteps,
    routeKm: totalKm,
    landmarks: [
      {name:'箱根', km:98.0}, {name:'浜松', km:254.0}, {name:'宮', km:349.3}, {name:'京', km:totalKm}
    ]
  };
}
