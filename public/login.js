const form = document.querySelector('#loginForm');
const input = document.querySelector('#loginAdminToken');
const button = document.querySelector('#loginButton');
const message = document.querySelector('#loginMessage');

async function login() {
  const token = input.value.trim();
  localStorage.setItem('context7AdminToken', token);

  const response = await fetch('/api/session', {
    headers: { authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    localStorage.removeItem('context7AdminToken');
    message.textContent = 'Admin Token 无效';
    return;
  }

  window.location.href = '/dashboard.html';
}

input.value = localStorage.getItem('context7AdminToken') || '';
form.addEventListener('submit', (event) => {
  event.preventDefault();
  login().catch((error) => {
    message.textContent = error.message;
  });
});
button.addEventListener('click', () => {
  login().catch((error) => {
    message.textContent = error.message;
  });
});
