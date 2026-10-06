// ranking.js … 「番付・レース」ページ（app.js の後に読み込む）

let rankingPeriod = 'total';

const AVATARS = ['🐢','🐇','🦊','🐻','🐱','🐶','🐸','🐼','🐵','🦉','🐧','🦝','🐿️','🦔','🐴','🐮'];
const KANJI_NUM = ['〇','一','二','三','四','五','六','七','八','九'];

// ============ 共通ヘルパー ============
function avatarFor(name) {
  let h = 0;
  const s = String(name);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return AVATARS[h % AVATARS.length];
}

function toKanji(n) {
  if (n < 10) return KANJI_NUM[n];
  if (n < 100) {
    const t = Math.floor(n / 10), o = n % 10;
    return (t === 1 ? '' : KANJI_NUM[t]) + '十' + (o ? KANJI_NUM[o] : '');
  }
  return String(n);
}

// 番付の地位（総合）
function banzukeRank(rank) {
  if (!rank) return '―';
  if (rank === 1) return '横綱';
  if (rank === 2) return '大関';
  if (rank === 3) return '関脇';
  if (rank === 4) return '小結';
  return '前頭' + toKanji(rank - 4) + '枚目';
}

// 期間ランキングの表示
function periodRank(rank) {
  if (!rank) return '―';
  return ['🥇', '🥈', '🥉'][rank - 1] || rank + '位';
}

// 通過宿場数による称号
function travelerTitle(e) {
  if (e.isComplete) return '満願成就の大旅人';
  const n = e.passedCount;
  if (n === 0) return '旅支度中';
  if (n < 10) return '駆け出しの旅人';
  if (n < 20) return '箱根越えの健脚';
  if (n < 30) return '東海道の中堅';
  if (n < 42) return '熟練の旅人';
  return '京を目指す達人';
}

function rankValue(e, period) {
  return period === 'total'
    ? {num: Number(e.totalKm).toFixed(1), unit: 'km'}
    : {num: Number(e.periodSteps).toLocaleString(), unit: '歩'};
}

function formatMD(ymd) {
  const m = String(ymd).match(/^\d{4}-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(ymd + 'T00:00:00');
  return Number(m[1]) + '/' + Number(m[2]) + '（' + '日月火水木金土'.charAt(d.getDay()) + '）';
}

// 写真のキャプション
function photoCaption(e, ph) {
  return e.nickname + ' さん・' + formatDateJa(ph.date) + '・' + Number(ph.steps).toLocaleString() + ' 歩';
}

// 番付表の写真ギャラリー（公開記録の写真のみサーバーから届く）
function photoStripHtml(e) {
  const photos = e.photos || [];
  if (photos.length === 0) return '';
  return '<div class="bz-photos">' + photos.map(ph =>
    '<button type="button" class="bz-photo" data-full="' + escapeHtml(ph.full) + '" data-caption="' + escapeHtml(photoCaption(e, ph)) + '">' +
      '<img src="' + escapeHtml(ph.thumb) + '" alt="' + escapeHtml(e.nickname) + 'さんの道中の一枚" loading="lazy">' +
    '</button>'
  ).join('') + '</div>';
}

// ============ ページ切り替え ============
function showPage(name) {
  const isRanking = name === 'ranking';
  document.getElementById('pageMine').hidden = isRanking;
  document.getElementById('pageRanking').hidden = !isRanking;
  document.querySelectorAll('.page-tab').forEach(t => t.classList.toggle('active', t.dataset.page === name));
  history.replaceState(null, '', isRanking ? '#ranking' : location.pathname + location.search);
  window.scrollTo({top: 0, behavior: 'smooth'});
  if (isRanking) loadRankingPage();
}

document.querySelectorAll('.page-tab').forEach(tab => {
  tab.addEventListener('click', () => showPage(tab.dataset.page));
});

document.querySelectorAll('.period-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    rankingPeriod = tab.dataset.period;
    document.querySelectorAll('.period-tab').forEach(t => t.classList.toggle('active', t === tab));
    loadBanzuke();
  });
});

// ============ データ取得 ============
async function fetchRanking(period) {
  const session = getSession();
  if (!session) { showAuthScreen(); return null; }
  const res = await callApi({action: 'getRanking', sessionToken: session.sessionToken, period});
  if (!res.ok) {
    if (!handleSessionError(res)) {
      document.getElementById('rankingMessage').textContent = errorMessage(res.error);
    }
    return null;
  }
  return res;
}

