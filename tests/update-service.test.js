import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { createUpdateService } from '../src/update-service.js';

async function withServer(options, run) {
  const server = createServer({
    adminToken: 'update-admin-token',
    encryptionKey: 'update-encryption-key',
    ...options,
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function adminHeaders() {
  return {
    authorization: 'Bearer update-admin-token',
    'content-type': 'application/json',
  };
}

test('system update APIs require admin auth and expose version workflow', async () => {
  const calls = [];
  const updateService = {
    async version() {
      calls.push('version');
      return '0.1.0';
    },
    async check({ force } = {}) {
      calls.push(force ? 'check-force' : 'check');
      return { build_type: 'source', cached: false, current_version: '0.1.0', has_update: true, latest_version: '0.2.0' };
    },
    async performUpdate() {
      calls.push('update');
      return { message: 'Use release package', need_restart: false };
    },
  };

  await withServer({ updateService }, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/api/system/check-updates`);
    assert.equal(unauthorized.status, 401);

    const version = await fetch(`${baseUrl}/api/system/version`, { headers: adminHeaders() });
    assert.deepEqual(await version.json(), { version: '0.1.0' });

    const check = await fetch(`${baseUrl}/api/system/check-updates?force=true`, { headers: adminHeaders() });
    const checkBody = await check.json();
    assert.equal(check.status, 200);
    assert.equal(checkBody.has_update, true);

    const updated = await fetch(`${baseUrl}/api/system/update`, { method: 'POST', headers: adminHeaders() });
    const updatedBody = await updated.json();
    assert.equal(updated.status, 200);
    assert.equal(updatedBody.need_restart, false);
    assert.deepEqual(calls, ['version', 'check-force', 'update']);
  });
});

test('update service returns cached-style warning when GitHub release check fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try {
    const service = createUpdateService({ currentVersion: '0.1.0', repository: 'owner/repo' });
    const info = await service.check({ force: true });
    assert.equal(info.current_version, '0.1.0');
    assert.equal(info.has_update, false);
    assert.match(info.warning, /GitHub releases returned 404/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
