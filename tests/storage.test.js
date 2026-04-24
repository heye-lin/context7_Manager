import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../src/server.js';
import { createFileAccountRepository, createFileAuditLogger } from '../src/repository.js';

async function withServer(options, run) {
  const server = createServer({
    adminToken: 'storage-admin-token',
    encryptionKey: 'storage-encryption-secret',
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
    authorization: 'Bearer storage-admin-token',
    'content-type': 'application/json',
  };
}

test('file repository persists encrypted accounts across server restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context7-store-'));
  const storePath = join(dir, 'accounts.json');

  try {
    await withServer({ repository: createFileAccountRepository(storePath) }, async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/accounts`, {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ name: 'persisted', token: 'ctx7sk-persisted-secret' }),
      });

      assert.equal(created.status, 201);
    });

    const fileContent = await readFile(storePath, 'utf8');
    assert.doesNotMatch(fileContent, /ctx7sk-persisted-secret/);
    assert.match(fileContent, /tokenCiphertext/);

    await withServer({ repository: createFileAccountRepository(storePath) }, async (baseUrl) => {
      const listed = await fetch(`${baseUrl}/api/accounts`, { headers: adminHeaders() });
      const listedBody = await listed.json();

      assert.equal(listed.status, 200);
      assert.equal(listedBody.accounts.length, 1);
      assert.equal(listedBody.accounts[0].name, 'persisted');
      assert.equal(listedBody.accounts[0].tokenPreview, 'ctx7...cret');
      assert.equal(listedBody.accounts[0].token, undefined);
      assert.equal(listedBody.accounts[0].tokenCiphertext, undefined);
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('file audit logger serializes concurrent writes without corrupting json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context7-audit-race-'));
  const auditPath = join(dir, 'audit-logs.json');

  try {
    const logger = createFileAuditLogger(auditPath, { retention: 500 });
    await Promise.all(Array.from({ length: 120 }, (_, index) => logger.record({
      index,
      method: 'GET',
      path: `/race/${index}`,
      success: true,
      type: 'race',
    })));

    const content = await readFile(auditPath, 'utf8');
    const parsed = JSON.parse(content);

    assert.equal(parsed.events.length, 120);
    assert.equal(new Set(parsed.events.map((event) => event.index)).size, 120);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test('file audit logger backs up corrupt log files and continues', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context7-audit-corrupt-'));
  const auditPath = join(dir, 'audit-logs.json');

  try {
    await writeFile(auditPath, '{"events":[]}}\n', 'utf8');
    const logger = createFileAuditLogger(auditPath);

    const logs = await logger.list();
    await logger.record({ method: 'GET', path: '/after-corrupt', success: true, type: 'system' });
    const files = await readdir(dir);
    const content = await readFile(auditPath, 'utf8');
    const parsed = JSON.parse(content);

    assert.deepEqual(logs, []);
    assert.ok(files.some((file) => file.startsWith('audit-logs.json.bak-')));
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].path, '/after-corrupt');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
