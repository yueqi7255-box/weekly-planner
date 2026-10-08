const form = document.getElementById('auth-form');
const loginTab = document.getElementById('login-tab');
const registerTab = document.getElementById('register-tab');
const confirmField = document.getElementById('confirm-field');
const errorBox = document.getElementById('auth-error');
const submit = document.getElementById('auth-submit');
let mode = 'login';

function setMode(next) {
  mode = next;
  loginTab.classList.toggle('active', next === 'login');
  registerTab.classList.toggle('active', next === 'register');
  loginTab.setAttribute('aria-pressed', String(next === 'login'));
  registerTab.setAttribute('aria-pressed', String(next === 'register'));
  confirmField.hidden = next !== 'register';
  form.elements.confirm_password.required = next === 'register';
  form.elements.password.autocomplete = next === 'login' ? 'current-password' : 'new-password';
  submit.textContent = next === 'login' ? '登录' : '创建账号';
  errorBox.hidden = true;
  document.title = `${next === 'login' ? '登录' : '注册'} · 周计划`;
}

loginTab.addEventListener('click', () => setMode('login'));
registerTab.addEventListener('click', () => setMode('register'));

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
    window.location.assign('/');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
    submit.disabled = false;
  }
});
