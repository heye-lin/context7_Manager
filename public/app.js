const page = document.body.dataset.page;

const elements = {
  accountCards: document.querySelector('#accountCards'),
  accountFilter: document.querySelector('#accountFilter'),
  accountForm: document.querySelector('#accountForm'),
  accountSearch: document.querySelector('#accountSearch'),
  accountTestResult: document.querySelector('#accountTestResult'),
  enabledAccounts: document.querySelector('#enabledAccounts'),
  buildType: document.querySelector('#buildType'),
  currentVersion: document.querySelector('#currentVersion'),
  leaseButton: document.querySelector('#leaseButton'),
  logAccountFilter: document.querySelector('#logAccountFilter'),
  logCount: document.querySelector('#logCount'),
  logLimit: document.querySelector('#logLimit'),
  logList: document.querySelector('#logList'),
  logStatusFilter: document.querySelector('#logStatusFilter'),
  logTypeFilter: document.querySelector('#logTypeFilter'),
  logoutButton: document.querySelector('#logoutButton'),
  message: document.querySelector('#message'),
  refreshLogsButton: document.querySelector('#refreshLogsButton'),
  refreshButton: document.querySelector('#refreshButton'),
  reloadSettingsButton: document.querySelector('#reloadSettingsButton'),
  settingMode: document.querySelector('#settingMode'),
  settingsAccountStorePath: document.querySelector('#settingsAccountStorePath'),
  settingsAdminToken: document.querySelector('#settingsAdminToken'),
  settingsAuditLogPath: document.querySelector('#settingsAuditLogPath'),
  settingsContext7BaseUrl: document.querySelector('#settingsContext7BaseUrl'),
  settingsEncryptionKey: document.querySelector('#settingsEncryptionKey'),
  settingsForm: document.querySelector('#settingsForm'),
  settingsGatewayToken: document.querySelector('#settingsGatewayToken'),
  settingsUpdateCommand: document.querySelector('#settingsUpdateCommand'),
  settingsUpdateMode: document.querySelector('#settingsUpdateMode'),
  settingsUpdateWebhookToken: document.querySelector('#settingsUpdateWebhookToken'),
  settingsUpdateWebhookUrl: document.querySelector('#settingsUpdateWebhookUrl'),
  latestVersion: document.querySelector('#latestVersion'),
  performUpdateButton: document.querySelector('#performUpdateButton'),
  adminTokenStatus: document.querySelector('#adminTokenStatus'),
  adminTokenPreview: document.querySelector('#adminTokenPreview'),
  gatewayTokenStatus: document.querySelector('#gatewayTokenStatus'),
  gatewayTokenPreview: document.querySelector('#gatewayTokenPreview'),
  encryptionKeyStatus: document.querySelector('#encryptionKeyStatus'),
  attentionAccounts: document.querySelector('#attentionAccounts'),
  lowestQuota: document.querySelector('#lowestQuota'),
  totalAccounts: document.querySelector('#totalAccounts'),
  totalFailures: document.querySelector('#totalFailures'),
  totalUsage: document.querySelector('#totalUsage'),
  updateCommandBox: document.querySelector('#updateCommandBox'),
  updateCommands: document.querySelector('#updateCommands'),
  updateExecutorStatus: document.querySelector('#updateExecutorStatus'),
  updateModeStatus: document.querySelector('#updateModeStatus'),
  updateResult: document.querySelector('#updateResult'),
  updateState: document.querySelector('#updateState'),
};

const state = { accounts: [], logs: [] };

function showMessage(message, type = 'info') {
  if (!elements.message) return;
  elements.message.textContent = message;
  elements.message.dataset.type = type;
}

function getAdminToken() {
  return localStorage.getItem('context7AdminToken') || '';
}

function setAdminToken(token) {
  localStorage.setItem('context7AdminToken', token);
}

function clearAdminToken() {
  localStorage.removeItem('context7AdminToken');
}

function adminHeaders() {
  const token = getAdminToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}

