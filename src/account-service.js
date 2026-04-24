import { randomUUID } from 'node:crypto';

function now() {
  return new Date().toISOString();
}

function maskToken(token) {
  if (token.length <= 8) {
    return '****';
  }

  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

function toPublicAccount(account) {
  const { tokenCiphertext, token, ...publicAccount } = account;
  return {
    ...publicAccount,
    tokenPreview: maskToken(token || ''),
  };
}

function createHttpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function createAccountService({ repository, tokenCipher, auditLogger } = {}) {
  if (!repository) {
    throw new Error('repository is required');
  }

  async function listAccounts() {
    const accounts = await repository.listAccounts();
    return accounts.map((account) => toPublicAccount({ ...account, token: tokenCipher?.decrypt?.(account.tokenCiphertext) || '' }));
  }

  async function getAccount(id) {
    const account = await repository.getAccount(id);
    if (!account) {
      throw createHttpError('Context7 account not found', 404);
    }
    return toPublicAccount({ ...account, token: tokenCipher?.decrypt?.(account.tokenCiphertext) || '' });
  }

  async function addAccount(input) {
    const name = input?.name?.trim();
    const token = input?.token?.trim();

    if (!name) {
      throw createHttpError('Account name is required');
    }
    if (!token) {
      throw createHttpError('Context7 token is required');
    }

    const account = {
      id: randomUUID(),
      name,
      tokenCiphertext: tokenCipher.encrypt(token),
      enabled: input.enabled ?? true,
      usageCount: 0,
      leasedCount: 0,
      failureCount: 0,
      lastUsedAt: null,
      lastError: null,
      createdAt: now(),
      updatedAt: now(),
    };

    await repository.addAccount(account);
    return toPublicAccount({ ...account, token });
  }

  async function updateAccount(id, changes) {
    const account = await repository.getAccount(id);
    if (!account) {
      throw createHttpError('Context7 account not found', 404);
    }

    const token = tokenCipher.decrypt(account.tokenCiphertext);

    if (typeof changes.name === 'string' && changes.name.trim()) {
      account.name = changes.name.trim();
    }
    if (typeof changes.token === 'string' && changes.token.trim()) {
      account.tokenCiphertext = tokenCipher.encrypt(changes.token.trim());
    }
    if (typeof changes.enabled === 'boolean') {
      account.enabled = changes.enabled;
    }
    account.updatedAt = now();
    await repository.updateAccount(account);
    return toPublicAccount({ ...account, token });
  }

  async function deleteAccount(id) {
    const account = await repository.getAccount(id);
    if (!account) {
      throw createHttpError('Context7 account not found', 404);
    }
    await repository.deleteAccount(id);
  }

  async function leaseAccount() {
    const accounts = (await repository.listAccounts())
      .filter((account) => account.enabled)
      .sort((left, right) => {
        if (left.failureCount !== right.failureCount) return left.failureCount - right.failureCount;
        if (left.usageCount !== right.usageCount) return left.usageCount - right.usageCount;
        return left.createdAt.localeCompare(right.createdAt);
      });

    const account = accounts[0];
    if (!account) {
      throw createHttpError('No available Context7 account', 503);
    }

    account.leasedCount += 1;
    account.updatedAt = now();
    await repository.updateAccount(account);

    return {
      leaseId: randomUUID(),
      account: {
        id: account.id,
        name: account.name,
        token: tokenCipher.decrypt(account.tokenCiphertext),
      },
    };
  }

  async function recordUsage(id, result = {}) {
    const account = await repository.getAccount(id);
    if (!account) {
      throw createHttpError('Context7 account not found', 404);
    }

    account.usageCount += 1;
    account.lastUsedAt = now();
    account.updatedAt = now();

    if (result.success === false) {
      account.failureCount += 1;
      account.lastError = result.error || 'Unknown failure';
    } else {
      account.lastError = null;
    }

    await repository.updateAccount(account);
    return toPublicAccount({ ...account, token: tokenCipher.decrypt(account.tokenCiphertext) });
  }

  async function recordAudit(event) {
    if (auditLogger?.record) {
      await auditLogger.record({ ...event, token: undefined, tokenCiphertext: undefined });
    }
  }

  return {
    addAccount,
    deleteAccount,
    getAccount,
    leaseAccount,
    listAccounts,
    recordAudit,
    recordUsage,
    updateAccount,
  };
}
