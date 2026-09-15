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
 */

const SS_ID = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
const DRIVE_FOLDER_ID = PropertiesService.getScriptProperties().getProperty('DRIVE_FOLDER_ID');
const GEMINI_API_KEY = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
const PEPPER = PropertiesService.getScriptProperties().getProperty('PEPPER');

const SESSION_TTL_SEC = 60 * 60 * 24; // セッション有効期限 24時間
const MAX_FAILED = 5;                 // ログイン失敗許容回数
const LOCK_MINUTES = 15;              // ロック時間(分)

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
    sh.appendRow(['memberId','nickname','email','passwordHash','salt','mustChangePassword','failedAttempts','lockUntil','createdAt']);
  }
  return sh;
}
function getRecordsSheet_() {
  const ss = getSS_();
  let sh = ss.getSheetByName('records');
  if (!sh) {
    sh = ss.insertSheet('records');
    sh.appendRow(['recordId','memberId','date','steps','distanceKm','driveFileId','photoUrl','comment','createdAt']);
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
      case 'logout':                return respond_(logout_(body));
      case 'submitRecord':         return respond_(submitRecord_(body));
      case 'getState':             return respond_(getState_(body));
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

// ============ 歩みの記録 ============
function submitRecord_(body) {
  const memberId = requireSession_(body.sessionToken);
  if (!memberId) return {ok:false, error:'session_expired'};

  const steps = Number(body.steps);
  if (!steps || steps <= 0) return {ok:false, error:'invalid_steps'};
  const date = body.date || Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const distanceKm = Math.round(steps * 0.7) / 1000; // 1歩=0.7mで換算

  let photoUrl = '';
  if (body.photoBase64) {
    try {
      const folder = DriveApp.getFolderById(DRIVE_FOLDER_ID);
      const bytes = Utilities.base64Decode(body.photoBase64.split(',').pop());
      const blob = Utilities.newBlob(bytes, body.photoMimeType || 'image/jpeg', memberId + '_' + date + '.jpg');
      const file = folder.createFile(blob);
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      photoUrl = 'https://drive.google.com/uc?id=' + file.getId();
    } catch (err) {
      // 写真保存に失敗しても記録自体は継続する
    }
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

  recSh.appendRow([Utilities.getUuid(), memberId, date, steps, distanceKm, '', photoUrl, comment, new Date()]);

  return {
    ok: true,
    record: {date, steps, distanceKm, photoUrl, comment},
    progress: Object.assign({cumulativeKm: Math.round(newCumKm * 100) / 100}, info)
  };
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

  const memSh = getMembersSheet_();
  const memData = memSh.getDataRange().getValues();
  let nickname = '';
  for (let i = 1; i < memData.length; i++) {
    if (memData[i][0] === memberId) { nickname = memData[i][1]; break; }
  }

  const recSh = getRecordsSheet_();
  const recData = recSh.getDataRange().getValues();
  const timeline = [];
  let cumKm = 0, cumSteps = 0;
  for (let i = 1; i < recData.length; i++) {
    if (recData[i][1] === memberId) {
      cumSteps += Number(recData[i][3]) || 0;
      cumKm += Number(recData[i][4]) || 0;
      timeline.push({date: recData[i][2], steps: recData[i][3], distanceKm: recData[i][4], photoUrl: recData[i][6], comment: recData[i][7]});
    }
  }
  timeline.sort((a, b) => new Date(a.date) - new Date(b.date));
  const info = stationInfo_(cumKm);

  return {
    ok: true, nickname,
    cumulativeSteps: cumSteps,
    cumulativeKm: Math.round(cumKm * 100) / 100,
    progress: info,
    timeline,
    stations: STATIONS
  };
}
