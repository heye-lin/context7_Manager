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

test('serves separate pages for each console feature', async () => {
  await withServer(async (baseUrl) => {
    const pages = [
      ['/', '访问控制台'],
      ['/dashboard.html', '运行总览'],
      ['/accounts.html', '账号池管理'],
      ['/gateway.html', '网关调试'],
      ['/security.html', '安全设置'],
    ];

    for (const [path, expectedText] of pages) {
      const response = await fetch(`${baseUrl}${path}`);
      const html = await response.text();

      assert.equal(response.status, 200, path);
      assert.match(html, new RegExp(expectedText), path);
      assert.match(html, /data-page=/, path);
    }
  });
});
