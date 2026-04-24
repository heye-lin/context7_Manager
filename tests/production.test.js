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

test('mcp endpoint forwards JSON-RPC requests through a pooled Context7 key', async () => {
  const upstreamRequests = [];
  const mcpUpstream = await import('node:http').then(({ createServer: createHttpServer }) => createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    upstreamRequests.push({
      apiKey: request.headers.context7_api_key,
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
      contentType: request.headers['content-type'],
      method: request.method,
      url: request.url,
    });
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'ratelimit-remaining': '17' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } }));
  }));
  await new Promise((resolve) => mcpUpstream.listen(0, resolve));
  const { port } = mcpUpstream.address();

  try {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name: 'mcp-account', token: 'ctx7sk-mcp-token' }),
      });

      const noToken = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const proxied = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: gatewayHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      const proxiedBody = await proxied.json();
      const accounts = await fetch(`${baseUrl}/api/accounts`, { headers: adminHeaders() }).then((response) => response.json());

      assert.equal(noToken.status, 401);
      assert.equal(proxied.status, 200);
      assert.deepEqual(proxiedBody, { jsonrpc: '2.0', id: 1, result: { tools: [] } });
      assert.equal(upstreamRequests[0].method, 'POST');
      assert.equal(upstreamRequests[0].url, '/mcp');
      assert.equal(upstreamRequests[0].apiKey, 'ctx7sk-mcp-token');
      assert.equal(upstreamRequests[0].authorization, undefined);
      assert.equal(upstreamRequests[0].body, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
      assert.equal(accounts.accounts[0].remainingQuota, 17);
    }, { gatewayToken: 'test-gateway-token', mcpBaseUrl: `http://127.0.0.1:${port}/mcp` });
  } finally {
    await new Promise((resolve) => mcpUpstream.close(resolve));
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
    async list() {
      return auditEvents.map((event) => structuredClone(event));
    },
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
      const gatewayEvent = auditEvents.find((event) => event.type === 'gateway');
      assert.ok(auditEvents.some((event) => event.type === 'account' && event.action === 'create'));
      assert.equal(gatewayEvent.accountName, 'audited-account');
      assert.equal(gatewayEvent.statusCode, 200);
      assert.equal(gatewayEvent.success, true);
      assert.equal(gatewayEvent.token, undefined);
      assert.equal(gatewayEvent.tokenCiphertext, undefined);
      assert.ok(gatewayEvent.durationMs >= 0);

      const logs = await fetch(`${baseUrl}/api/logs?type=gateway`, { headers: adminHeaders() });
      const logsBody = await logs.json();
      assert.equal(logs.status, 200);
      assert.equal(logsBody.logs.filter((event) => event.type === 'gateway').length, 1);
      assert.equal(logsBody.logs[0].accountName, 'audited-account');
      assert.equal(logsBody.logs[0].token, undefined);
    }, { auditLogger, upstreamBaseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('system actions write unified audit logs', async () => {
  const auditEvents = [];
  const auditLogger = {
    async list(query = {}) {
      return auditEvents
        .filter((event) => !query.type || event.type === query.type)
        .map((event) => structuredClone(event));
    },
    async record(event) {
      auditEvents.push(structuredClone(event));
    },
  };
  const updateService = {
    async version() {
      return { current_version: '1.0.0' };
    },
    async check() {
      return { current_version: '1.0.0', has_update: true, latest_version: '1.0.1' };
    },
    async performUpdate() {
      return { current_version: '1.0.0', has_update: true, latest_version: '1.0.1', updated: true };
    },
  };
  const envConfig = {
    get() {
      return undefined;
    },
    set() {},
  };
  const upstream = await import('node:http').then(({ createServer: createHttpServer }) => createHttpServer((request, response) => {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'ratelimit-remaining': '42',
    });
    response.end(JSON.stringify({ ok: true }));
  }));
  await new Promise((resolve) => upstream.listen(0, resolve));
  const { port } = upstream.address();

  try {
    await withServer(async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name: 'system-log-account', token: 'ctx7sk-system-log-token' }),
      }).then((response) => response.json());

      await fetch(`${baseUrl}/api/accounts/${created.account.id}/test`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ path: '/api/v2/libs/search?query=react' }),
      });
      await fetch(`${baseUrl}/api/leases`, { method: 'POST', headers: adminHeaders() });
      await fetch(`${baseUrl}/api/accounts/${created.account.id}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ enabled: false }),
      });
      await fetch(`${baseUrl}/api/session`, { headers: adminHeaders() });
      await fetch(`${baseUrl}/api/settings`, { headers: adminHeaders() });
      await fetch(`${baseUrl}/api/system/version`, { headers: adminHeaders() });
      await fetch(`${baseUrl}/api/accounts`, { headers: adminHeaders() });
      await fetch(`${baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ context7BaseUrl: 'https://context7.com' }),
      });
      await fetch(`${baseUrl}/api/system/check-updates?force=true`, { headers: adminHeaders() });
      await fetch(`${baseUrl}/api/system/update`, { method: 'POST', headers: adminHeaders() });
      await fetch(`${baseUrl}/api/not-found`, { headers: adminHeaders() });

      assert.ok(auditEvents.some((event) => event.type === 'account' && event.action === 'create'));
      assert.ok(auditEvents.some((event) => event.type === 'account' && event.action === 'update'));
      assert.ok(auditEvents.some((event) => event.type === 'account' && event.action === 'list'));
      assert.ok(auditEvents.some((event) => event.type === 'account-test' && event.success === true && event.statusCode === 200 && event.method === 'GET' && event.path.includes('/api/v2/libs/search')));
      assert.ok(auditEvents.some((event) => event.type === 'auth' && event.action === 'session'));
      assert.ok(auditEvents.some((event) => event.type === 'lease' && event.action === 'create'));
      assert.ok(auditEvents.some((event) => event.type === 'settings' && event.action === 'read'));
      assert.ok(auditEvents.some((event) => event.type === 'settings' && event.action === 'update'));
      assert.ok(auditEvents.some((event) => event.type === 'update' && event.action === 'version'));
      assert.ok(auditEvents.some((event) => event.type === 'update' && event.action === 'check'));
      assert.ok(auditEvents.some((event) => event.type === 'update' && event.action === 'perform'));
      assert.ok(auditEvents.some((event) => event.type === 'error' && event.statusCode === 404));
      assert.equal(auditEvents.some((event) => event.token || event.tokenCiphertext), false);

      const accountTestLogs = await fetch(`${baseUrl}/api/logs?type=account-test`, { headers: adminHeaders() }).then((response) => response.json());
      assert.equal(accountTestLogs.logs.length, 1);
      assert.equal(accountTestLogs.logs[0].accountName, 'system-log-account');
    }, {
      auditLogger,
      envConfig,
      updateService,
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
    });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
});
