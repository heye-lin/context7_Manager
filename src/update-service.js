import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const defaultRepository = 'heye-lin/context7_Manager';
const cacheTtlMs = 20 * 60 * 1000;

function normalizeVersion(version = '') {
  return String(version).trim().replace(/^v/i, '') || '0.0.0';
}

function compareVersions(left, right) {
  const leftParts = normalizeVersion(left).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersion(right).split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function readPackageVersion(rootDir) {
  const content = await readFile(join(rootDir, 'package.json'), 'utf8');
  return JSON.parse(content).version || '0.0.0';
}

function releaseToInfo(release, currentVersion, buildType) {
  const latestVersion = normalizeVersion(release.tag_name || release.name);
  return {
    build_type: buildType,
    cached: false,
    current_version: normalizeVersion(currentVersion),
    has_update: compareVersions(currentVersion, latestVersion) < 0,
    latest_version: latestVersion,
    release_info: release.tag_name ? {
      assets: Array.isArray(release.assets) ? release.assets.map((asset) => ({
        download_url: asset.browser_download_url,
        name: asset.name,
        size: asset.size,
      })) : [],
      body: release.body || '',
      html_url: release.html_url || '',
      name: release.name || release.tag_name,
      published_at: release.published_at || '',
    } : undefined,
  };
}

export function createUpdateService({
  buildType = 'source',
  currentVersion,
  repository = defaultRepository,
  rootDir = process.cwd(),
} = {}) {
  let cache = null;
  let cacheTime = 0;

  async function version() {
    return normalizeVersion(currentVersion || await readPackageVersion(rootDir));
  }

  async function check({ force = false } = {}) {
    const cached = cache && Date.now() - cacheTime < cacheTtlMs;
    if (!force && cached) {
      return { ...cache, cached: true };
    }

    const activeVersion = await version();
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'context7-manager-update-checker' },
      });
      if (!response.ok) {
        throw new Error(`GitHub releases returned ${response.status}`);
      }
      cache = releaseToInfo(await response.json(), activeVersion, buildType);
      cacheTime = Date.now();
      return cache;
    } catch (error) {
      if (cache) {
        return { ...cache, cached: true, warning: `Using cached data: ${error.message}` };
      }
      return {
        build_type: buildType,
        cached: false,
        current_version: activeVersion,
        has_update: false,
        latest_version: activeVersion,
        warning: error.message,
      };
    }
  }

  async function performUpdate() {
    const info = await check({ force: true });
    if (!info.has_update) {
      const error = new Error('No update available');
      error.status = 409;
      throw error;
    }

    return {
      build_type: buildType,
      message: buildType === 'release'
        ? 'Update package is available. Download and replace through your deployment pipeline.'
        : 'Source deployment cannot be replaced safely online. Please update through CI/CD, release package, or manual deployment.',
      need_restart: false,
      release_info: info.release_info,
    };
  }

  return { check, performUpdate, version };
}
