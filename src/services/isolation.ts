import { $ } from 'zx';
import type { IsolationMode } from '../types/index.js';
import { log } from '../utils/logger.js';

const PUBLIC_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org', 'sr.ht']);

/**
 * Extract the hostname from a git remote URL.
 * Supports HTTPS (`https://host/...`) and SSH (`git@host:...`) formats.
 */
function extractHost(gitRemoteUrl: string): string | undefined {
  // HTTPS: https://github.com/user/repo
  try {
    const url = new URL(gitRemoteUrl);
    if (url.hostname) return url.hostname;
  } catch {
    // not a valid URL — try SSH format
  }

  // SSH: git@github.com:user/repo.git  or  git@git.sr.ht:~user/repo
  const sshMatch = /^[^@]+@([^:]+):/.exec(gitRemoteUrl);
  if (sshMatch?.[1]) return sshMatch[1];

  return undefined;
}

/**
 * Determine the default isolation mode based on the git remote URL.
 *
 * Public/OSS hosts → 'docker'
 * Private/enterprise hosts or unparseable → 'worktree'
 */
export function resolveIsolationDefault(gitRemoteUrl: string): IsolationMode {
  const host = extractHost(gitRemoteUrl);
  if (!host) return 'worktree';

  // Check if the host itself or its parent domain is in the public set.
  // e.g. git.sr.ht → check "git.sr.ht", then "sr.ht"
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    if (PUBLIC_HOSTS.has(candidate)) {
      log.debug(`resolveIsolationDefault: "${host}" matches public host "${candidate}" → docker`);
      return 'docker';
    }
  }

  log.debug(`resolveIsolationDefault: "${host}" is not a known public host → worktree`);
  return 'worktree';
}

/**
 * Pre-flight validation for the chosen isolation mode.
 *
 * - 'worktree' / 'none' → always valid
 * - 'docker' → check that the docker binary is available and the daemon is running
 */
export async function validateIsolation(
  mode: IsolationMode,
  dockerCommand = 'docker',
): Promise<{ valid: boolean; error?: string }> {
  if (mode === 'worktree' || mode === 'none') {
    return { valid: true };
  }

  // mode === 'docker'
  try {
    await $`${dockerCommand} info`.quiet();
    return { valid: true };
  } catch {
    return {
      valid: false,
      error: `Docker is not available. Ensure Docker is installed and running ("${dockerCommand} info" failed).`,
    };
  }
}