function setLoading(isLoading) {
  document.body.classList.toggle('isLoading', isLoading);
  document.body.setAttribute('aria-busy', String(isLoading));
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = isLoading;
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...adminHeaders(), ...options.headers },
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text || `HTTP ${response.status}` };
  }

  if (!response.ok) {
    if (response.status === 401 && page !== 'login') {
      logout();
    }
    throw new Error(data?.error || `请求失败：${response.status}`);
  }

  return data;
}

async function validateSession() {
  await requestJson('/api/session');
}

function redirectToLogin() {
  window.location.href = '/';
}

function logout() {
  clearAdminToken();
  redirectToLogin();
}

function accountStatus(account) {
  if (!account.enabled) return { label: '已停用', tone: 'muted' };
  if (account.failureCount > 0) return { label: '需关注', tone: 'warning' };
  return { label: '健康', tone: 'success' };
}

function quotaLabel(account) {
  return account.remainingQuota === null || account.remainingQuota === undefined ? '未知' : account.remainingQuota;
}

function quotaTone(account) {
  if (account.remainingQuota === null || account.remainingQuota === undefined) return 'muted';
  if (account.remainingQuota === 0) return 'danger';
  if (account.remainingQuota <= 10) return 'warning';
  return 'success';
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
}

function logTypeLabel(type) {
  return {
    account: '账号管理',
    'account-test': '账号测试',
    auth: '登录会话',
    error: '系统错误',
    gateway: '网关 API',
    lease: '租号自检',
    mcp: 'MCP',
    settings: '配置变更',
    update: '版本更新',
  }[type] || '系统日志';
}