async function loadRankingPage() {
  document.getElementById('rankingMessage').textContent = '';
  document.getElementById('raceLanes').innerHTML = '<p class="form-note">番付を読み込み中…</p>';
  const total = await fetchRanking('total');
  if (!total) return;
  renderGroupBanner(total);
  renderRace(total);
  await loadBanzuke(total);
}

async function loadBanzuke(totalData) {
  const list = document.getElementById('banzukeList');
  list.classList.add('loading');
  const data = (rankingPeriod === 'total' && totalData) ? totalData : await fetchRanking(rankingPeriod);
  list.classList.remove('loading');
  if (!data) return;
  renderMyCard(data);
  renderBanzuke(data);
}

// ============ みんなの合計 ============
function renderGroupBanner(data) {
  document.getElementById('groupKm').textContent = Number(data.groupKm).toLocaleString();
  document.getElementById('groupNote').textContent = data.groupReach
    ? '全員分をつなぐと「' + data.groupReach + '」まで到達！（参加 ' + data.participants + ' 名）'
    : '日本橋〜京 ' + data.groupLaps + ' 回分！（参加 ' + data.participants + ' 名）';
}

// ============ 自分のカード ============
function renderMyCard(data) {
  const card = document.getElementById('myRankCard');
  const me = data.me;
  card.hidden = false;
  const nickname = (getSession() || {}).nickname || '';
  document.getElementById('myAvatar').textContent = avatarFor(nickname);

  const rankText = document.getElementById('myRankText');
  const title = document.getElementById('myTitle');
  const gap = document.getElementById('myGap');
  const privateNote = document.getElementById('myPrivateNote');

  if (!me) {
    rankText.textContent = 'まだ番付外';
    title.textContent = '最初の一歩を投稿して、番付入りしましょう！';
    gap.textContent = '';
    privateNote.hidden = true;
    return;
  }

  const periodLabel = {total: '総合', month: '今月', week: '今週'}[data.period];
  if (!me.rank) {
    rankText.textContent = periodLabel + '　まだ歩いていません';
  } else if (data.period === 'total') {
    rankText.innerHTML = periodLabel + ' <strong>' + me.rank + '</strong> 位　<span class="my-banzuke">' + escapeHtml(banzukeRank(me.rank)) + '</span>';
  } else {
    rankText.innerHTML = periodLabel + ' <strong>' + me.rank + '</strong> 位　<span class="my-banzuke">' + Number(me.periodSteps).toLocaleString() + ' 歩</span>';
  }
  title.textContent = '称号：' + travelerTitle(me) + '（' + me.station + '）';

  if (me.rank === 1) {
    gap.innerHTML = '🏆 トップを独走中！この調子で京を目指しましょう。';
  } else if (me.gapToAbove) {
    const unit = data.period === 'total' ? ' km' : ' 歩';
    const val = data.period === 'total' ? Number(me.gapToAbove.value).toFixed(1) : Number(me.gapToAbove.value).toLocaleString();
    gap.innerHTML = '🔥 1つ上の <strong>' + escapeHtml(me.gapToAbove.nickname) + '</strong> さんまで あと <strong>' + val + unit + '</strong>';
  } else {
    gap.textContent = data.period === 'total' ? '' : 'この期間に歩いて、番付に名乗りを上げましょう！';
  }

  privateNote.hidden = !!me.isPublic;
}

document.getElementById('quickPublishBtn').addEventListener('click', async (e) => {
  const btn = e.target;
  btn.disabled = true;
  const res = await setProgressVisibility(true);
  btn.disabled = false;
  if (res && res.ok) loadRankingPage();
});

