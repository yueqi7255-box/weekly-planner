const form = document.getElementById('auth-form');
const modeToggle = document.getElementById('auth-mode-toggle');
const alternateText = document.getElementById('auth-alternate-text');
const confirmField = document.getElementById('confirm-field');
const errorBox = document.getElementById('auth-error');
const submit = document.getElementById('auth-submit');
const title = document.getElementById('auth-title');
const help = document.getElementById('auth-help');
let mode = 'login';

function setMode(next) {
  mode = next;
  confirmField.hidden = next !== 'register';
  form.elements.confirm_password.required = next === 'register';
  form.elements.password.autocomplete = next === 'login' ? 'current-password' : 'new-password';
  submit.textContent = next === 'login' ? '登录' : '创建账号';
  title.textContent = next === 'login' ? '登录' : '创建账号';
  alternateText.textContent = next === 'login' ? '还没有账号？' : '已有账号？';
  modeToggle.textContent = next === 'login' ? '创建账号' : '返回登录';
  help.hidden = next !== 'register';
  errorBox.hidden = true;
  document.title = `${next === 'login' ? '登录' : '注册'} · 周计划`;
  window.history.replaceState(null, '', next === 'register' ? '/login?mode=register' : '/login');
}

modeToggle.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
setMode(new URLSearchParams(window.location.search).get('mode') === 'register' ? 'register' : 'login');

form.addEventListener('submit', async event => {
  event.preventDefault();
  errorBox.hidden = true;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  if (mode === 'register' && password !== form.elements.confirm_password.value) {
    errorBox.textContent = '两次输入的密码不一致';
    errorBox.hidden = false;
    return;
  }
  submit.disabled = true;
  try {
    const response = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败');
    window.location.assign('/app');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    submit.disabled = false;
  }
});
