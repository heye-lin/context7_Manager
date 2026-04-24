import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountService } from './account-service.js';
import { createTokenCipher } from './crypto.js';
import { createEnvConfig } from './env-config.js';
import { createAccountPool } from './pool.js';
import { createFileAccountRepository, createMemoryAccountRepository, createMemoryAuditLogger } from './repository.js';

const rootDir = join(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = join(rootDir, 'public');
const defaultEnvPath = join(rootDir, '.env');
const defaultEnvConfig = createEnvConfig(defaultEnvPath);
const port = Number(defaultEnvConfig.get('PORT', 3000));
const defaultUpstreamBaseUrl = defaultEnvConfig.get('CONTEXT7_BASE_URL', 'https://context7.com/api');
const defaultEncryptionKey = defaultEnvConfig.get('ENCRYPTION_KEY', 'development-only-change-me');
const defaultAccountStorePath = defaultEnvConfig.get('ACCOUNT_STORE_PATH');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

async function sendStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = join(publicDir, pathname.replace(/^\/+/, ''));
  const content = await readFile(filePath);

  response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] || 'application/octet-stream' });
  response.end(content);
}

function createHttpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeGatewayMethod(method) {
  const normalized = String(method || 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalized)) {
    throw createHttpError('Unsupported gateway method');
  }
  return normalized;
}

function createUpstreamUrl(baseUrl, path = '/') {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw createHttpError('Gateway path must start with /');
  }
  return new URL(path, baseUrl).toString();
}

function isPromiseLike(value) {
  return value && typeof value.then === 'function';
}

async function maybeAwait(value) {
  return isPromiseLike(value) ? await value : value;
}

function requireBearerToken(request, token) {
  if (!token) return;

  const expected = `Bearer ${token}`;
  if (request.headers.authorization !== expected) {
    throw createHttpError('Unauthorized', 401);
  }
}

function getConfigValue(options, name, fallback) {
  if (fallback !== undefined && fallback !== null) return fallback;
  return options.envConfig?.get(name, fallback) ?? fallback;
}

function requireAdminAuth(request, options) {
  requireBearerToken(request, getConfigValue(options, 'ADMIN_TOKEN', options.adminToken));
}

function requireGatewayAuth(request, options) {
  const adminToken = getConfigValue(options, 'ADMIN_TOKEN', options.adminToken);
  const gatewayToken = getConfigValue(options, 'GATEWAY_TOKEN', options.gatewayToken);
  requireBearerToken(request, gatewayToken || adminToken);
}

