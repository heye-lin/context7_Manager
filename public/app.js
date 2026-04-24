const page = document.body.dataset.page;

const elements = {
  accountCards: document.querySelector('#accountCards'),
  accountFilter: document.querySelector('#accountFilter'),
  accountForm: document.querySelector('#accountForm'),
  accountSearch: document.querySelector('#accountSearch'),
  adminToken: document.querySelector('#adminToken'),
  authForm: document.querySelector('#authForm'),
  enabledAccounts: document.querySelector('#enabledAccounts'),
  gatewayAuthForm: document.querySelector('#gatewayAuthForm'),
  gatewayForm: document.querySelector('#gatewayForm'),
  gatewayResult: document.querySelector('#gatewayResult'),
  gatewayToken: document.querySelector('#gatewayToken'),
  leaseButton: document.querySelector('#leaseButton'),
  loginAdminToken: document.querySelector('#loginAdminToken'),
  loginButton: document.querySelector('#loginButton'),
  loginForm: document.querySelector('#loginForm'),
  loginMessage: document.querySelector('#loginMessage'),
  logoutButton: document.querySelector('#logoutButton'),
  message: document.querySelector('#message'),
  refreshButton: document.querySelector('#refreshButton'),
  reloadSettingsButton: document.querySelector('#reloadSettingsButton'),
  settingMode: document.querySelector('#settingMode'),
  settingsAccountStorePath: document.querySelector('#settingsAccountStorePath'),
  settingsAdminToken: document.querySelector('#settingsAdminToken'),
  settingsContext7BaseUrl: document.querySelector('#settingsContext7BaseUrl'),
  settingsEncryptionKey: document.querySelector('#settingsEncryptionKey'),
  settingsForm: document.querySelector('#settingsForm'),
  settingsGatewayToken: document.querySelector('#settingsGatewayToken'),
  adminTokenStatus: document.querySelector('#adminTokenStatus'),
  adminTokenPreview: document.querySelector('#adminTokenPreview'),
  gatewayTokenStatus: document.querySelector('#gatewayTokenStatus'),
  gatewayTokenPreview: document.querySelector('#gatewayTokenPreview'),
  encryptionKeyStatus: document.querySelector('#encryptionKeyStatus'),
  totalAccounts: document.querySelector('#totalAccounts'),
  totalFailures: document.querySelector('#totalFailures'),
  totalUsage: document.querySelector('#totalUsage'),
};

const state = {
  accounts: [],
};

function showMessage(message, type = 'info') {
  if (!elements.message) return;
  elements.message.textContent = message;
  elements.message.dataset.type = type;
}

function formatJson(value) {
  return JSON.stringify(value, null, 2);
}

function getAdminToken() {
  return localStorage.getItem('context7AdminToken') || '';
}

function getGatewayToken() {
  return localStorage.getItem('context7GatewayToken') || '';
}

function setAdminToken(token) {
  localStorage.setItem('context7AdminToken', token);
  if (elements.adminToken) elements.adminToken.value = token;
  if (elements.loginAdminToken) elements.loginAdminToken.value = token;
}

function adminHeaders() {
  const token = getAdminToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function gatewayHeaders() {
  const token = getGatewayToken();
  return token ? { authorization: `Bearer ${token}` } : adminHeaders();
}

function setLoading(isLoading) {
  document.body.classList.toggle('isLoading', isLoading);
}

async function requestJson(url, options = {}, headersFactory = adminHeaders) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...headersFactory(), ...options.headers },
  });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }

  return data;
}

async function validateSession() {
  await requestJson('/api/session');
}

function redirectToLogin() {
  if (page !== 'login') {
    window.location.href = '/';
  }
}

function redirectToDashboard() {
  window.location.href = '/dashboard.html';
}

function accountStatus(account) {
  if (!account.enabled) return { label: '已停用', tone: 'muted' };
  if (account.failureCount > 0) return { label: '需关注', tone: 'warning' };
  return { label: '健康', tone: 'success' };
}

function updateStats(accounts) {
  if (elements.totalAccounts) elements.totalAccounts.textContent = accounts.length;
  if (elements.enabledAccounts) elements.enabledAccounts.textContent = accounts.filter((account) => account.enabled).length;
  if (elements.totalFailures) elements.totalFailures.textContent = accounts.reduce((sum, account) => sum + account.failureCount, 0);
  if (elements.totalUsage) elements.totalUsage.textContent = accounts.reduce((sum, account) => sum + account.usageCount, 0);
}

