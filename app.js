// app.js は auth.js の後に読み込まれる前提（API_URL, callApi, getSession等を利用）

let selectedPhotoBase64 = null;
let selectedPhotoMimeType = null;
let currentTimeline = [];
let feedItems = [];
let feedNextOffset = 0;
let photoProcessing = false;

// 追加機能用のエラーメッセージ
Object.assign(ERROR_MESSAGES, {
  invalid_steps: '歩数は1〜200,000の範囲で入力してください。',
  invalid_date: '日付の形式が正しくありません。',
  record_not_found: '記録が見つかりません。画面を更新してください。',
  forbidden: 'この操作はできません。',
  photo_failed: '写真の保存に失敗しました。時間をおいて再度お試しください。',
  busy: '混み合っています。少し待ってから再度お試しください。',
  comment_empty: 'コメントを入力してください。',
  comment_too_long: 'コメントは200文字以内で入力してください。',
  comment_not_found: 'コメントが見つかりません。画面を更新してください。',
  photo_too_large: '写真のサイズが大きすぎます。別の写真でお試しください。'
});

// ============ 写真の縮小（アップロード前にブラウザで実行） ============
const PHOTO_MAX_EDGE = 1280;          // 長辺の最大ピクセル
const PHOTO_TARGET_BYTES = 600 * 1024; // これを超えたら画質を下げて再圧縮
const PHOTO_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.5];

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image_load_failed')); };
    img.src = url;
  });
}

function dataUrlBytes(dataUrl) {
  const b64 = String(dataUrl).split(',').pop();
  return Math.floor(b64.length * 0.75);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function formatBytes(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + 'MB' : Math.round(n / 1024) + 'KB';
}

// 長辺1280pxのJPEGに縮小して {base64, mime, bytes, originalBytes} を返す
// （スマホ写真の向きは最近のブラウザが自動で補正して描画します）
async function resizeImageFile(file) {
  let img;
  try {
    img = await loadImageFromFile(file);
  } catch (err) {
    // ブラウザが読めない形式は、そのまま送る（サーバー側で3MB上限チェック）
    const raw = await readFileAsDataUrl(file);
    return {base64: raw, mime: file.type || 'image/jpeg', bytes: dataUrlBytes(raw), originalBytes: file.size, resized: false};
  }

  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';            // 透過PNGの背景を白に
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  let dataUrl = '';
  for (const q of PHOTO_QUALITY_STEPS) {
    dataUrl = canvas.toDataURL('image/jpeg', q);
    if (dataUrlBytes(dataUrl) <= PHOTO_TARGET_BYTES) break;
  }
  return {base64: dataUrl, mime: 'image/jpeg', bytes: dataUrlBytes(dataUrl), originalBytes: file.size, resized: true};
}

function photoSizeNote(r) {
  return r.resized
    ? '写真を ' + formatBytes(r.originalBytes) + ' → ' + formatBytes(r.bytes) + ' に縮小しました。'
    : '';
}

// ============ 写真の拡大表示（ライトボックス） ============
function openLightbox(src, caption) {
  let box = document.getElementById('lightbox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'lightbox';
    box.className = 'lightbox';
    box.innerHTML =
      '<button type="button" class="lightbox-close" aria-label="閉じる">×</button>' +
      '<img class="lightbox-img" alt="">' +
      '<p class="lightbox-caption"></p>';
    box.addEventListener('click', (e) => {
      if (e.target === box || e.target.classList.contains('lightbox-close')) closeLightbox();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
    document.body.appendChild(box);
  }
  box.querySelector('.lightbox-img').src = src;
  box.querySelector('.lightbox-caption').textContent = caption || '';
  box.classList.add('open');
  document.body.classList.add('no-scroll');
}

function closeLightbox() {
  const box = document.getElementById('lightbox');
  if (!box) return;
  box.classList.remove('open');
  box.querySelector('.lightbox-img').src = '';
  document.body.classList.remove('no-scroll');
}

// data-full を持つ画像（またはボタン）をタップしたら拡大
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-full]');
  if (!el) return;
  e.preventDefault();
  openLightbox(el.dataset.full, el.dataset.caption || '');
});

