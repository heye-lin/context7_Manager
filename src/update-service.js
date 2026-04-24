import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const defaultRepository = 'heye-lin/context7_Manager';
const cacheTtlMs = 20 * 60 * 1000;
const defaultDockerImage = 'ghcr.io/heye-lin/context7_manager:latest';

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

function shortCommit(commit = '') {
  const value = String(commit || '').trim();
  return value && value !== 'unknown' ? value.slice(0, 12) : '';
}

function updateCommands(dockerImage) {
  return {
    docker_compose_latest: [
      'docker compose pull',
      'docker compose up -d',
    ],
    docker_run_latest: [
      `docker pull ${dockerImage}`,
      'docker rm -f context7-manager',
      `docker run -d --name context7-manager --restart unless-stopped --env-file .env -p 3000:3000 -v context7-data:/app/data ${dockerImage}`,
    ],
    source_deploy: [
      'git pull',
      'docker compose up -d --build',
    ],
  };
}

function releaseToInfo(release, currentVersion, buildType, context = {}) {
  const latestVersion = normalizeVersion(release.tag_name || release.name);
  return {
    build_type: buildType,
    cached: false,
    current_commit: shortCommit(context.currentCommit),
    current_version: normalizeVersion(currentVersion),
    has_update: compareVersions(currentVersion, latestVersion) < 0,
    latest_version: latestVersion,
    update_mode: 'release',
    update_commands: updateCommands(context.dockerImage || defaultDockerImage),
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

function commitToInfo(commit, currentVersion, buildType, context = {}) {
  const latestCommit = shortCommit(commit.sha);
  const currentCommit = shortCommit(context.currentCommit);
  return {
    build_type: buildType,
    cached: false,
    current_commit: currentCommit,
    current_version: normalizeVersion(currentVersion),
    has_update: Boolean(latestCommit && currentCommit && latestCommit !== currentCommit),
    latest_commit: latestCommit,
    latest_version: latestCommit || normalizeVersion(currentVersion),
    update_mode: 'latest-image',
    update_commands: updateCommands(context.dockerImage || defaultDockerImage),
    commit_info: commit.sha ? {
      html_url: commit.html_url || '',
      message: commit.commit?.message || '',
      pushed_at: commit.commit?.committer?.date || commit.commit?.author?.date || '',
    } : undefined,
    warning: currentCommit ? undefined : 'Current container was not built with APP_COMMIT, cannot compare latest image commit accurately.',
  };
}

export function createUpdateService({
  buildType = 'source',
  currentCommit = process.env.APP_COMMIT,
  currentVersion,
  dockerImage = process.env.DOCKER_IMAGE || defaultDockerImage,
  repository = defaultRepository,
  rootDir = process.cwd(),
} = {}) {
  let cache = null;
  let cacheTime = 0;

  async function version() {
    return normalizeVersion(currentVersion || await readPackageVersion(rootDir));
  }

  async function fetchLatestRelease(activeVersion) {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'context7-manager-update-checker' },
    });
    if (!response.ok) {
      throw new Error(`GitHub releases returned ${response.status}`);
    }
    return releaseToInfo(await response.json(), activeVersion, buildType, { currentCommit, dockerImage });
  }

  async function fetchLatestCommit(activeVersion) {
    const response = await fetch(`https://api.github.com/repos/${repository}/commits/main`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'context7-manager-update-checker' },
    });
    if (!response.ok) {
      throw new Error(`GitHub commits returned ${response.status}`);
    }
    return commitToInfo(await response.json(), activeVersion, buildType, { currentCommit, dockerImage });
  }

  async function check({ force = false } = {}) {
    const cached = cache && Date.now() - cacheTime < cacheTtlMs;
    if (!force && cached) {
      return { ...cache, cached: true };
    }

    const activeVersion = await version();
    try {
      try {
        cache = await fetchLatestRelease(activeVersion);
      } catch (releaseError) {
        cache = await fetchLatestCommit(activeVersion);
        cache.warning = `No GitHub Release found, using latest main commit: ${releaseError.message}`;
      }
      cacheTime = Date.now();
      return cache;
    } catch (error) {
      if (cache) {
        return { ...cache, cached: true, warning: `Using cached data: ${error.message}` };
      }
      return {
        build_type: buildType,
        cached: false,
        current_commit: shortCommit(currentCommit),
        current_version: activeVersion,
        has_update: false,
        latest_version: activeVersion,
        update_commands: updateCommands(dockerImage),
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
      current_commit: info.current_commit,
      latest_commit: info.latest_commit,
      message: buildType === 'docker'
        ? `Update available. Pull latest image ${dockerImage} and recreate the container.`
        : 'Update available. Use the commands returned by update_commands for your deployment mode.',
      need_restart: true,
      release_info: info.release_info,
      commit_info: info.commit_info,
      update_commands: info.update_commands || updateCommands(dockerImage),
      update_mode: info.update_mode,
    };
  }

  return { check, performUpdate, version };
}
