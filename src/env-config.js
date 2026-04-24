import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

function parseEnv(content) {
  const values = {};

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }

  return values;
}

function serializeEnv(values) {
  const order = ['PORT', 'BUILD_TYPE', 'DOCKER_IMAGE', 'ADMIN_TOKEN', 'GATEWAY_TOKEN', 'ENCRYPTION_KEY', 'CONTEXT7_BASE_URL', 'CONTEXT7_MCP_URL', 'ACCOUNT_STORE_PATH', 'AUDIT_LOG_PATH'];
  const keys = [...order, ...Object.keys(values).filter((key) => !order.includes(key))];
  return `${keys.filter((key) => values[key] !== undefined).map((key) => `${key}=${values[key]}`).join('\n')}\n`;
}

export function createEnvConfig(path) {
  let cachedMtimeMs = -1;
  let cachedValues = {};

  function load() {
    if (!path) return {};

    try {
      const stat = statSync(path);
      if (stat.mtimeMs !== cachedMtimeMs) {
        cachedValues = parseEnv(readFileSync(path, 'utf8'));
        cachedMtimeMs = stat.mtimeMs;
      }
      return cachedValues;
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }

  function get(name, fallback) {
    const values = load();
    return values[name] ?? process.env[name] ?? fallback;
  }

  function set(updates) {
    if (!path) {
      throw new Error('Env file path is required');
    }

    const values = { ...load(), ...updates };
    mkdirSync(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, serializeEnv(values), 'utf8');
    renameSync(tempPath, path);
    cachedMtimeMs = -1;
    cachedValues = {};
    return load();
  }

  return { get, load, set };
}
