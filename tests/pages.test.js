import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

async function withServer(run) {
  const server = createServer({
    adminToken: 'pages-admin-token',
    encryptionKey: 'pages-encryption-key',
    gatewayToken: 'pages-gateway-token',
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('serves console pages without a standalone gateway page', async () => {
  await withServer(async (baseUrl) => {
    const pages = [
      ['/', '访问控制台'],
      ['/dashboard.html', '运行总览'],
      ['/accounts.html', '账号池管理'],
      ['/security.html', '安全设置'],
      ['/logs.html', '调用日志'],
    ];

    for (const [path, expectedText] of pages) {
      const response = await fetch(`${baseUrl}${path}`);
      const html = await response.text();

      assert.equal(response.status, 200, path);
      assert.match(html, new RegExp(expectedText), path);
      assert.match(html, /data-page=/, path);
      if (path === '/') {
        assert.match(html, /styles\.css\?v=login-spacing-v2/);
        assert.match(html, /<form id="loginForm" class="stackForm loginForm">[\s\S]*id="loginButton"/);
      }
      if (path !== '/') assert.match(html, /id="logoutButton"/, path);
      assert.doesNotMatch(html, /href="\/gateway\.html"/, path);
    }

    const gatewayPage = await fetch(`${baseUrl}/gateway.html`);
    assert.equal(gatewayPage.status, 404);
  });
});

test('logs page exposes audit log filters and list container', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/logs.html`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /调用日志/);
    assert.match(html, /id="logList"/);
    assert.match(html, /id="logTypeFilter"/);
    assert.match(html, /id="refreshLogsButton"/);
    assert.match(html, /data-nav="logs"/);
    assert.match(html, /登录会话/);
    assert.match(html, /账号管理/);
    assert.match(html, /账号测试/);
    assert.match(html, /配置变更/);
    assert.match(html, /版本更新/);
    assert.match(html, /系统错误/);
  });
});

test('accounts page manages accounts and includes account test controls', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/accounts.html`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /账号池管理/);
    assert.match(html, /id="accountForm"/);
    assert.match(html, /id="accountTestResult"/);
    assert.match(html, /账号测试结果/);
    assert.doesNotMatch(html, /网关调试/);
    assert.doesNotMatch(html, /id="accountTestAuthForm"/);
    assert.doesNotMatch(html, /id="accountTestForm"/);
  });
});

test('security page keeps env controls and explains mcp gateway access', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/security.html`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /修改服务端配置/);
    assert.match(html, /settingsForm/);
    assert.match(html, /id="performUpdateButton"/);
    assert.match(html, /id="updateCommandBox"/);
    assert.match(html, /id="updateCommands"/);
    assert.match(html, /id="settingsUpdateMode"/);
    assert.match(html, /id="settingsUpdateWebhookUrl"/);
    assert.match(html, /id="settingsUpdateCommand"/);
    assert.match(html, /检查并更新/);
    assert.match(html, /版本更新/);
    assert.match(html, /id="logoutButton"/);
    assert.match(html, /MCP 网关接入/);
    assert.match(html, /Authorization: Bearer &lt;GATEWAY_TOKEN&gt;/);
    assert.match(html, /codeGrid/);
    assert.match(html, /fieldHint/);
    assert.match(html, /\/mcp/);
    assert.doesNotMatch(html, /前端访问令牌/);
    assert.doesNotMatch(html, /API 网关令牌/);
    assert.doesNotMatch(html, /authForm/);
  });
});

test('static assets use browser cache headers', async () => {
  await withServer(async (baseUrl) => {
    const script = await fetch(`${baseUrl}/app.js`);
    const styles = await fetch(`${baseUrl}/styles.css`);
    const favicon = await fetch(`${baseUrl}/favicon.svg`);
    const html = await fetch(`${baseUrl}/accounts.html`);

    assert.equal(script.status, 200);
    assert.equal(styles.status, 200);
    assert.equal(favicon.status, 200);
    assert.match(script.headers.get('cache-control'), /max-age=300/);
    assert.match(styles.headers.get('cache-control'), /max-age=300/);
    assert.match(favicon.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(html.headers.get('cache-control'), /no-store/);
  });
});

test('static server blocks traversal outside public directory', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/..%2Fpackage.json`);

    assert.equal(response.status, 404);
  });
});
