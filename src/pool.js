import { randomUUID } from 'node:crypto';

function now() {
  return new Date().toISOString();
}

function maskToken(token) {
  if (token.length <= 8) {
    return '••••';
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function toPublicAccount(account) {
  const { token, ...publicAccount } = account;
  return {
    ...publicAccount,
    tokenPreview: maskToken(token),
  };
}

function createPoolError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeRemainingQuota(value) {
  if (value === undefined || value === null || value === '') return null;
  const quota = Number(value);
  if (!Number.isFinite(quota) || quota < 0) {
    throw createPoolError('Remaining quota must be a non-negative number');
  }
  return quota;
}

export function createAccountPool(initialAccounts = []) {
  const accounts = new Map();
  const auditEvents = [];

  function getRequiredAccount(id) {
    const account = accounts.get(id);
    if (!account) {
      throw createPoolError('Context7 account not found', 404);
    }
    return account;
  }

  function listAccounts() {
    return [...accounts.values()].map(toPublicAccount);
  }

  function addAccount(input) {
    const name = input?.name?.trim();
    const token = input?.token?.trim();

    if (!name) {
      throw createPoolError('Account name is required');
    }
    if (!token) {
      throw createPoolError('Context7 token is required');
    }

    const account = {
      id: randomUUID(),
      name,
      token,
      enabled: input.enabled ?? true,
      usageCount: 0,
      leasedCount: 0,
      failureCount: 0,
      remainingQuota: normalizeRemainingQuota(input.remainingQuota),
      lastUsedAt: null,
      lastError: null,
      createdAt: now(),
      updatedAt: now(),
    };

    accounts.set(account.id, account);
    return toPublicAccount(account);
  }

  function getAccount(id) {
    return toPublicAccount(getRequiredAccount(id));
  }

  function updateAccount(id, changes) {
    const account = getRequiredAccount(id);

    if (typeof changes.name === 'string' && changes.name.trim()) {
      account.name = changes.name.trim();
    }
    if (typeof changes.token === 'string' && changes.token.trim()) {
      account.token = changes.token.trim();
    }
    if (typeof changes.enabled === 'boolean') {
      account.enabled = changes.enabled;
    }
    if ('remainingQuota' in changes) {
      account.remainingQuota = normalizeRemainingQuota(changes.remainingQuota);
    }
    account.updatedAt = now();

    return toPublicAccount(account);
  }

  function deleteAccount(id) {
    getRequiredAccount(id);
    accounts.delete(id);
  }

  function leaseAccount(id) {
    if (id) {
      const selected = getRequiredAccount(id);
      if (!selected.enabled) {
        throw createPoolError('Selected Context7 account is disabled', 503);
      }
      selected.leasedCount += 1;
      selected.updatedAt = now();
      return {
        leaseId: randomUUID(),
        account: {
          id: selected.id,
          name: selected.name,
          token: selected.token,
        },
      };
    }

    const availableAccounts = [...accounts.values()]
      .filter((account) => account.enabled)
      .sort((left, right) => {
        if (left.failureCount !== right.failureCount) {
          return left.failureCount - right.failureCount;
        }
        if (left.usageCount !== right.usageCount) {
          return left.usageCount - right.usageCount;
        }
        return left.createdAt.localeCompare(right.createdAt);
      });

    const account = availableAccounts[0];
    if (!account) {
      throw createPoolError('No available Context7 account', 503);
    }

    account.leasedCount += 1;
    account.updatedAt = now();

    return {
      leaseId: randomUUID(),
      account: {
        id: account.id,
        name: account.name,
        token: account.token,
      },
    };
  }

  function recordUsage(id, result = {}) {
    const account = getRequiredAccount(id);
    account.usageCount += 1;
    account.lastUsedAt = now();
    account.updatedAt = now();

    if (result.success === false) {
      account.failureCount += 1;
      account.lastError = result.error || 'Unknown failure';
    } else {
      account.lastError = null;
    }
    if ('remainingQuota' in result && result.remainingQuota !== undefined) {
      account.remainingQuota = normalizeRemainingQuota(result.remainingQuota);
    }

    return toPublicAccount(account);
  }

  function recordAudit(event = {}) {
    const { token, tokenCiphertext, ...safeEvent } = event;
    auditEvents.push({
      id: randomUUID(),
      createdAt: now(),
      type: safeEvent.type || (safeEvent.method === 'MCP' ? 'mcp' : 'gateway'),
      ...safeEvent,
    });
    if (auditEvents.length > 1000) {
      auditEvents.splice(0, auditEvents.length - 1000);
    }
  }

  function listAudit(query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 100, 1), 500);
    return auditEvents
      .filter((event) => !query.accountId || event.accountId === query.accountId)
      .filter((event) => query.success === undefined || event.success === query.success)
      .filter((event) => !query.type || event.type === query.type)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((event) => ({ ...event }));
  }

  for (const account of initialAccounts) {
    addAccount(account);
  }

  return {
    addAccount,
    deleteAccount,
    getAccount,
    leaseAccount,
    listAudit,
    listAccounts,
    recordAudit,
    recordUsage,
    updateAccount,
  };
}
