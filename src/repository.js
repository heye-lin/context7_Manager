import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function clone(value) {
  return structuredClone(value);
}

async function readJsonFile(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tempPath, path);
}

export function createMemoryAccountRepository(initialAccounts = []) {
  const accounts = new Map(initialAccounts.map((account) => [account.id, clone(account)]));

  return {
    async addAccount(account) {
      accounts.set(account.id, clone(account));
      return clone(account);
    },
    async deleteAccount(id) {
      accounts.delete(id);
    },
    async getAccount(id) {
      const account = accounts.get(id);
      return account ? clone(account) : null;
    },
    async listAccounts() {
      return [...accounts.values()].map(clone);
    },
    async updateAccount(account) {
      accounts.set(account.id, clone(account));
      return clone(account);
    },
  };
}

export function createFileAccountRepository(path) {
  async function listRawAccounts() {
    const data = await readJsonFile(path, { accounts: [] });
    return Array.isArray(data.accounts) ? data.accounts : [];
  }

  async function saveRawAccounts(accounts) {
    await writeJsonFile(path, { accounts });
  }

  return {
    async addAccount(account) {
      const accounts = await listRawAccounts();
      accounts.push(clone(account));
      await saveRawAccounts(accounts);
      return clone(account);
    },
    async deleteAccount(id) {
      const accounts = await listRawAccounts();
      await saveRawAccounts(accounts.filter((account) => account.id !== id));
    },
    async getAccount(id) {
      const accounts = await listRawAccounts();
      const account = accounts.find((entry) => entry.id === id);
      return account ? clone(account) : null;
    },
    async listAccounts() {
      return (await listRawAccounts()).map(clone);
    },
    async updateAccount(account) {
      const accounts = await listRawAccounts();
      const index = accounts.findIndex((entry) => entry.id === account.id);
      if (index === -1) {
        accounts.push(clone(account));
      } else {
        accounts[index] = clone(account);
      }
      await saveRawAccounts(accounts);
      return clone(account);
    },
  };
}

function sanitizeAuditEvent(event = {}) {
  const { token, tokenCiphertext, ...safeEvent } = event;
  return {
    id: safeEvent.id || randomUUID(),
    createdAt: safeEvent.createdAt || new Date().toISOString(),
    type: safeEvent.type || (safeEvent.method === 'MCP' ? 'mcp' : 'gateway'),
    ...safeEvent,
  };
}

function filterAuditEvents(events, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
  return events
    .filter((event) => !query.accountId || event.accountId === query.accountId)
    .filter((event) => query.success === undefined || event.success === query.success)
    .filter((event) => !query.type || event.type === query.type)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit)
    .map(clone);
}

export function createMemoryAuditLogger({ retention = 1000 } = {}) {
  const events = [];

  return {
    async list(query = {}) {
      return filterAuditEvents(events, query);
    },
    async record(event) {
      events.push(sanitizeAuditEvent(event));
      if (events.length > retention) {
        events.splice(0, events.length - retention);
      }
    },
  };
}

export function createFileAuditLogger(path, { retention = 2000 } = {}) {
  async function listRawEvents() {
    const data = await readJsonFile(path, { events: [] });
    return Array.isArray(data.events) ? data.events : [];
  }

  async function saveRawEvents(events) {
    await writeJsonFile(path, { events });
  }

  return {
    async list(query = {}) {
      return filterAuditEvents(await listRawEvents(), query);
    },
    async record(event) {
      const events = await listRawEvents();
      events.push(sanitizeAuditEvent(event));
      await saveRawEvents(events.slice(-retention));
    },
  };
}
