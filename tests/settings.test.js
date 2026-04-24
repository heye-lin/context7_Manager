import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('settings API visualizes and updates personal gateway env configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context7-settings-'));
  const envPath = join(dir, '.env');
  await writeFile(envPath, [
    'PORT=3000',
    'ADMIN_TOKEN=admin-current-secret',
    'GATEWAY_TOKEN=gateway-current-secret',
    'ENCRYPTION_KEY=encryption-current-secret',
    'CONTEXT7_BASE_URL=https://context7.com',
    'UPDATE_MODE=disabled',
    'ACCOUNT_STORE_PATH=data/accounts.json',
    '',
  ].join('\n'), 'utf8');

  try {
    await withServer({ envPath, encryptionKey: 'encryption-current-secret' }, async (baseUrl) => {
      const listed = await fetch(`${baseUrl}/api/settings`, {
        headers: { authorization: 'Bearer admin-current-secret' },
      });
      const listedBody = await listed.json();

      assert.equal(listed.status, 200);
      assert.equal(listedBody.settings.mode, 'personal');
      assert.equal(listedBody.settings.adminTokenPreview, 'admi...cret');
      assert.equal(listedBody.settings.gatewayTokenPreview, 'gate...cret');
      assert.equal(listedBody.settings.encryptionKeyConfigured, true);
      assert.equal(listedBody.settings.context7BaseUrl, 'https://context7.com');
      assert.equal(listedBody.settings.accountStorePath, 'data/accounts.json');
      assert.equal(listedBody.settings.updateMode, 'disabled');
      assert.equal(listedBody.settings.updateWebhookConfigured, false);
      assert.equal(listedBody.settings.updateCommandConfigured, false);
      assert.equal(JSON.stringify(listedBody).includes('admin-current-secret'), false);

      const updated = await fetch(`${baseUrl}/api/settings`, {
        method: 'PATCH',
        headers: { authorization: 'Bearer admin-current-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          adminToken: 'admin-updated-secret',
          gatewayToken: 'gateway-updated-secret',
          context7BaseUrl: 'https://context7.com',
          accountStorePath: 'data/updated-accounts.json',
          updateCommand: '/opt/context7/update.sh',
          updateMode: 'command',
          updateWebhookToken: 'webhook-token-secret',
          updateWebhookUrl: 'https://deploy.example.com/context7',
        }),
      });

      assert.equal(updated.status, 200);
      const envContent = await readFile(envPath, 'utf8');
      assert.match(envContent, /ADMIN_TOKEN=admin-updated-secret/);
      assert.match(envContent, /GATEWAY_TOKEN=gateway-updated-secret/);
      assert.match(envContent, /ACCOUNT_STORE_PATH=data\/updated-accounts\.json/);
      assert.match(envContent, /UPDATE_COMMAND=\/opt\/context7\/update\.sh/);
      assert.match(envContent, /UPDATE_MODE=command/);
      assert.match(envContent, /UPDATE_WEBHOOK_TOKEN=webhook-token-secret/);
      assert.match(envContent, /UPDATE_WEBHOOK_URL=https:\/\/deploy\.example\.com\/context7/);

      const oldSession = await fetch(`${baseUrl}/api/session`, {
        headers: { authorization: 'Bearer admin-current-secret' },
      });
      const newSession = await fetch(`${baseUrl}/api/session`, {
        headers: { authorization: 'Bearer admin-updated-secret' },
      });

      assert.equal(oldSession.status, 401);
      assert.equal(newSession.status, 200);
    });
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
