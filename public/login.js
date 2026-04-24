const form = document.querySelector('#loginForm');
const input = document.querySelector('#loginAdminToken');
const button = document.querySelector('#loginButton');
const message = document.querySelector('#loginMessage');

let pending = false;

function setPending(isPending) {
  pending = isPending;
  input.disabled = isPending;
  button.disabled = isPending;
  document.body.setAttribute('aria-busy', String(isPending));
}

async function readError(response) {
  const text = await response.text();
  if (!text) return 'Admin Token 无效';
  try {
    return JSON.parse(text).error || 'Admin Token 无效';
  } catch {
    return text;
  }
}

async function login() {
  if (pending) return;
  const token = input.value.trim();
  if (!token) {
    message.textContent = '请输入 Admin Token';
    return;
  }

  try {
    setPending(true);
    const response = await fetch('/api/session', {
      headers: { authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      localStorage.removeItem('context7AdminToken');
      message.textContent = await readError(response);
      return;
    }

    localStorage.setItem('context7AdminToken', token);
    window.location.href = '/dashboard.html';
  } finally {
    setPending(false);
  }
}

input.value = localStorage.getItem('context7AdminToken') || '';
form.addEventListener('submit', (event) => {
  event.preventDefault();
  login().catch((error) => {
    message.textContent = error.message;
  });
});