// ============ 共通 ============
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function formatDateJa(ymd) {
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(ymd);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const w = '日月火水木金土'.charAt(d.getDay());
  return m[1] + '年' + Number(m[2]) + '月' + Number(m[3]) + '日（' + w + '）';
}

function handleSessionError(res) {
  if (res && res.error === 'session_expired') {
    clearSession();
    showAuthScreen();
    return true;
  }
  return false;
}

// ============ 状態取得・描画 ============
async function loadState() {
  const session = getSession();
  if (!session) { showAuthScreen(); return; }

  const res = await callApi({action:'getState', sessionToken: session.sessionToken});
  if (!res.ok) { handleSessionError(res); return; }
  renderProgress(res);
  renderTimeline(res.timeline);
  loadFeed(true);
}

function renderProgress(state) {
  const p = state.progress;
  document.getElementById('currentStation').textContent = p.currentStation;
  document.getElementById('currentSuffix').textContent =
    p.isComplete ? '御到着' : (p.passedCount === 0 ? '出発地' : '通過');
  document.getElementById('nextStation').textContent = p.nextStation || '京・三条大橋';
  document.getElementById('remainingKm').textContent = p.isComplete ? '0' : p.remainingToNextKm;
  document.getElementById('cumSteps').textContent = state.cumulativeSteps.toLocaleString();
  document.getElementById('cumKm').textContent = state.cumulativeKm.toFixed(1);
  document.getElementById('passedCount').textContent = p.passedCount;

  const totalKm = state.stations[state.stations.length - 1].km;
  const pct = Math.min(100, Math.round((state.cumulativeKm / totalKm) * 1000) / 10);
  document.getElementById('progressBarFill').style.width = pct + '%';
  document.getElementById('progressPct').textContent = pct + '%';

  document.getElementById('completeMessage').hidden = !p.isComplete;
  document.getElementById('submitRecordBtn').disabled = !!p.isComplete;

  renderProgressVisibility(state.progressVisibility);
}

// ============ 道中記の公開設定 ============
function renderProgressVisibility(v) {
  const isPublic = v === 'public';
  document.getElementById('progressPublicToggle').checked = isPublic;
  document.getElementById('progressPublicLabel').textContent =
    isPublic ? '道中記を番付に公開中' : '道中記は非公開（番付に載りません）';
}

async function setProgressVisibility(isPublic) {
  const session = getSession();
  if (!session) { showAuthScreen(); return null; }
  const res = await callApi({
    action: 'setProgressVisibility',
    sessionToken: session.sessionToken,
    visibility: isPublic ? 'public' : 'private'
  });
  if (!res.ok) { handleSessionError(res); return res; }
  renderProgressVisibility(res.progressVisibility);
  return res;
}

document.getElementById('progressPublicToggle').addEventListener('change', async (e) => {
  const toggle = e.target;
  const msg = document.getElementById('progressPublicMessage');
  toggle.disabled = true;
  msg.textContent = '設定を保存中…';
  const res = await setProgressVisibility(toggle.checked);
  toggle.disabled = false;
  if (!res || !res.ok) {
    toggle.checked = !toggle.checked;
    msg.textContent = res ? errorMessage(res.error) : '';
    return;
  }
  msg.textContent = toggle.checked ? '番付に参加しました。「番付・レース」で順位を見てみましょう。' : '道中記を非公開にしました。';
});

// ============ コメント欄 ============
function commentListHtml(comments) {
  if (!comments || comments.length === 0) {
    return '<li class="c-empty">まだコメントはありません。</li>';
  }
  return comments.map(c =>
    '<li class="c-item' + (c.isMine ? ' c-mine' : '') + '">' +
      '<div class="c-meta"><span class="c-name">' + escapeHtml(c.nickname) + '</span>' +
      '<span class="c-time">' + escapeHtml(c.time) + '</span>' +
      (c.canDelete ? '<button type="button" class="c-del" data-action="comment-delete" data-comment-id="' + escapeHtml(c.commentId) + '">削除</button>' : '') +
      '</div>' +
      '<p class="c-text">' + escapeHtml(c.text) + '</p>' +
    '</li>'
  ).join('');
}

