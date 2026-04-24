import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountPool } from '../src/pool.js';

test('adds accounts and masks secrets when listing', () => {
  const pool = createAccountPool();

  const account = pool.addAccount({ name: 'main', token: 'ctx7-secret-token' });
  const listed = pool.listAccounts();

  assert.equal(account.name, 'main');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].tokenPreview, 'ctx7...oken');
  assert.equal('token' in listed[0], false);
});

test('leases enabled healthy accounts by least usage', () => {
  const pool = createAccountPool();
  const first = pool.addAccount({ name: 'first', token: 'token-first' });
  const second = pool.addAccount({ name: 'second', token: 'token-second' });

  pool.recordUsage(first.id, { success: true });
  const lease = pool.leaseAccount();

  assert.equal(lease.account.id, second.id);
  assert.equal(lease.account.token, 'token-second');
  assert.equal(pool.getAccount(second.id).leasedCount, 1);
});

test('skips disabled accounts and records failures', () => {
  const pool = createAccountPool();
  const disabled = pool.addAccount({ name: 'disabled', token: 'disabled-token' });
  const active = pool.addAccount({ name: 'active', token: 'active-token' });

  pool.updateAccount(disabled.id, { enabled: false });
  pool.recordUsage(active.id, { success: false, error: 'rate limited' });
  const lease = pool.leaseAccount();

  assert.equal(lease.account.id, active.id);
  assert.equal(pool.getAccount(active.id).failureCount, 1);
  assert.equal(pool.getAccount(active.id).lastError, 'rate limited');
});

test('throws when no account is available', () => {
  const pool = createAccountPool();
  const account = pool.addAccount({ name: 'only', token: 'token-only' });

  pool.updateAccount(account.id, { enabled: false });

  assert.throws(() => pool.leaseAccount(), /No available Context7 account/);
});