function filteredAccounts() {
  const keyword = elements.accountSearch?.value.trim().toLowerCase() || '';
  const filter = elements.accountFilter?.value || 'all';

  return state.accounts.filter((account) => {
    const matchesKeyword = !keyword
      || account.name.toLowerCase().includes(keyword)
      || account.tokenPreview.toLowerCase().includes(keyword);
    const matchesFilter = filter === 'all'
      || (filter === 'enabled' && account.enabled)
      || (filter === 'disabled' && !account.enabled)
      || (filter === 'failed' && account.failureCount > 0);
    return matchesKeyword && matchesFilter;
  });
}

function renderAccounts() {
  updateStats(state.accounts);
  if (!elements.accountCards) return;

  const accounts = filteredAccounts();
  if (!state.accounts.length) {
    elements.accountCards.innerHTML = '<div class="emptyState"><strong>还没有账号</strong><p>添加第一个 Context7 API Key 后，网关会自动参与调度。</p></div>';
    return;
  }

  if (!accounts.length) {
    elements.accountCards.innerHTML = '<div class="emptyState"><strong>没有匹配结果</strong><p>调整搜索关键词或筛选条件后再试。</p></div>';
    return;
  }

  elements.accountCards.innerHTML = accounts.map((account) => {
    const status = accountStatus(account);
    return `
      <article class="accountCard">
        <div class="accountMain">
          <div class="accountTitle"><strong>${account.name}</strong><span class="statusPill ${status.tone}">${status.label}</span></div>
          <p class="tokenPreview">${account.tokenPreview}</p>
          <div class="metricRow"><span>使用 <strong>${account.usageCount}</strong></span><span>租用 <strong>${account.leasedCount}</strong></span><span>失败 <strong>${account.failureCount}</strong></span></div>
          ${account.lastError ? `<p class="errorText">最后错误：${account.lastError}</p>` : ''}
        </div>
        <div class="actions"><button class="secondary" data-toggle="${account.id}">${account.enabled ? '停用' : '启用'}</button><button class="secondary" data-success="${account.id}">记成功</button><button class="secondary" data-failure="${account.id}">记失败</button><button class="danger" data-delete="${account.id}">删除</button></div>
      </article>
    `;
  }).join('');
}

async function loadAccounts() {
  setLoading(true);
  try {
    const data = await requestJson('/api/accounts');
    state.accounts = data.accounts;
    renderAccounts();
    showMessage('账号池已刷新。', 'success');
  } finally {
    setLoading(false);
  }
}

function renderSettings(settings) {
  if (!elements.settingMode) return;
  elements.settingMode.textContent = settings.mode === 'personal' ? '个人' : settings.mode;
  elements.adminTokenStatus.textContent = settings.adminTokenConfigured ? '已配置' : '未配置';
  elements.gatewayTokenStatus.textContent = settings.gatewayTokenConfigured ? '已配置' : '未配置';
  elements.encryptionKeyStatus.textContent = settings.encryptionKeyConfigured ? '已配置' : '未配置';
  elements.adminTokenPreview.textContent = settings.adminTokenPreview || '未配置';
  elements.gatewayTokenPreview.textContent = settings.gatewayTokenPreview || '未配置';
  elements.settingsContext7BaseUrl.value = settings.context7BaseUrl || '';
  elements.settingsAccountStorePath.value = settings.accountStorePath || '';
}

async function loadSettings() {
  const data = await requestJson('/api/settings');
  renderSettings(data.settings);
}

async function initializeProtectedPage() {
  if (page === 'login') return;
  if (!getAdminToken()) {
    redirectToLogin();
    return;
  }

  try {
    await validateSession();
    await loadAccounts();
  } catch (error) {
    localStorage.removeItem('context7AdminToken');
    redirectToLogin();
  }
}

function bindCommonForms() {
  if (elements.adminToken) elements.adminToken.value = getAdminToken();
  if (elements.gatewayToken) elements.gatewayToken.value = getGatewayToken();

  elements.authForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      setAdminToken(elements.adminToken.value.trim());
      await validateSession();
      showMessage('Admin Token 已更新。', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });

  elements.gatewayAuthForm?.addEventListener('submit', (event) => {
    event.preventDefault();
    localStorage.setItem('context7GatewayToken', elements.gatewayToken.value.trim());
    showMessage('Gateway Token 已保存到本机浏览器。', 'success');
  });

  elements.logoutButton?.addEventListener('click', () => {
    localStorage.removeItem('context7AdminToken');
    redirectToLogin();
  });
}

