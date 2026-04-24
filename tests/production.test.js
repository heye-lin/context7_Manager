import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

async function withServer(run, options = {}) {
  const server = createServer({
    adminToken: 'test-admin-token',
    encryptionKey: '0123456789abcdef0123456789abcdef',
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
    authorization: 'Bearer test-admin-token',
    'content-type': 'application/json',
  };
}

function gatewayHeaders() {
  return {
    authorization: 'Bearer test-gateway-token',
    'content-type': 'application/json',
  };
}

test('health endpoints are public and include readiness state', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/healthz`);
    const ready = await fetch(`${baseUrl}/readyz`);

    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true, storage: 'ready' });
  });
});

test('admin APIs require bearer authentication', async () => {
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/api/accounts`);
    const wrongToken = await fetch(`${baseUrl}/api/accounts`, {
      headers: { authorization: 'Bearer wrong' },
    });

    assert.equal(unauthenticated.status, 401);
    assert.equal(wrongToken.status, 401);
  });
});

test('session endpoint validates admin tokens for the web console', async () => {
  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/api/session`);
    const authenticated = await fetch(`${baseUrl}/api/session`, { headers: adminHeaders() });

    assert.equal(unauthenticated.status, 401);
    assert.equal(authenticated.status, 200);
    assert.deepEqual(await authenticated.json(), { ok: true, role: 'admin' });
  });
});

test('gateway API can require a separate gateway token', async () => {
  const upstream = await import('node:http').then(({ createServer: createHttpServer }) => createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true }));
  }));
  await new Promise((resolve) => upstream.listen(0, resolve));
  const { port } = upstream.address();

  try {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name: 'gateway-token-account', token: 'ctx7sk-gateway-token' }),
      });

      const noToken = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/api/v2/libs/search?query=react', method: 'GET' }),
      });
      const adminToken = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ path: '/api/v2/libs/search?query=react', method: 'GET' }),
      });
      const gatewayToken = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ path: '/api/v2/libs/search?query=react', method: 'GET' }),
      });

      assert.equal(noToken.status, 401);
      assert.equal(adminToken.status, 401);
      assert.equal(gatewayToken.status, 200);
    }, { gatewayToken: 'test-gateway-token', upstreamBaseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('accounts are encrypted at rest and never list raw tokens', async () => {
  const storedAccounts = new Map();
  const repository = {
    async addAccount(account) {
      storedAccounts.set(account.id, structuredClone(account));
      return structuredClone(account);
    },
    async deleteAccount(id) {
      storedAccounts.delete(id);
    },
    async getAccount(id) {
      return structuredClone(storedAccounts.get(id));
    },
    async listAccounts() {
      return [...storedAccounts.values()].map((account) => structuredClone(account));
    },
    async updateAccount(account) {
      storedAccounts.set(account.id, structuredClone(account));
      return structuredClone(account);
    },
  };

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ name: 'secure-account', token: 'ctx7sk-super-secret' }),
    });
    const createdBody = await created.json();
    const stored = storedAccounts.get(createdBody.account.id);

    const listed = await fetch(`${baseUrl}/api/accounts`, { headers: adminHeaders() });
    const listedBody = await listed.json();

    assert.equal(created.status, 201);
    assert.notEqual(stored.tokenCiphertext, 'ctx7sk-super-secret');
    assert.equal(stored.token, undefined);
    assert.equal(listedBody.accounts[0].token, undefined);
    assert.equal(listedBody.accounts[0].tokenCiphertext, undefined);
    assert.equal(listedBody.accounts[0].tokenPreview, 'ctx7...cret');
  }, { repository });
});

test('gateway writes audit logs without storing raw tokens', async () => {
  const auditEvents = [];
  const auditLogger = {
    async record(event) {
      auditEvents.push(structuredClone(event));
    },
  };
  const upstream = await import('node:http').then(({ createServer: createHttpServer }) => createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true }));
  }));
  await new Promise((resolve) => upstream.listen(0, resolve));
  const { port } = upstream.address();

  try {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name: 'audited-account', token: 'ctx7sk-audit-token' }),
      });

      const proxied = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ path: '/api/v2/libs/search?query=react', method: 'GET' }),
      });

      assert.equal(proxied.status, 200);
      assert.equal(auditEvents.length, 1);
      assert.equal(auditEvents[0].accountName, 'audited-account');
      assert.equal(auditEvents[0].statusCode, 200);
      assert.equal(auditEvents[0].success, true);
      assert.equal(auditEvents[0].token, undefined);
      assert.equal(auditEvents[0].tokenCiphertext, undefined);
      assert.ok(auditEvents[0].durationMs >= 0);
    }, { auditLogger, upstreamBaseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});
