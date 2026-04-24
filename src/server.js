import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccountService } from './account-service.js';
import { createTokenCipher } from './crypto.js';
import { createEnvConfig } from './env-config.js';
import { createAccountPool } from './pool.js';
import { createUpdateService } from './update-service.js';
import {
  createFileAccountRepository,
  createFileAuditLogger,
  createMemoryAccountRepository,
  createMemoryAuditLogger,
} from './repository.js';

const rootDir = join(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = join(rootDir, 'public');
const defaultEnvPath = join(rootDir, '.env');
const defaultEnvConfig = createEnvConfig(defaultEnvPath);
const port = Number(defaultEnvConfig.get('PORT', 3000));
const defaultUpstreamBaseUrl = defaultEnvConfig.get('CONTEXT7_BASE_URL', 'https://context7.com/api');
const defaultMcpBaseUrl = defaultEnvConfig.get('CONTEXT7_MCP_URL', 'https://mcp.context7.com/mcp');
const defaultEncryptionKey = defaultEnvConfig.get('ENCRYPTION_KEY', 'development-only-change-me');
const defaultAccountStorePath = defaultEnvConfig.get('ACCOUNT_STORE_PATH');
const defaultAuditLogPath = defaultEnvConfig.get('AUDIT_LOG_PATH');

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

function isInsideDirectory(parent, child) {
  const relation = relative(parent, child);
  return relation && !relation.startsWith('..') && !resolve(relation).startsWith('..');
}

function staticHeaders(filePath) {
  const extension = extname(filePath);
  const headers = { 'content-type': contentTypes[extension] || 'application/octet-stream' };
  headers['cache-control'] = extension === '.html' ? 'no-store' : 'public, max-age=300';
  return headers;
}

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
  const filePath = resolve(publicDir, decodeURIComponent(pathname).replace(/^\/+/, ''));
  if (!isInsideDirectory(publicDir, filePath)) {
    throw createHttpError('Not found', 404);
  }
  const content = await readFile(filePath);

  response.writeHead(200, staticHeaders(filePath));
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
    auditLogPath: getConfigValue(options, 'AUDIT_LOG_PATH', options.auditLogPath || defaultAuditLogPath) || '',
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
    auditLogPath: 'AUDIT_LOG_PATH',
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

function auditQueryFromUrl(url) {
  const success = url.searchParams.get('success');
  return {
    accountId: url.searchParams.get('accountId') || undefined,
    limit: url.searchParams.get('limit') || undefined,
    success: success === null ? undefined : success === 'true',
    type: url.searchParams.get('type') || undefined,
  };
}

async function recordSystemAudit(pool, event = {}) {
  if (!pool?.recordAudit) return;
  await maybeAwait(pool.recordAudit({
    durationMs: 0,
    statusCode: 200,
    success: true,
    ...event,
  }));
}

async function recordRequestErrorAudit(pool, request, error) {
  if (!pool?.recordAudit || !request.url?.startsWith('/api/') && request.url !== '/mcp') return;
  try {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    await recordSystemAudit(pool, {
      type: 'error',
      action: 'request-error',
      error: error.message || 'Internal server error',
      method: request.method,
      path: url.pathname,
      statusCode: error.status || 500,
      success: false,
    });
  } catch {
    // Ignore audit logging failures so the original response is preserved.
  }
}

function quotaFromHeaders(headers) {
  const value = headers.get('ratelimit-remaining') || headers.get('x-ratelimit-remaining');
  if (!value) return undefined;
  const quota = Number(value);
  return Number.isFinite(quota) && quota >= 0 ? quota : undefined;
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
  const remainingQuota = quotaFromHeaders(upstreamResponse.headers);

  if (!upstreamResponse.ok) {
    await maybeAwait(pool.recordUsage(lease.account.id, {
      success: false,
      error: `Context7 upstream returned ${upstreamResponse.status}`,
    }));
    await maybeAwait(pool.recordAudit?.({
      type: 'gateway',
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

  const account = await maybeAwait(pool.recordUsage(lease.account.id, { remainingQuota, success: true }));
  await maybeAwait(pool.recordAudit?.({
    type: 'gateway',
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

async function testContext7Account(id, input, upstreamBaseUrl, pool) {
  const startedAt = Date.now();
  const lease = await maybeAwait(pool.leaseAccount(id));
  const method = normalizeGatewayMethod(input.method || 'GET');
  const path = input.path || '/api/v2/libs/search?query=react';
  const upstreamUrl = createUpstreamUrl(upstreamBaseUrl, path);
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
  const remainingQuota = quotaFromHeaders(upstreamResponse.headers);

  if (!upstreamResponse.ok) {
    const account = await maybeAwait(pool.recordUsage(lease.account.id, {
      remainingQuota,
      success: false,
      error: `Context7 upstream returned ${upstreamResponse.status}`,
    }));
    return { account, durationMs, method, path, statusCode: upstreamResponse.status, success: false, upstream };
  }

  const account = await maybeAwait(pool.recordUsage(lease.account.id, { remainingQuota, success: true }));
  return { account, durationMs, method, path, statusCode: upstreamResponse.status, success: true, upstream };
}

function responseHeadersFromUpstream(upstreamResponse) {
  const headers = { 'content-type': upstreamResponse.headers.get('content-type') || 'application/json; charset=utf-8' };
  const cacheControl = upstreamResponse.headers.get('cache-control');
  if (cacheControl) headers['cache-control'] = cacheControl;
  return headers;
}

async function proxyMcpRequest(request, response, options) {
  const startedAt = Date.now();
  const lease = await maybeAwait(options.pool.leaseAccount());
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const mcpUrl = getConfigValue(options, 'CONTEXT7_MCP_URL', options.mcpBaseUrl || defaultMcpBaseUrl);

  const upstreamResponse = await fetch(mcpUrl, {
    method: 'POST',
    headers: {
      accept: request.headers.accept || 'application/json',
      'content-type': request.headers['content-type'] || 'application/json',
      context7_api_key: lease.account.token,
    },
    body,
  });

  const text = await upstreamResponse.text();
  const durationMs = Date.now() - startedAt;
  const remainingQuota = quotaFromHeaders(upstreamResponse.headers);
  const account = await maybeAwait(options.pool.recordUsage(lease.account.id, {
    remainingQuota,
    success: upstreamResponse.ok,
    error: upstreamResponse.ok ? undefined : `Context7 MCP returned ${upstreamResponse.status}`,
  }));
  await maybeAwait(options.pool.recordAudit?.({
    type: 'mcp',
    accountId: lease.account.id,
    accountName: lease.account.name,
    method: 'MCP',
    path: '/mcp',
    durationMs,
    statusCode: upstreamResponse.status,
    success: upstreamResponse.ok,
    type: 'mcp',
  }));

  response.writeHead(upstreamResponse.status, {
    ...responseHeadersFromUpstream(upstreamResponse),
    'x-context7-account-id': account.id,
    'x-context7-account-name': encodeURIComponent(account.name),
  });
  response.end(text);
}

async function handleApi(request, response, options = {}) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
  const accountTestMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)\/test$/);
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
    await recordSystemAudit(pool, { type: 'auth', action: 'session', method: 'GET', path: '/api/session' });
    return sendJson(response, 200, { ok: true, role: 'admin' });
  }

  if (request.method === 'GET' && url.pathname === '/api/settings') {
    requireAdminAuth(request, options);
    await recordSystemAudit(pool, { type: 'settings', action: 'read', method: 'GET', path: '/api/settings' });
    return sendJson(response, 200, { settings: publicSettings(options) });
  }

  if (request.method === 'PATCH' && url.pathname === '/api/settings') {
    requireAdminAuth(request, options);
    if (!options.envConfig?.set) {
      throw createHttpError('Env file is not writable', 500);
    }
    options.envConfig.set(settingsUpdates(await readJson(request)));
    await recordSystemAudit(pool, { type: 'settings', action: 'update', method: 'PATCH', path: '/api/settings' });
    return sendJson(response, 200, { settings: publicSettings(options) });
  }

  if (request.method === 'GET' && url.pathname === '/api/system/version') {
    requireAdminAuth(request, options);
    const version = await options.updateService.version();
    await recordSystemAudit(pool, { type: 'update', action: 'version', method: 'GET', path: '/api/system/version' });
    return sendJson(response, 200, { version });
  }

  if (request.method === 'GET' && url.pathname === '/api/system/check-updates') {
    requireAdminAuth(request, options);
    const updateInfo = await options.updateService.check({ force: url.searchParams.get('force') === 'true' });
    await recordSystemAudit(pool, {
      type: 'update',
      action: 'check',
      method: 'GET',
      path: '/api/system/check-updates',
      hasUpdate: Boolean(updateInfo.has_update),
      latestVersion: updateInfo.latest_version,
    });
    return sendJson(response, 200, updateInfo);
  }

  if (request.method === 'POST' && url.pathname === '/api/system/update') {
    requireAdminAuth(request, options);
    const updateInfo = await options.updateService.performUpdate();
    await recordSystemAudit(pool, {
      type: 'update',
      action: 'perform',
      method: 'POST',
      path: '/api/system/update',
      hasUpdate: Boolean(updateInfo.has_update),
      latestVersion: updateInfo.latest_version,
    });
    return sendJson(response, 200, updateInfo);
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

  if (request.method === 'POST' && url.pathname === '/mcp') {
    requireGatewayAuth(request, options);
    return proxyMcpRequest(request, response, options);
  }

  requireAdminAuth(request, options);

  if (request.method === 'GET' && url.pathname === '/api/accounts') {
    const accounts = await maybeAwait(pool.listAccounts());
    await recordSystemAudit(pool, {
      type: 'account',
      action: 'list',
      method: 'GET',
      path: '/api/accounts',
      accountCount: accounts.length,
    });
    return sendJson(response, 200, { accounts });
  }

  if (request.method === 'GET' && url.pathname === '/api/logs') {
    const logs = pool.listAudit ? await maybeAwait(pool.listAudit(auditQueryFromUrl(url))) : [];
    return sendJson(response, 200, { logs });
  }

  if (request.method === 'POST' && url.pathname === '/api/accounts') {
    const account = await maybeAwait(pool.addAccount(await readJson(request)));
    await recordSystemAudit(pool, {
      type: 'account',
      action: 'create',
      accountId: account.id,
      accountName: account.name,
      method: 'POST',
      path: '/api/accounts',
      statusCode: 201,
    });
    return sendJson(response, 201, { account });
  }

  if (request.method === 'PATCH' && accountMatch) {
    const account = await maybeAwait(pool.updateAccount(accountMatch[1], await readJson(request)));
    await recordSystemAudit(pool, {
      type: 'account',
      action: 'update',
      accountId: account.id,
      accountName: account.name,
      method: 'PATCH',
      path: `/api/accounts/${accountMatch[1]}`,
    });
    return sendJson(response, 200, { account });
  }

  if (request.method === 'DELETE' && accountMatch) {
    const account = pool.getAccount ? await maybeAwait(pool.getAccount(accountMatch[1])) : { id: accountMatch[1] };
    await maybeAwait(pool.deleteAccount(accountMatch[1]));
    await recordSystemAudit(pool, {
      type: 'account',
      action: 'delete',
      accountId: account.id || accountMatch[1],
      accountName: account.name,
      method: 'DELETE',
      path: `/api/accounts/${accountMatch[1]}`,
    });
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === 'POST' && url.pathname === '/api/leases') {
    const lease = await maybeAwait(pool.leaseAccount());
    await recordSystemAudit(pool, {
      type: 'lease',
      action: 'create',
      accountId: lease.account.id,
      accountName: lease.account.name,
      method: 'POST',
      path: '/api/leases',
      statusCode: 201,
    });
    return sendJson(response, 201, lease);
  }

  if (request.method === 'POST' && usageMatch) {
    const account = await maybeAwait(pool.recordUsage(usageMatch[1], await readJson(request)));
    await recordSystemAudit(pool, {
      type: 'account',
      action: 'usage',
      accountId: account.id,
      accountName: account.name,
      method: 'POST',
      path: `/api/accounts/${usageMatch[1]}/usage`,
      success: account.lastError ? false : true,
    });
    return sendJson(response, 200, { account });
  }

  if (request.method === 'POST' && accountTestMatch) {
    const result = await testContext7Account(
      accountTestMatch[1],
      await readJson(request),
      getConfigValue(options, 'CONTEXT7_BASE_URL', options.upstreamBaseUrl || defaultUpstreamBaseUrl),
      options.pool,
    );
    await recordSystemAudit(pool, {
      type: 'account-test',
      action: 'test',
      accountId: result.account.id,
      accountName: result.account.name,
      durationMs: result.durationMs,
      method: result.method || 'GET',
      path: result.path || `/api/accounts/${accountTestMatch[1]}/test`,
      statusCode: result.statusCode,
      success: result.success,
    });
    return sendJson(response, 200, result);
  }

  await recordSystemAudit(pool, {
    type: 'error',
    action: 'not-found',
    method: request.method,
    path: url.pathname,
    statusCode: 404,
    success: false,
  });
  return sendJson(response, 404, { error: 'Not found' });
}

function createProductionPool(options) {
  const accountStorePath = getConfigValue(options, 'ACCOUNT_STORE_PATH', options.accountStorePath);
  const auditLogPath = getConfigValue(options, 'AUDIT_LOG_PATH', options.auditLogPath || defaultAuditLogPath);
  const repository = options.repository
    || (accountStorePath ? createFileAccountRepository(accountStorePath) : createMemoryAccountRepository());
  const auditLogger = options.auditLogger || (auditLogPath ? createFileAuditLogger(auditLogPath) : createMemoryAuditLogger());
  const tokenCipher = createTokenCipher(getConfigValue(options, 'ENCRYPTION_KEY', options.encryptionKey || defaultEncryptionKey));
  return createAccountService({ auditLogger, repository, tokenCipher });
}

export function createServer(options = {}) {
  const shouldUseProjectEnv = options.envPath || options.useProjectEnv;
  const envConfig = options.envConfig || createEnvConfig(shouldUseProjectEnv ? (options.envPath || defaultEnvPath) : null);
  const accountStorePath = getConfigValue({ ...options, envConfig }, 'ACCOUNT_STORE_PATH', options.accountStorePath);
  const auditLogPath = getConfigValue({ ...options, envConfig }, 'AUDIT_LOG_PATH', options.auditLogPath);
  const useProductionPool = options.repository || options.auditLogger || options.encryptionKey || accountStorePath || auditLogPath;
  const productionOptions = { ...options, accountStorePath, auditLogPath, envConfig };
  const serverOptions = {
    ...options,
    accountStorePath,
    auditLogPath,
    adminToken: options.adminToken,
    envConfig,
    gatewayToken: options.gatewayToken,
    updateService: options.updateService || createUpdateService({
      buildType: options.buildType || 'source',
      currentVersion: options.currentVersion,
      repository: options.updateRepository,
      rootDir,
    }),
    pool: options.pool || (useProductionPool ? createProductionPool(productionOptions) : createAccountPool()),
  };

  return http.createServer(async (request, response) => {
    try {
      if (request.url?.startsWith('/api/') || request.url === '/healthz' || request.url === '/readyz') {
        await handleApi(request, response, serverOptions);
        return;
      }

      if (request.url === '/mcp') {
        await handleApi(request, response, serverOptions);
        return;
      }

      await sendStatic(request, response);
    } catch (error) {
      await recordRequestErrorAudit(serverOptions.pool, request, error);
      if (error.code === 'ENOENT') {
        sendJson(response, 404, { error: 'Not found' });
        return;
      }
      sendJson(response, error.status || 500, { error: error.message || 'Internal server error' });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer({
    accountStorePath: defaultAccountStorePath,
    auditLogPath: defaultAuditLogPath,
    encryptionKey: defaultEncryptionKey,
    envConfig: defaultEnvConfig,
    useProjectEnv: true,
  }).listen(port, () => {
    console.log(`Context7 account pool running at http://localhost:${port}`);
  });
}
