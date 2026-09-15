// app.js は auth.js の後に読み込まれる前提（API_URL, callApi, getSession等を利用）

let selectedPhotoBase64 = null;
let selectedPhotoMimeType = null;

// ============ 状態取得・描画 ============
async function loadState() {
  const session = getSession();
  if (!session) { showAuthScreen(); return; }

  const res = await callApi({action:'getState', sessionToken: session.sessionToken});
  if (!res.ok) {
    if (res.error === 'session_expired') {
      clearSession();
      showAuthScreen();
    }
    return;
  }
  renderProgress(res);
  renderTimeline(res.timeline);
}

function renderProgress(state) {
  document.getElementById('currentStation').textContent = state.progress.currentStation;
  document.getElementById('nextStation').textContent = state.progress.nextStation || '京・三条大橋';
  document.getElementById('remainingKm').textContent = state.progress.isComplete ? '0' : state.progress.remainingToNextKm;
  document.getElementById('cumSteps').textContent = state.cumulativeSteps.toLocaleString();
  document.getElementById('cumKm').textContent = state.cumulativeKm.toFixed(1);
  document.getElementById('passedCount').textContent = state.progress.passedCount;

  const totalKm = state.stations[state.stations.length - 1].km;
  const pct = Math.min(100, Math.round((state.cumulativeKm / totalKm) * 1000) / 10);
  document.getElementById('progressBarFill').style.width = pct + '%';

  document.getElementById('completeMessage').hidden = !state.progress.isComplete;
  document.getElementById('submitRecordBtn').disabled = !!state.progress.isComplete;
}

function renderTimeline(timeline) {
  const list = document.getElementById('timelineList');
  const empty = document.getElementById('timelineEmpty');
  list.innerHTML = '';
  if (!timeline || timeline.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  // 新しい記録を上に表示
  [...timeline].reverse().forEach(rec => {
    const item = document.createElement('div');
    item.className = 'timeline-item';
    item.innerHTML =
      '<div class="t-date">' + escapeHtml(rec.date) + '</div>' +
      '<div class="t-meta">' + Number(rec.steps).toLocaleString() + ' 歩（約 ' + Number(rec.distanceKm).toFixed(2) + ' km）</div>' +
      (rec.photoUrl ? '<img src="' + escapeHtml(rec.photoUrl) + '" alt="道中の一枚" loading="lazy">' : '') +
      (rec.comment ? '<p class="t-comment">' + escapeHtml(rec.comment) + '</p>' : '');
    list.appendChild(item);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ============ 写真選択 ============
document.getElementById('photoInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  selectedPhotoMimeType = file.type;
  const reader = new FileReader();
  reader.onload = () => {
    selectedPhotoBase64 = reader.result;
    const preview = document.getElementById('photoPreview');
    preview.src = selectedPhotoBase64;
    preview.hidden = false;
    document.getElementById('removePhotoBtn').hidden = false;
  };
  reader.readAsDataURL(file);
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

  btn.disabled = true;
  msg.textContent = '投稿中…（写真がある場合は少し時間がかかります）';

  const res = await callApi({
    action: 'submitRecord',
    sessionToken: session.sessionToken,
    steps: Number(steps),
    date: date || undefined,
    photoBase64: selectedPhotoBase64 || undefined,
    photoMimeType: selectedPhotoMimeType || undefined
  });

  btn.disabled = false;

  if (!res.ok) {
    if (res.error === 'session_expired') {
      clearSession();
      showAuthScreen();
      return;
    }
    msg.textContent = errorMessage(res.error);
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
  if (session && session.sessionToken && !document.getElementById('appMain').hidden) {
    loadState();
  } else if (session && session.sessionToken) {
    // auth.js側で mustChangePassword 判定済みでなければアプリ画面表示後に呼ばれる
    loadState();
  }
})();