function updateStats(accounts) {
  if (elements.totalAccounts) elements.totalAccounts.textContent = accounts.length;
  if (elements.enabledAccounts) elements.enabledAccounts.textContent = accounts.filter((account) => account.enabled).length;
  if (elements.totalFailures) elements.totalFailures.textContent = accounts.reduce((sum, account) => sum + account.failureCount, 0);
  if (elements.totalUsage) elements.totalUsage.textContent = accounts.reduce((sum, account) => sum + account.usageCount, 0);
  if (elements.attentionAccounts) elements.attentionAccounts.textContent = accounts.filter((account) => account.failureCount > 0 || account.remainingQuota === 0).length;
  if (elements.lowestQuota) {
    const knownQuotas = accounts.map((account) => account.remainingQuota).filter((quota) => Number.isFinite(quota));
    elements.lowestQuota.textContent = knownQuotas.length ? Math.min(...knownQuotas) : '未知';
  }
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

function createAccountCard(account) {
  const status = accountStatus(account);
  const card = document.createElement('article');
  card.className = 'accountCard';

  const main = document.createElement('div');
  main.className = 'accountMain';

  const title = document.createElement('div');
  title.className = 'accountTitle';
  const name = document.createElement('strong');
  name.textContent = account.name;
  const statusPill = document.createElement('span');
  statusPill.className = `statusPill ${status.tone}`;
  statusPill.textContent = status.label;
  title.append(name, statusPill);

  const token = document.createElement('p');
  token.className = 'tokenPreview';
  token.textContent = account.tokenPreview;

  const metrics = document.createElement('div');
  metrics.className = 'metricRow';
  for (const [label, value] of [['调用', account.usageCount], ['租用', account.leasedCount], ['失败', account.failureCount]]) {
    const item = document.createElement('span');
    item.textContent = `${label} `;
    const strong = document.createElement('strong');
    strong.textContent = value;
    item.append(strong);
    metrics.append(item);
  }
  const quota = document.createElement('span');
  quota.className = `quotaPill ${quotaTone(account)}`;
  quota.textContent = `剩余额度 ${quotaLabel(account)}`;
  metrics.append(quota);

  main.append(title, token, metrics);
  if (account.lastError) {
    const error = document.createElement('p');
    error.className = 'errorText';
    error.textContent = `最后错误：${account.lastError}`;
    main.append(error);
  }

  const actions = document.createElement('div');
  actions.className = 'actions';
  const toggleButton = document.createElement('button');
  toggleButton.className = 'secondary';
  toggleButton.dataset.toggle = account.id;
  toggleButton.setAttribute('aria-label', `${account.enabled ? '停用' : '启用'}账号 ${account.name}`);
  toggleButton.textContent = account.enabled ? '停用' : '启用';
  const testButton = document.createElement('button');
  testButton.className = 'secondary';
  testButton.dataset.test = account.id;
  testButton.setAttribute('aria-label', `测试账号 ${account.name}`);
  testButton.textContent = '账号测试';
  const deleteButton = document.createElement('button');
  deleteButton.className = 'danger';
  deleteButton.dataset.delete = account.id;
  deleteButton.setAttribute('aria-label', `删除账号 ${account.name}`);
  deleteButton.textContent = '删除';
  actions.append(toggleButton, testButton, deleteButton);

  card.append(main, actions);
  return card;
}

function renderAccountTestResult(result) {
  if (!elements.accountTestResult) return;
  elements.accountTestResult.replaceChildren();
  const summary = document.createElement('div');
  summary.className = `testSummary ${result.success ? 'success' : 'error'}`;
  summary.innerHTML = `<strong>${result.success ? '测试成功' : '测试失败'}</strong><span>${result.account.name}</span><span>剩余额度：${quotaLabel(result.account)}</span><span>HTTP ${result.statusCode}</span>`;
  const details = document.createElement('details');
  const title = document.createElement('summary');
  title.textContent = '查看原始响应';
  const body = document.createElement('pre');
  body.className = 'result';
  body.textContent = JSON.stringify(result, null, 2);
  details.append(title, body);
  elements.accountTestResult.append(summary, details);
}

function renderAccounts() {
  updateStats(state.accounts);
  if (!elements.accountCards) return;
  elements.accountCards.replaceChildren();

  const accounts = filteredAccounts();
  if (!state.accounts.length) {
    elements.accountCards.innerHTML = '<div class="emptyState"><strong>还没有账号</strong><p>添加第一个 Context7 API Key 后即可管理和测试。</p></div>';
    return;
  }

  if (!accounts.length) {
    elements.accountCards.innerHTML = '<div class="emptyState"><strong>没有匹配结果</strong><p>调整搜索关键词或筛选条件后再试。</p></div>';
    return;
  }

  elements.accountCards.append(...accounts.map(createAccountCard));
}

async function loadAccounts({ silent = false } = {}) {
  setLoading(true);
  try {
    const data = await requestJson('/api/accounts');
    state.accounts = data.accounts;
    renderAccounts();
    if (!silent) showMessage('账号池已刷新。', 'success');
  } finally {
    setLoading(false);
  }
}

function renderLogs() {
  if (!elements.logList) return;
  elements.logList.replaceChildren();
  if (elements.logCount) elements.logCount.textContent = `${state.logs.length} 条`;

  if (!state.logs.length) {
    elements.logList.innerHTML = '<div class="emptyState"><strong>暂无调用日志</strong><p>通过 /api/gateway、/mcp 或账号测试产生请求后会显示在这里。</p></div>';
    return;
  }

  for (const log of state.logs) {
    const item = document.createElement('article');
    item.className = `logItem ${log.success ? 'success' : 'error'}`;
    const header = document.createElement('div');
    header.className = 'logHeader';
    const title = document.createElement('strong');
    const action = log.action ? ` · ${log.action}` : '';
    title.textContent = `${logTypeLabel(log.type)}${action} · ${log.method || '-'} ${log.path || '-'}`;
    const status = document.createElement('span');
    status.className = `statusPill ${log.success ? 'success' : 'warning'}`;
    status.textContent = `${log.success ? '成功' : '失败'} · HTTP ${log.statusCode || '-'}`;
    header.append(title, status);

    const meta = document.createElement('div');
    meta.className = 'metricRow';
    for (const [label, value] of [
      ['账号', log.accountName || log.accountId || '-'],
      ['耗时', `${log.durationMs ?? 0}ms`],
      ['时间', formatDateTime(log.createdAt)],
    ]) {
      const span = document.createElement('span');
      span.textContent = `${label} `;
      const strong = document.createElement('strong');
      strong.textContent = value;
      span.append(strong);
      meta.append(span);
    }
    item.append(header, meta);
    elements.logList.append(item);
  }
}

async function loadLogs({ silent = false } = {}) {
  if (!elements.logList) return;
  setLoading(true);
  try {
    const params = new URLSearchParams();
    if (elements.logTypeFilter?.value) params.set('type', elements.logTypeFilter.value);
    if (elements.logStatusFilter?.value) params.set('success', elements.logStatusFilter.value);
    if (elements.logAccountFilter?.value.trim()) params.set('accountId', elements.logAccountFilter.value.trim());
    if (elements.logLimit?.value) params.set('limit', elements.logLimit.value);
    const data = await requestJson(`/api/logs?${params}`);
    state.logs = data.logs;
    renderLogs();
    if (!silent) showMessage('调用日志已刷新。', 'success');
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
  if (elements.settingsAuditLogPath) elements.settingsAuditLogPath.value = settings.auditLogPath || '';
  if (elements.settingsUpdateMode) elements.settingsUpdateMode.value = settings.updateMode || 'disabled';
  if (elements.updateModeStatus) elements.updateModeStatus.textContent = settings.updateMode || 'disabled';
  if (elements.updateExecutorStatus) {
    const webhook = settings.updateWebhookConfigured ? 'webhook 已配置' : 'webhook 未配置';
    const command = settings.updateCommandConfigured ? 'command 已配置' : 'command 未配置';
    elements.updateExecutorStatus.textContent = `${webhook} / ${command}`;
  }
}

function renderUpdateInfo(info, { showDetails = false } = {}) {
  if (!elements.currentVersion) return;
  elements.currentVersion.textContent = info.current_version || info.version || '-';
  elements.latestVersion.textContent = info.latest_version || info.version || '-';
  elements.buildType.textContent = info.build_type || 'source';
  elements.updateState.textContent = info.has_update ? '有新版本' : (info.warning ? '检查受限' : '已是最新');
  if (elements.updateCommandBox && elements.updateCommands) {
    const commands = info.update_commands?.docker_compose_latest || info.update_commands?.source_deploy || [];
    elements.updateCommandBox.hidden = !commands.length;
    elements.updateCommands.textContent = commands.join('\n');
  }
  if (elements.updateResult) {
    elements.updateResult.hidden = !showDetails;
    elements.updateResult.textContent = showDetails ? JSON.stringify(info, null, 2) : '';
  }
}

async function loadSettings() {
  const data = await requestJson('/api/settings');
  renderSettings(data.settings);
}

async function checkUpdates({ force = false, silent = false } = {}) {
  if (!elements.currentVersion) return;
  const data = await requestJson(`/api/system/check-updates${force ? '?force=true' : ''}`);
  renderUpdateInfo(data, { showDetails: false });
  if (!silent) showMessage(data.has_update ? '发现新版本。' : '当前已是最新版本。', 'success');
}

async function initializeProtectedPage() {
  if (!getAdminToken()) {
    redirectToLogin();
    return;
  }

  try {
    await validateSession();
  } catch {
    clearAdminToken();
    redirectToLogin();
    return;
  }

  if (['dashboard', 'accounts'].includes(page)) {
    try {
      await loadAccounts({ silent: true });
    } catch (error) {
      showMessage(`登录成功，但账号池加载失败：${error.message}`, 'error');
    }
  }

  if (page === 'logs') {
    try {
      await loadLogs({ silent: true });
    } catch (error) {
      showMessage(`登录成功，但调用日志加载失败：${error.message}`, 'error');
    }
  }
}

function debounce(callback, delay = 120) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => callback(...args), delay);
  };
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
      await loadAccounts({ silent: true });
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });

  elements.refreshButton?.addEventListener('click', () => loadAccounts().catch((error) => showMessage(error.message, 'error')));
  elements.accountSearch?.addEventListener('input', debounce(renderAccounts));
  elements.accountFilter?.addEventListener('change', renderAccounts);

  elements.accountCards?.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;

    try {
      setLoading(true);
      if (button.dataset.toggle) {
        await requestJson(`/api/accounts/${button.dataset.toggle}`, { method: 'PATCH', body: JSON.stringify({ enabled: button.textContent === '启用' }) });
      }
      if (button.dataset.test) {
        const result = await requestJson(`/api/accounts/${button.dataset.test}/test`, { method: 'POST', body: JSON.stringify({ path: '/api/v2/libs/search?query=react' }) });
        renderAccountTestResult(result);
        showMessage(`账号测试完成：${result.account.name}，剩余额度 ${quotaLabel(result.account)}。`, result.success ? 'success' : 'error');
      }
      if (button.dataset.delete) {
        const confirmed = confirm('确认删除这个账号？此操作不可恢复。');
        if (!confirmed) return;
        await requestJson(`/api/accounts/${button.dataset.delete}`, { method: 'DELETE' });
      }
      await loadAccounts({ silent: true });
    } catch (error) {
      if (elements.accountTestResult) elements.accountTestResult.textContent = error.message;
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
      await loadAccounts({ silent: true });
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
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
      auditLogPath: elements.settingsAuditLogPath?.value.trim() || '',
      context7BaseUrl: elements.settingsContext7BaseUrl.value.trim(),
      encryptionKey: elements.settingsEncryptionKey.value.trim(),
      gatewayToken: elements.settingsGatewayToken.value.trim(),
      updateCommand: elements.settingsUpdateCommand?.value.trim() || '',
      updateMode: elements.settingsUpdateMode?.value || 'disabled',
      updateWebhookToken: elements.settingsUpdateWebhookToken?.value.trim() || '',
      updateWebhookUrl: elements.settingsUpdateWebhookUrl?.value.trim() || '',
    };

    try {
      const data = await requestJson('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
      if (payload.adminToken) setAdminToken(payload.adminToken);
      elements.settingsAdminToken.value = '';
      elements.settingsGatewayToken.value = '';
      elements.settingsEncryptionKey.value = '';
      if (elements.settingsUpdateCommand) elements.settingsUpdateCommand.value = '';
      if (elements.settingsUpdateWebhookToken) elements.settingsUpdateWebhookToken.value = '';
      renderSettings(data.settings);
      showMessage('设置已保存到 .env，并已同步生效。', 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    }
  });
}

