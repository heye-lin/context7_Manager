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

export function createMemoryAuditLogger() {
  const events = [];

  return {
    async list() {
      return events.map(clone);
    },
    async record(event) {
      events.push(clone(event));
    },
  };
}