function maskSecret(value = '') {
  if (!value) return '';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function publicSettings(options) {
  return {
    mode: 'personal',
    accountStorePath: getConfigValue(options, 'ACCOUNT_STORE_PATH', options.accountStorePath) || '',
    adminTokenConfigured: Boolean(getConfigValue(options, 'ADMIN_TOKEN', options.adminToken)),
    adminTokenPreview: maskSecret(getConfigValue(options, 'ADMIN_TOKEN', options.adminToken)),
    context7BaseUrl: getConfigValue(options, 'CONTEXT7_BASE_URL', options.upstreamBaseUrl || defaultUpstreamBaseUrl),
    encryptionKeyConfigured: Boolean(getConfigValue(options, 'ENCRYPTION_KEY', options.encryptionKey || defaultEncryptionKey)),
    gatewayTokenConfigured: Boolean(getConfigValue(options, 'GATEWAY_TOKEN', options.gatewayToken)),
    gatewayTokenPreview: maskSecret(getConfigValue(options, 'GATEWAY_TOKEN', options.gatewayToken)),
  };
}

function settingsUpdates(input = {}) {
  const mapping = {
    accountStorePath: 'ACCOUNT_STORE_PATH',
    adminToken: 'ADMIN_TOKEN',
    context7BaseUrl: 'CONTEXT7_BASE_URL',
    encryptionKey: 'ENCRYPTION_KEY',
    gatewayToken: 'GATEWAY_TOKEN',
  };
  const updates = {};
  for (const [inputKey, envKey] of Object.entries(mapping)) {
    if (typeof input[inputKey] === 'string' && input[inputKey].trim()) {
      updates[envKey] = input[inputKey].trim();
    }
  }
  return updates;
}

async function proxyContext7Request(input, upstreamBaseUrl, pool) {
  const startedAt = Date.now();
  const lease = await maybeAwait(pool.leaseAccount());
  const method = normalizeGatewayMethod(input.method);
  const upstreamUrl = createUpstreamUrl(upstreamBaseUrl, input.path);
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${lease.account.token}`,
  };
  const options = { method, headers };

  if (!['GET', 'DELETE'].includes(method) && input.body !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(input.body);
  }

  const upstreamResponse = await fetch(upstreamUrl, options);
  const text = await upstreamResponse.text();
  const upstream = text ? JSON.parse(text) : null;
  const durationMs = Date.now() - startedAt;

  if (!upstreamResponse.ok) {
    await maybeAwait(pool.recordUsage(lease.account.id, {
      success: false,
      error: `Context7 upstream returned ${upstreamResponse.status}`,
    }));
    await maybeAwait(pool.recordAudit?.({
      accountId: lease.account.id,
      accountName: lease.account.name,
      durationMs,
      method,
      path: input.path,
      statusCode: upstreamResponse.status,
      success: false,
    }));
    throw createHttpError(`Context7 upstream returned ${upstreamResponse.status}`, 502);
  }

  const account = await maybeAwait(pool.recordUsage(lease.account.id, { success: true }));
  await maybeAwait(pool.recordAudit?.({
    accountId: lease.account.id,
    accountName: lease.account.name,
    durationMs,
    method,
    path: input.path,
    statusCode: upstreamResponse.status,
    success: true,
  }));
  return { account, upstream };
}

async function handleApi(request, response, options = {}) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  const usageMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/usage$/);
  const { pool } = options;

  if (request.method === 'GET' && url.pathname === '/healthz') {
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'GET' && url.pathname === '/readyz') {
    return sendJson(response, 200, { ok: true, storage: 'ready' });
  }

  if (request.method === 'GET' && url.pathname === '/api/session') {
    requireAdminAuth(request, options);
    return sendJson(response, 200, { ok: true, role: 'admin' });
  }

  if (request.method === 'GET' && url.pathname === '/api/settings') {
    requireAdminAuth(request, options);
    return sendJson(response, 200, { settings: publicSettings(options) });
  }

  if (request.method === 'PATCH' && url.pathname === '/api/settings') {
    requireAdminAuth(request, options);
    if (!options.envConfig?.set) {
      throw createHttpError('Env file is not writable', 500);
    }
    options.envConfig.set(settingsUpdates(await readJson(request)));
    return sendJson(response, 200, { settings: publicSettings(options) });
  }

  if (request.method === 'POST' && url.pathname === '/api/gateway') {
    requireGatewayAuth(request, options);
    const result = await proxyContext7Request(
      await readJson(request),
      getConfigValue(options, 'CONTEXT7_BASE_URL', options.upstreamBaseUrl || defaultUpstreamBaseUrl),
      options.pool,
    );
    return sendJson(response, 200, result);
  }

  requireAdminAuth(request, options);

  if (request.method === 'GET' && url.pathname === '/api/accounts') {
    return sendJson(response, 200, { accounts: await maybeAwait(pool.listAccounts()) });
  }

  if (request.method === 'POST' && url.pathname === '/api/accounts') {
    const account = await maybeAwait(pool.addAccount(await readJson(request)));
    return sendJson(response, 201, { account });
  }

  if (request.method === 'PATCH' && accountMatch) {
    const account = await maybeAwait(pool.updateAccount(accountMatch[1], await readJson(request)));
    return sendJson(response, 200, { account });
  }

  if (request.method === 'DELETE' && accountMatch) {
    await maybeAwait(pool.deleteAccount(accountMatch[1]));
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/leases') {
    const lease = await maybeAwait(pool.leaseAccount());
    return sendJson(response, 201, lease);
  }

  if (request.method === 'POST' && usageMatch) {
    const account = await maybeAwait(pool.recordUsage(usageMatch[1], await readJson(request)));
    return sendJson(response, 200, { account });
  }

  return sendJson(response, 404, { error: 'Not found' });
}

function createProductionPool(options) {
  const accountStorePath = getConfigValue(options, 'ACCOUNT_STORE_PATH', options.accountStorePath);
  const repository = options.repository
    || (accountStorePath ? createFileAccountRepository(accountStorePath) : createMemoryAccountRepository());
  const auditLogger = options.auditLogger || createMemoryAuditLogger();
  const tokenCipher = createTokenCipher(getConfigValue(options, 'ENCRYPTION_KEY', options.encryptionKey || defaultEncryptionKey));
  return createAccountService({ auditLogger, repository, tokenCipher });
}

export function createServer(options = {}) {
  const shouldUseProjectEnv = options.envPath || options.useProjectEnv;
  const envConfig = options.envConfig || createEnvConfig(shouldUseProjectEnv ? (options.envPath || defaultEnvPath) : null);
  const accountStorePath = getConfigValue({ ...options, envConfig }, 'ACCOUNT_STORE_PATH', options.accountStorePath);
  const useProductionPool = options.repository || options.auditLogger || options.encryptionKey || accountStorePath;
  const productionOptions = { ...options, accountStorePath, envConfig };
  const serverOptions = {
    ...options,
    accountStorePath,
    adminToken: options.adminToken,
    envConfig,
    gatewayToken: options.gatewayToken,
    pool: options.pool || (useProductionPool ? createProductionPool(productionOptions) : createAccountPool()),
  };

  return http.createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/api/') || request.url === '/healthz' || request.url === '/readyz') {
        await handleApi(request, response, serverOptions);
        return;
      }

      await sendStatic(request, response);
    } catch (error) {
      sendJson(response, error.status || 500, { error: error.message || 'Internal server error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer({
    accountStorePath: defaultAccountStorePath,
    encryptionKey: defaultEncryptionKey,
    envConfig: defaultEnvConfig,
    useProjectEnv: true,
  }).listen(port, () => {
    console.log(`Context7 account pool running at http://localhost:${port}`);
  });
}