function commentBlockHtml(rec) {
  const comments = rec.comments || [];
  const isPublic = rec.visibility === 'public';
  if (!isPublic && comments.length === 0) {
    return '<p class="c-private-note">非公開の記録のため、コメントは受け付けていません。</p>';
  }
  return '<div class="c-block" data-record-id="' + escapeHtml(rec.recordId) + '">' +
    '<p class="c-head">励ましの声 <span class="c-count">' + comments.length + '</span></p>' +
    '<ul class="c-list">' + commentListHtml(comments) + '</ul>' +
    (isPublic
      ? '<div class="c-form">' +
          '<textarea class="c-input" maxlength="200" rows="2" placeholder="ひとこと応援（200文字まで）"></textarea>' +
          '<button type="button" class="c-send" data-action="comment-send">送る</button>' +
        '</div>'
      : '<p class="c-private-note">非公開の記録のため、新しいコメントは受け付けていません。</p>') +
    '<p class="form-message c-msg"></p>' +
  '</div>';
}

// 同じ記録のコメント欄（自分の絵巻／みんなの旅の両方）をまとめて更新
function updateCommentBlocks(recordId, comments) {
  [currentTimeline, feedItems].forEach(arr => {
    const r = arr.find(x => x.recordId === recordId);
    if (r) r.comments = comments;
  });
  document.querySelectorAll('.c-block').forEach(block => {
    if (block.dataset.recordId !== recordId) return;
    block.querySelector('.c-list').innerHTML = commentListHtml(comments);
    block.querySelector('.c-count').textContent = comments.length;
  });
}

// コメント関連ボタンの処理。処理したら true を返す
async function handleCommentAction(btn) {
  const action = btn.dataset.action;
  if (action !== 'comment-send' && action !== 'comment-delete') return false;

  const block = btn.closest('.c-block');
  const msg = block.querySelector('.c-msg');
  const session = getSession();
  if (!session) { showAuthScreen(); return true; }

  if (action === 'comment-send') {
    const input = block.querySelector('.c-input');
    const text = input.value.trim();
    if (!text) { msg.textContent = 'コメントを入力してください。'; return true; }
    btn.disabled = true;
    msg.textContent = '送信中…';
    const res = await callApi({action:'addComment', sessionToken: session.sessionToken, recordId: block.dataset.recordId, text});
    btn.disabled = false;
    if (!res.ok) { if (!handleSessionError(res)) msg.textContent = errorMessage(res.error); return true; }
    input.value = '';
    msg.textContent = '';
    updateCommentBlocks(res.recordId, res.comments);
    return true;
  }

  // comment-delete
  if (!window.confirm('このコメントを削除しますか？')) return true;
  btn.disabled = true;
  msg.textContent = '削除中…';
  const res = await callApi({action:'deleteComment', sessionToken: session.sessionToken, commentId: btn.dataset.commentId});
  if (!res.ok) {
    btn.disabled = false;
    if (!handleSessionError(res)) msg.textContent = errorMessage(res.error);
    return true;
  }
  msg.textContent = '';
  updateCommentBlocks(res.recordId, res.comments);
  return true;
}

