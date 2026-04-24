import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

async function withServer(run, options) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withUpstream(run) {
  const requests = [];
  const upstream = await import('node:http').then(({ createServer: createHttpServer }) => createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    requests.push({
      authorization: request.headers.authorization,
      body: Buffer.concat(chunks).toString('utf8'),
      method: request.method,
      url: request.url,
    });
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'ratelimit-remaining': '42' });
    response.end(JSON.stringify({ ok: true }));
  }));

  await new Promise((resolve) => upstream.listen(0, resolve));
  const { port } = upstream.address();

  try {
    await run(`http://127.0.0.1:${port}`, requests);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
}

test('account API adds lists and leases accounts', async () => {
  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'api-account', token: 'api-secret-token' }),
    });
    const createdBody = await created.json();

    const listed = await fetch(`${baseUrl}/api/accounts`);
    const listedBody = await listed.json();

    const leased = await fetch(`${baseUrl}/api/leases`, { method: 'POST' });
    const leasedBody = await leased.json();

    assert.equal(created.status, 201);
    assert.equal(createdBody.account.remainingQuota, null);
    assert.equal(createdBody.account.tokenPreview, 'api-...oken');
    assert.equal(listedBody.accounts.length, 1);
    assert.equal(listedBody.accounts[0].remainingQuota, null);
    assert.equal(leased.status, 201);
    assert.equal(leasedBody.account.token, 'api-secret-token');
  });
});

test('gateway proxies requests with a pooled Context7 token and records success', async () => {
  await withUpstream(async (upstreamBaseUrl, upstreamRequests) => {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'gateway-account', token: 'ctx7sk-test-token' }),
      });

      const proxied = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          method: 'POST',
          path: '/resolve-library-id',
          body: { libraryName: 'react' },
        }),
      });
      const proxiedBody = await proxied.json();

      const accounts = await fetch(`${baseUrl}/api/accounts`).then((response) => response.json());

      assert.equal(proxied.status, 200);
      assert.deepEqual(proxiedBody.upstream, { ok: true });
      assert.equal(proxiedBody.account.name, 'gateway-account');
      assert.equal(proxiedBody.account.token, undefined);
      assert.equal(upstreamRequests[0].method, 'POST');
      assert.equal(upstreamRequests[0].url, '/resolve-library-id');
      assert.equal(upstreamRequests[0].authorization, 'Bearer ctx7sk-test-token');
      assert.equal(upstreamRequests[0].body, JSON.stringify({ libraryName: 'react' }));
      assert.equal(accounts.accounts[0].usageCount, 1);
      assert.equal(accounts.accounts[0].leasedCount, 1);
      assert.equal(accounts.accounts[0].failureCount, 0);
    }, { upstreamBaseUrl });
  });
});

test('account test proxies a request through the selected account and shows quota', async () => {
  await withUpstream(async (upstreamBaseUrl, upstreamRequests) => {
    await withServer(async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'single-test-account', token: 'ctx7sk-single-token' }),
      }).then((response) => response.json());

      const tested = await fetch(`${baseUrl}/api/accounts/${created.account.id}/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/api/v2/libs/search?query=react' }),
      });
      const testedBody = await tested.json();

      assert.equal(tested.status, 200);
      assert.equal(testedBody.account.id, created.account.id);
      assert.equal(testedBody.account.remainingQuota, 42);
      assert.equal(testedBody.upstream.ok, true);
      assert.equal(upstreamRequests[0].authorization, 'Bearer ctx7sk-single-token');
    }, { upstreamBaseUrl });
  });
});

test('gateway records failures from upstream responses', async () => {
  const failingUpstream = await import('node:http').then(({ createServer: createHttpServer }) => createHttpServer((request, response) => {
    response.writeHead(429, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'rate limited' }));
  }));
  await new Promise((resolve) => failingUpstream.listen(0, resolve));
  const { port } = failingUpstream.address();

  try {
    await withServer(async (baseUrl) => {
      await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'limited-account', token: 'ctx7sk-limited-token' }),
      });

      const proxied = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '/resolve-library-id' }),
      });
      const accounts = await fetch(`${baseUrl}/api/accounts`).then((response) => response.json());

      assert.equal(proxied.status, 502);
      assert.equal(accounts.accounts[0].usageCount, 1);
      assert.equal(accounts.accounts[0].failureCount, 1);
      assert.match(accounts.accounts[0].lastError, /Context7 upstream returned 429/);
    }, { upstreamBaseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => failingUpstream.close(resolve));
  }
});
