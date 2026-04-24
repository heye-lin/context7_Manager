import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';

async function withServer(options, run) {
  const server = createServer(options);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function writeEnv(path, adminToken, gatewayToken) {
  await writeFile(path, [
    `ADMIN_TOKEN=${adminToken}`,
    `GATEWAY_TOKEN=${gatewayToken}`,
    'ENCRYPTION_KEY=env-test-encryption-key',
    'CONTEXT7_BASE_URL=https://context7.com',
    '',
  ].join('\n'), 'utf8');
}

test('admin and gateway tokens are read from env file and changes sync without restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context7-env-'));
  const envPath = join(dir, '.env');
  await writeEnv(envPath, 'admin-one', 'gateway-one');

  const upstream = await import('node:http').then(({ createServer: createHttpServer }) => createHttpServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true }));
  }));
  await new Promise((resolve) => upstream.listen(0, resolve));
  const { port } = upstream.address();

  try {
    await withServer({
      envPath,
      encryptionKey: 'env-test-encryption-key',
      upstreamBaseUrl: `http://127.0.0.1:${port}`,
    }, async (baseUrl) => {
      const firstSession = await fetch(`${baseUrl}/api/session`, { headers: { authorization: 'Bearer admin-one' } });
      assert.equal(firstSession.status, 200);

      await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin-one', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'env-account', token: 'ctx7sk-env-token' }),
      });

      const firstGateway = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: { authorization: 'Bearer gateway-one', 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'GET', path: '/api/v2/libs/search?query=react' }),
      });
      assert.equal(firstGateway.status, 200);

      await writeEnv(envPath, 'admin-two', 'gateway-two');

      const oldSession = await fetch(`${baseUrl}/api/session`, { headers: { authorization: 'Bearer admin-one' } });
      const newSession = await fetch(`${baseUrl}/api/session`, { headers: { authorization: 'Bearer admin-two' } });
      assert.equal(oldSession.status, 401);
      assert.equal(newSession.status, 200);

      const oldGateway = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: { authorization: 'Bearer gateway-one', 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'GET', path: '/api/v2/libs/search?query=react' }),
      });
      const newGateway = await fetch(`${baseUrl}/api/gateway`, {
        method: 'POST',
        headers: { authorization: 'Bearer gateway-two', 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'GET', path: '/api/v2/libs/search?query=react' }),
      });
      assert.equal(oldGateway.status, 401);
      assert.equal(newGateway.status, 200);
    });
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
    await rm(dir, { force: true, recursive: true });
  }
});