// ============ レース（現在地） ============
function renderRace(data) {
  const lanesEl = document.getElementById('raceLanes');
  const landmarksEl = document.getElementById('raceLandmarks');
  const routeKm = data.routeKm;

  const ticks = data.landmarks.map(l =>
    '<span class="lm-tick" style="left:' + (l.km / routeKm * 100) + '%"></span>'
  ).join('');

  landmarksEl.innerHTML =
    '<span></span><div class="lm-track">' +
    '<span class="lm-label" style="left:0%">日本橋</span>' +
    data.landmarks.map(l =>
      '<span class="lm-label" style="left:' + (l.km / routeKm * 100) + '%">' + escapeHtml(l.name) + '</span>'
    ).join('') +
    '</div><span></span>';

  const lanes = data.entries.slice(0, 10);
  const me = data.me;
  if (me && !lanes.some(e => e.isMine)) lanes.push(Object.assign({}, me, {outside: true}));

  document.getElementById('raceEmpty').hidden = lanes.length > 0;
  lanesEl.innerHTML = lanes.map(e => {
    const pos = Math.max(2, Math.min(98, e.pct));
    return '<div class="lane' + (e.isMine ? ' lane-me' : '') + (e.outside ? ' lane-outside' : '') + '">' +
      '<div class="lane-name">' +
        '<span class="lane-rank">' + (e.isPublic && e.rank ? e.rank : '―') + '</span>' +
        '<span class="lane-nick">' + escapeHtml(e.nickname) + (e.isPublic ? '' : '<small>（非公開）</small>') + '</span>' +
      '</div>' +
      '<div class="lane-track">' + ticks +
        '<div class="lane-fill" data-w="' + e.pct + '"></div>' +
        walkerHtml(e, pos) +
      '</div>' +
      '<div class="lane-km">' + Number(e.totalKm).toFixed(1) + '<small>km</small></div>' +
    '</div>';
  }).join('');

  // 左からスタートして現在地まで歩くアニメーション
  requestAnimationFrame(() => requestAnimationFrame(() => {
    lanesEl.querySelectorAll('.lane-fill').forEach(el => { el.style.width = el.dataset.w + '%'; });
    lanesEl.querySelectorAll('.walker').forEach(el => { el.style.left = el.dataset.left + '%'; });
  }));
}

// レースの歩く人：最新の公開写真があれば丸い写真、なければ動物アイコン
function walkerHtml(e, pos) {
  const latest = (e.photos || [])[0];
  if (e.isComplete) {
    return '<span class="walker walker-goal" data-left="' + pos + '" title="' + escapeHtml(e.station) + '">🏯</span>';
  }
  if (latest) {
    return '<button type="button" class="walker walker-photo" data-left="' + pos + '"' +
      ' data-full="' + escapeHtml(latest.full) + '" data-caption="' + escapeHtml(photoCaption(e, latest)) + '"' +
      ' title="' + escapeHtml(e.nickname + '・' + e.station) + '">' +
      '<img src="' + escapeHtml(latest.thumb) + '" alt="' + escapeHtml(e.nickname) + 'さんの最新の写真" loading="lazy">' +
      '<span class="walker-badge">' + avatarFor(e.nickname) + '</span>' +
    '</button>';
  }
  return '<span class="walker" data-left="' + pos + '" title="' + escapeHtml(e.station) + '">' + avatarFor(e.nickname) + '</span>';
}

// ============ 番付表 ============
function renderBanzuke(data) {
  const list = document.getElementById('banzukeList');
  const empty = document.getElementById('banzukeEmpty');
  const note = document.getElementById('periodNote');

  if (data.period === 'total') {
    note.textContent = '日本橋からの累計距離で番付を決めます。横綱を目指せ！';
  } else {
    note.textContent = (data.period === 'week' ? '今週' : '今月') + '（' + formatMD(data.periodFrom) + '〜' + formatMD(data.today) + '）に歩いた歩数の勝負です。';
  }

  const items = data.entries.slice();
  const me = data.me;
  const showMeExtra = me && me.rank && !items.some(e => e.isMine);

  empty.hidden = items.length > 0 || showMeExtra;

  const rowHtml = (e, extra) => {
    const v = rankValue(e, data.period);
    const rankLabel = data.period === 'total' ? banzukeRank(e.rank) : periodRank(e.rank);
    return '<li class="bz-item' + (e.isMine ? ' bz-me' : '') + (e.rank && e.rank <= 3 ? ' bz-top bz-top' + e.rank : '') + (extra ? ' bz-extra' : '') + '">' +
      '<span class="bz-rank">' + escapeHtml(rankLabel) + '</span>' +
      '<span class="bz-avatar">' + avatarFor(e.nickname) + '</span>' +
      '<div class="bz-body">' +
        '<p class="bz-name">' + escapeHtml(e.nickname) + ' さん' + (e.isMine ? '<span class="vis-badge vis-mine">あなた</span>' : '') + '</p>' +
        '<p class="bz-sub">' + escapeHtml(travelerTitle(e)) + '・' + escapeHtml(e.station) + (extra && !e.isPublic ? '（非公開・参考）' : '') + '</p>' +
      '</div>' +
      '<span class="bz-value">' + v.num + '<small>' + v.unit + '</small></span>' +
      photoStripHtml(e) +
    '</li>';
  };

  list.innerHTML = items.map(e => rowHtml(e, false)).join('') + (showMeExtra ? rowHtml(me, true) : '');
}

// ============ 初期表示（#ranking で直接開いた場合） ============
(function initRanking() {
  const session = getSession();
  if (session && session.sessionToken && location.hash === '#ranking') {
    showPage('ranking');
  }
})();