function bindSecurityPage() {
  elements.reloadSettingsButton?.addEventListener('click', () => {
    loadSettings().then(() => showMessage('设置已重新加载。', 'success')).catch((error) => showMessage(error.message, 'error'));
  });

  elements.settingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      accountStorePath: elements.settingsAccountStorePath.value.trim(),
      adminToken: elements.settingsAdminToken.value.trim(),
      context7BaseUrl: elements.settingsContext7BaseUrl.value.trim(),
      encryptionKey: elements.settingsEncryptionKey.value.trim(),
      gatewayToken: elements.settingsGatewayToken.value.trim(),
    };

    try {
      const data = await requestJson('/api/settings', {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      if (payload.adminToken) setAdminToken(payload.adminToken);
      if (payload.gatewayToken) localStorage.setItem('context7GatewayToken', payload.gatewayToken);
      elements.settingsAdminToken.value = '';
      elements.settingsGatewayToken.value = '';
      elements.settingsEncryptionKey.value = '';
      renderSettings(data.settings);
      showMessage('设置已保存到 .env，并已同步生效。', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });
}

function bindLoginPage() {
  if (page !== 'login') return;
  if (elements.loginAdminToken) elements.loginAdminToken.value = getAdminToken();

  async function login() {
    try {
      setAdminToken(elements.loginAdminToken.value.trim());
      await validateSession();
      redirectToDashboard();
    } catch (error) {
      localStorage.removeItem('context7AdminToken');
      elements.loginMessage.textContent = error.message;
    }
  }

  elements.loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await login();
  });
  elements.loginButton?.addEventListener('click', login);
}

function bindAccountsPage() {
  elements.accountForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(elements.accountForm);
    try {
      setLoading(true);
      await requestJson('/api/accounts', { method: 'POST', body: JSON.stringify(Object.fromEntries(formData)) });
      elements.accountForm.reset();
      showMessage('账号已加密加入号池。', 'success');
      await loadAccounts();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });

  elements.refreshButton?.addEventListener('click', () => loadAccounts().catch((error) => showMessage(error.message, 'error')));
  elements.accountSearch?.addEventListener('input', renderAccounts);
  elements.accountFilter?.addEventListener('change', renderAccounts);

  elements.accountCards?.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;

    try {
      setLoading(true);
      if (button.dataset.toggle) {
        await requestJson(`/api/accounts/${button.dataset.toggle}`, { method: 'PATCH', body: JSON.stringify({ enabled: button.textContent === '启用' }) });
      }
      if (button.dataset.success) {
        await requestJson(`/api/accounts/${button.dataset.success}/usage`, { method: 'POST', body: JSON.stringify({ success: true }) });
      }
      if (button.dataset.failure) {
        await requestJson(`/api/accounts/${button.dataset.failure}/usage`, { method: 'POST', body: JSON.stringify({ success: false, error: '手动标记失败' }) });
      }
      if (button.dataset.delete) {
        const confirmed = confirm('确认删除这个账号？此操作不可恢复。');
        if (!confirmed) return;
        await requestJson(`/api/accounts/${button.dataset.delete}`, { method: 'DELETE' });
      }
      await loadAccounts();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });
}

function bindDashboardPage() {
  elements.leaseButton?.addEventListener('click', async () => {
    try {
      setLoading(true);
      const lease = await requestJson('/api/leases', { method: 'POST' });
      showMessage(`租号成功：${lease.account.name}。完整 Token 仅用于受控自检。`, 'success');
      await loadAccounts();
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });
}

function bindGatewayPage() {
  elements.gatewayForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(elements.gatewayForm);
    const rawBody = formData.get('body').trim();
    try {
      setLoading(true);
      const payload = { method: formData.get('method'), path: formData.get('path') };
      if (rawBody) payload.body = JSON.parse(rawBody);
      const result = await requestJson('/api/gateway', { method: 'POST', body: JSON.stringify(payload) }, gatewayHeaders);
      elements.gatewayResult.textContent = formatJson(result);
      showMessage(`已通过 ${result.account.name} 完成代理调用。`, 'success');
      await loadAccounts();
    } catch (error) {
      elements.gatewayResult.textContent = error.message;
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });
}

async function initializeSecurityPage() {
  if (page !== 'security') return;
  try {
    await loadSettings();
  } catch (error) {
    showMessage(error.message, 'error');
  }
}

document.querySelector(`[data-nav="${page}"]`)?.classList.add('active');
bindLoginPage();
bindCommonForms();
bindDashboardPage();
bindAccountsPage();
bindGatewayPage();
bindSecurityPage();
initializeProtectedPage();
initializeSecurityPage();