function bindLogsPage() {
  elements.refreshLogsButton?.addEventListener('click', () => loadLogs().catch((error) => showMessage(error.message, 'error')));
  elements.logTypeFilter?.addEventListener('change', () => loadLogs().catch((error) => showMessage(error.message, 'error')));
  elements.logStatusFilter?.addEventListener('change', () => loadLogs().catch((error) => showMessage(error.message, 'error')));
  elements.logLimit?.addEventListener('change', () => loadLogs().catch((error) => showMessage(error.message, 'error')));
  elements.logAccountFilter?.addEventListener('input', debounce(() => loadLogs().catch((error) => showMessage(error.message, 'error')), 240));
}

async function initializeSecurityPage() {
  if (page !== 'security') return;
  try {
    await loadSettings();
    await checkUpdates({ silent: true });
  } catch (error) {
    showMessage(error.message, 'error');
  }
}

function bindUpdateControls() {
  elements.performUpdateButton?.addEventListener('click', async () => {
    try {
      setLoading(true);
      const info = await requestJson('/api/system/check-updates?force=true');
      renderUpdateInfo(info, { showDetails: false });
      if (!info.has_update) {
        showMessage('当前已是最新版本。', 'success');
        return;
      }
      const data = await requestJson('/api/system/update', { method: 'POST' });
      if (elements.updateResult) {
        elements.updateResult.hidden = false;
        elements.updateResult.textContent = JSON.stringify(data, null, 2);
      }
      showMessage(data.executed ? data.message : (data.need_restart ? '已生成更新命令，请在服务器执行或配置一键更新。' : data.message), 'success');
    } catch (error) {
      showMessage(error.message, 'error');
    } finally {
      setLoading(false);
    }
  });
}

document.querySelector(`[data-nav="${page}"]`)?.classList.add('active');
document.querySelector(`[data-nav="${page}"]`)?.setAttribute('aria-current', 'page');
bindDashboardPage();
bindAccountsPage();
bindLogsPage();
bindSecurityPage();
bindUpdateControls();
elements.logoutButton?.addEventListener('click', logout);
initializeProtectedPage();
initializeSecurityPage();