// ============ 自分のタイムライン ============
function renderTimeline(timeline) {
  currentTimeline = timeline || [];
  const list = document.getElementById('timelineList');
  const empty = document.getElementById('timelineEmpty');
  list.innerHTML = '';
  if (currentTimeline.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  // 新しい記録を上に表示
  [...currentTimeline].reverse().forEach(rec => {
    const item = document.createElement('div');
    item.className = 'timeline-item';
    item.dataset.recordId = rec.recordId;
    renderViewItem(item, rec);
    list.appendChild(item);
  });
}

function findRecord(recordId) {
  return currentTimeline.find(r => r.recordId === recordId);
}

function visibilityBadge(v) {
  return v === 'public'
    ? '<span class="vis-badge vis-public">公開</span>'
    : '<span class="vis-badge vis-private">非公開</span>';
}

// ---------- 表示モード ----------
function renderViewItem(item, rec) {
  item.classList.remove('editing');
  item.innerHTML =
    '<div class="t-head">' +
      '<div class="t-date">' + escapeHtml(formatDateJa(rec.date)) + ' ' + visibilityBadge(rec.visibility) + '</div>' +
      '<div class="t-actions">' +
        '<button type="button" class="t-btn" data-action="edit">修正</button>' +
        '<button type="button" class="t-btn t-btn-danger" data-action="delete">削除</button>' +
      '</div>' +
    '</div>' +
    '<div class="t-meta">' + Number(rec.steps).toLocaleString() + ' 歩（約 ' + Number(rec.distanceKm).toFixed(2) + ' km）</div>' +
    (rec.photoUrl ? '<img class="zoomable" src="' + escapeHtml(rec.photoUrl) + '" data-full="' + escapeHtml(rec.photoUrl) + '" data-caption="' + escapeHtml(formatDateJa(rec.date)) + '" alt="道中の一枚" loading="lazy">' : '') +
    (rec.comment ? '<p class="t-comment">' + escapeHtml(rec.comment) + '</p>' : '') +
    '<p class="form-message t-msg"></p>' +
    commentBlockHtml(rec);
}

// ---------- 編集モード ----------
function renderEditItem(item, rec) {
  item.classList.add('editing');
  item.innerHTML =
    '<div class="t-edit">' +
      '<p class="t-edit-title">記録を修正</p>' +
      '<label>日付<input type="date" class="e-date" required></label>' +
      '<label>歩数<input type="number" class="e-steps" min="1" max="200000" required></label>' +
      '<label>公開設定<select class="e-visibility">' +
        '<option value="public">公開（みんなの旅に表示・コメント可）</option>' +
        '<option value="private">非公開（自分だけ）</option>' +
      '</select></label>' +
      (rec.photoUrl
        ? '<div class="e-current-photo"><img src="' + escapeHtml(rec.photoUrl) + '" alt="現在の写真">' +
          '<label class="e-check"><input type="checkbox" class="e-remove-photo"> この写真を削除する</label></div>'
        : '') +
      '<label>' + (rec.photoUrl ? '写真を差し替える（任意）' : '写真を追加する（任意）') +
        '<input type="file" class="e-photo" accept="image/*"></label>' +
      '<img class="photo-preview e-preview" hidden alt="差し替え写真のプレビュー">' +
      '<div class="t-edit-actions">' +
        '<button type="button" class="primary-btn" data-action="save">保存する</button>' +
        '<button type="button" class="sub-btn" data-action="cancel">キャンセル</button>' +
      '</div>' +
      '<p class="form-message t-msg"></p>' +
    '</div>';

  item.querySelector('.e-date').value = rec.date;
  item.querySelector('.e-steps').value = rec.steps;
  item.querySelector('.e-visibility').value = rec.visibility === 'public' ? 'public' : 'private';
  item._editPhoto = {base64: null, mime: null};

  item.querySelector('.e-photo').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    const preview = item.querySelector('.e-preview');
    const msg = item.querySelector('.t-msg');
    const saveBtn = item.querySelector('button[data-action="save"]');
    if (!file) {
      item._editPhoto = {base64: null, mime: null};
      preview.hidden = true;
      return;
    }
    saveBtn.disabled = true;
    msg.textContent = '写真を縮小しています…';
    try {
      const r = await resizeImageFile(file);
      item._editPhoto = {base64: r.base64, mime: r.mime};
      preview.src = r.base64;
      preview.hidden = false;
      msg.textContent = photoSizeNote(r);
    } catch (err) {
      item._editPhoto = {base64: null, mime: null};
      msg.textContent = '写真を読み込めませんでした。別の写真でお試しください。';
    }
    saveBtn.disabled = false;
  });
}

