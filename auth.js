// ============ 設定 ============
// GASのURLは config.js で設定します（このファイルにはURLを書きません）
const API_URL = (window.APP_CONFIG && window.APP_CONFIG.API_URL) || '';
if (!API_URL) {
  console.error('config.js が読み込めないか、API_URL が未設定です。');
}

const SESSION_KEY = 'toukaido53_session';

// ============ 共通API呼び出し ============
// GASへのCORSプリフライトを避けるため text/plain で送信する
async function callApi(payload) {
  if (!API_URL) return {ok:false, error:'config_missing'};
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {'Content-Type': 'text/plain;charset=utf-8'},
      body: JSON.stringify(payload)
    });
    return await res.json();
  } catch (err) {
    return {ok:false, error:'network_error'};
  }
}

function getSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
  catch (e) { return null; }
}
function setSession(session) { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

const ERROR_MESSAGES = {
  missing_fields: '未入力の項目があります。',
  invalid_email: 'メールアドレスの形式が正しくありません。',
  email_exists: 'そのメールアドレスは既に登録されています。',
  invalid_credentials: 'メールアドレスまたはパスワードが違います。',
  locked: 'ログイン試行回数が上限を超えました。しばらくしてから再度お試しください。',
  session_expired: 'セッションの有効期限が切れました。再度ログインしてください。',
  password_too_short: 'パスワードは8文字以上で設定してください。',
  mail_failed: 'メール送信に失敗しました。時間をおいて再度お試しください。',
  member_not_found: '会員情報が見つかりません。',
  server_error: 'サーバーエラーが発生しました。時間をおいて再度お試しください。',
  config_missing: '設定ファイル（config.js）が読み込めません。管理者にお知らせください。',
  network_error: '通信に失敗しました。電波状況を確認して、もう一度お試しください。'
};
function errorMessage(code) { return ERROR_MESSAGES[code] || 'エラーが発生しました。'; }

// ============ 画面切り替え ============
function showAuthScreen() {
  document.getElementById('authSection').hidden = false;
  document.getElementById('changePasswordSection').hidden = true;
  document.getElementById('appMain').hidden = true;
  document.getElementById('userBar').hidden = true;
}
function showChangePasswordScreen() {
  document.getElementById('authSection').hidden = true;
  document.getElementById('changePasswordSection').hidden = false;
  document.getElementById('appMain').hidden = true;
}
function showAppScreen(nickname) {
  document.getElementById('authSection').hidden = true;
  document.getElementById('changePasswordSection').hidden = true;
  document.getElementById('appMain').hidden = false;
  document.getElementById('userBar').hidden = false;
  document.getElementById('userNickname').textContent = nickname;
}

// ============ タブ切り替え ============
document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const target = tab.dataset.tab;
    document.getElementById('loginForm').hidden = target !== 'login';
    document.getElementById('registerForm').hidden = target !== 'register';
    document.getElementById('forgotForm').hidden = true;
  });
});

document.getElementById('showForgotBtn').addEventListener('click', () => {
  document.getElementById('loginForm').hidden = true;
  document.getElementById('registerForm').hidden = true;
  document.getElementById('forgotForm').hidden = false;
});
document.getElementById('backToLoginBtn').addEventListener('click', () => {
  document.getElementById('forgotForm').hidden = true;
  document.getElementById('loginForm').hidden = false;
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelector('.auth-tab[data-tab="login"]').classList.add('active');
});

// ============ パスワード表示/非表示 ============
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    btn.textContent = isHidden ? '隠す' : '表示';
  });
});

// ============ 会員登録 ============
document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('registerMessage');
  msg.textContent = '登録中…';
  const nickname = document.getElementById('registerNickname').value.trim();
  const email = document.getElementById('registerEmail').value.trim();
  const res = await callApi({action:'register', nickname, email});
  if (res.ok) {
    msg.textContent = '登録が完了しました。仮パスワードをメールでお送りしましたので、ログインしてください。';
    document.getElementById('registerForm').reset();
  } else {
    msg.textContent = errorMessage(res.error);
  }
});

// ============ ログイン ============
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('loginMessage');
  msg.textContent = 'ログイン中…';
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const res = await callApi({action:'login', email, password});
  if (!res.ok) {
    msg.textContent = errorMessage(res.error);
    return;
  }
  msg.textContent = '';
  setSession({sessionToken: res.sessionToken, memberId: res.memberId, nickname: res.nickname});
  if (res.mustChangePassword) {
    showChangePasswordScreen();
  } else {
    showAppScreen(res.nickname);
    if (typeof loadState === 'function') loadState();
  }
});

// ============ パスワード再発行 ============
document.getElementById('forgotForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('forgotMessage');
  msg.textContent = '処理中…';
  const email = document.getElementById('forgotEmail').value.trim();
  const res = await callApi({action:'requestPasswordReset', email});
  msg.textContent = res.ok
    ? '登録済みのメールアドレスであれば、仮パスワードをお送りしました。'
    : errorMessage(res.error);
});

// ============ パスワード変更（初回ログイン時強制） ============
document.getElementById('changePasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('changePasswordMessage');
  const session = getSession();
  if (!session) { showAuthScreen(); return; }
  msg.textContent = '変更中…';
  const newPassword = document.getElementById('newPassword').value;
  const res = await callApi({action:'changePassword', sessionToken: session.sessionToken, newPassword});
  if (res.ok) {
    document.getElementById('changePasswordForm').reset();
    showAppScreen(session.nickname);
    if (typeof loadState === 'function') loadState();
  } else {
    msg.textContent = errorMessage(res.error);
  }
});

// ============ ログアウト ============
document.getElementById('logoutBtn').addEventListener('click', async () => {
  const session = getSession();
  if (session) await callApi({action:'logout', sessionToken: session.sessionToken});
  clearSession();
  showAuthScreen();
});

// ============ 初期表示：セッションがあればアプリ画面へ ============
(function initAuth() {
  const session = getSession();
  if (session && session.sessionToken) {
    showAppScreen(session.nickname);
  } else {
    showAuthScreen();
  }
})();