// ---------- タイムラインのボタン操作（イベント委譲） ----------
document.getElementById('timelineList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (await handleCommentAction(btn)) return;

  const item = btn.closest('.timeline-item');
  const rec = findRecord(item.dataset.recordId);
  if (!rec) return;
  const action = btn.dataset.action;

  if (action === 'edit') {
    document.querySelectorAll('#timelineList .timeline-item.editing').forEach(other => {
      const r = findRecord(other.dataset.recordId);
      if (r) renderViewItem(other, r);
    });
    renderEditItem(item, rec);
    return;
  }
  if (action === 'cancel') { renderViewItem(item, rec); return; }
  if (action === 'save')   { await saveEdit(item, rec, btn); return; }
  if (action === 'delete') { await deleteRecord(item, rec, btn); }
});

async function saveEdit(item, rec, btn) {
  const session = getSession();
  if (!session) { showAuthScreen(); return; }

  const msg = item.querySelector('.t-msg');
  const date = item.querySelector('.e-date').value;
  const steps = Number(item.querySelector('.e-steps').value);
  const visibility = item.querySelector('.e-visibility').value;
  const removeEl = item.querySelector('.e-remove-photo');
  const removePhoto = !!(removeEl && removeEl.checked);
  const photo = item._editPhoto || {};

  if (!date) { msg.textContent = '日付を入力してください。'; return; }
  if (!steps || steps <= 0) { msg.textContent = '歩数を正しく入力してください。'; return; }

  btn.disabled = true;
  msg.textContent = '保存中…' + (photo.base64 ? '（写真があるため少し時間がかかります）' : '');

  const res = await callApi({
    action: 'updateRecord',
    sessionToken: session.sessionToken,
    recordId: rec.recordId,
    date, steps, visibility, removePhoto,
    photoBase64: photo.base64 || undefined,
    photoMimeType: photo.mime || undefined
  });

  if (!res.ok) {
    btn.disabled = false;
    if (!handleSessionError(res)) msg.textContent = errorMessage(res.error);
    return;
  }
  await loadState();
}

async function deleteRecord(item, rec, btn) {
  const ok = window.confirm(
    formatDateJa(rec.date) + '（' + Number(rec.steps).toLocaleString() + ' 歩）の記録を削除しますか？\n' +
    '累計歩数・現在地も再計算され、この記録へのコメントも消えます。この操作は取り消せません。'
  );
  if (!ok) return;

  const session = getSession();
  if (!session) { showAuthScreen(); return; }

  const msg = item.querySelector('.t-msg');
  btn.disabled = true;
  if (msg) msg.textContent = '削除中…';

  const res = await callApi({action:'deleteRecord', sessionToken: session.sessionToken, recordId: rec.recordId});
  if (!res.ok) {
    btn.disabled = false;
    if (!handleSessionError(res) && msg) msg.textContent = errorMessage(res.error);
    return;
  }
  await loadState();
}

// ============ みんなの旅 ============
async function loadFeed(reset) {
  const session = getSession();
  if (!session) return;
  const list = document.getElementById('feedList');
  const moreBtn = document.getElementById('feedMoreBtn');

  if (reset) {
    feedItems = [];
    feedNextOffset = 0;
    if (!list.children.length) list.innerHTML = '<p class="form-note">読み込み中…</p>';
  }
  moreBtn.disabled = true;

  const res = await callApi({action:'getFeed', sessionToken: session.sessionToken, offset: feedNextOffset});
  moreBtn.disabled = false;
  if (!res.ok) { handleSessionError(res); return; }

  if (reset) list.innerHTML = '';
  feedItems = feedItems.concat(res.items);
  feedNextOffset = res.nextOffset;
  res.items.forEach(it => list.appendChild(buildFeedItem(it)));

  document.getElementById('feedEmpty').hidden = feedItems.length > 0;
  moreBtn.hidden = !res.hasMore;
}

function buildFeedItem(it) {
  const item = document.createElement('div');
  item.className = 'timeline-item feed-item' + (it.isMine ? ' feed-mine' : '');
  item.dataset.recordId = it.recordId;
  item.innerHTML =
    '<div class="f-head">' +
      '<span class="f-name">' + escapeHtml(it.nickname) + ' さん</span>' +
      (it.isMine ? '<span class="vis-badge vis-mine">あなた</span>' : '') +
      '<span class="f-station">' + escapeHtml(it.memberStation) + ' 付近</span>' +
    '</div>' +
    '<div class="t-date">' + escapeHtml(formatDateJa(it.date)) + '</div>' +
    '<div class="t-meta">' + Number(it.steps).toLocaleString() + ' 歩（約 ' + Number(it.distanceKm).toFixed(2) + ' km）</div>' +
    (it.photoUrl ? '<img class="zoomable" src="' + escapeHtml(it.photoUrl) + '" data-full="' + escapeHtml(it.photoUrl) + '" data-caption="' + escapeHtml(it.nickname + ' さん・' + formatDateJa(it.date)) + '" alt="道中の一枚" loading="lazy">' : '') +
    (it.comment ? '<p class="t-comment">' + escapeHtml(it.comment) + '</p>' : '') +
    commentBlockHtml(it);
  return item;
}

document.getElementById('feedList').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  await handleCommentAction(btn);
});

document.getElementById('feedMoreBtn').addEventListener('click', () => loadFeed(false));

// ============ 写真選択 ============
document.getElementById('photoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = document.getElementById('recordMessage');
  const btn = document.getElementById('submitRecordBtn');
  photoProcessing = true;
  btn.disabled = true;
  msg.textContent = '写真を縮小しています…';
  try {
    const r = await resizeImageFile(file);
    selectedPhotoBase64 = r.base64;
    selectedPhotoMimeType = r.mime;
    const preview = document.getElementById('photoPreview');
    preview.src = selectedPhotoBase64;
    preview.hidden = false;
    document.getElementById('removePhotoBtn').hidden = false;
    msg.textContent = photoSizeNote(r);
  } catch (err) {
    selectedPhotoBase64 = null;
    selectedPhotoMimeType = null;
    msg.textContent = '写真を読み込めませんでした。別の写真でお試しください。';
  }
  photoProcessing = false;
  btn.disabled = document.getElementById('completeMessage').hidden === false;
});

document.getElementById('removePhotoBtn').addEventListener('click', () => {
  selectedPhotoBase64 = null;
  selectedPhotoMimeType = null;
  document.getElementById('photoInput').value = '';
  document.getElementById('photoPreview').hidden = true;
  document.getElementById('removePhotoBtn').hidden = true;
});

// ============ 記録投稿 ============
document.getElementById('recordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const session = getSession();
  if (!session) { showAuthScreen(); return; }

  const msg = document.getElementById('recordMessage');
  const btn = document.getElementById('submitRecordBtn');
  const steps = document.getElementById('stepsInput').value;
  const date = document.getElementById('dateInput').value;
  const visEl = document.querySelector('input[name="visibility"]:checked');
  const visibility = visEl ? visEl.value : 'public';
  if (photoProcessing) { msg.textContent = '写真の縮小が終わるまでお待ちください。'; return; }

  btn.disabled = true;
  msg.textContent = '投稿中…（写真がある場合は少し時間がかかります）';

  const res = await callApi({
    action: 'submitRecord',
    sessionToken: session.sessionToken,
    steps: Number(steps),
    date: date || undefined,
    visibility,
    photoBase64: selectedPhotoBase64 || undefined,
    photoMimeType: selectedPhotoMimeType || undefined
  });

  btn.disabled = false;

  if (!res.ok) {
    if (!handleSessionError(res)) msg.textContent = errorMessage(res.error);
    return;
  }

  msg.textContent = '記録しました。' + (res.record.comment ? res.record.comment : '');
  document.getElementById('recordForm').reset();
  document.getElementById('photoPreview').hidden = true;
  document.getElementById('removePhotoBtn').hidden = true;
  selectedPhotoBase64 = null;
  selectedPhotoMimeType = null;

  await loadState();
});

// ============ 初期表示 ============
(function initApp() {
  const session = getSession();
  if (session && session.sessionToken) {
    loadState();
  }
})();
