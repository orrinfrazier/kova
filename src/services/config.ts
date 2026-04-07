// Config loader — reads repos.yaml and validates with Zod.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { $, fs, path } from 'zx';
import { type KovaConfig, KovaConfigSchema, type RepoConfig, RepoConfigSchema } from '../types/index.js';
import { resolveIsolationDefault } from './isolation.js';

const DEFAULT_CONFIG_PATH = join(homedir(), '.kova', 'repos.yaml');

/** Expand leading `~` to the user's home directory. */
export function resolveTilde(p: string): string {
  if (p === '~' || p.startsWith('~/')) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/** Resolve a config file path — expands `~`, defaults to `~/.kova/repos.yaml`. */
export function resolveConfigPath(configPath?: string): string {
  if (configPath) {
    return resolveTilde(configPath);
  }
  return DEFAULT_CONFIG_PATH;
}

/** Resolve a repo path: expand `~`, then make absolute. */
function resolveRepoPath(p: string): string {
  const expanded = resolveTilde(p);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Resolve all repo paths in a loaded config. */
function resolvePaths(config: KovaConfig): KovaConfig {
  const resolved: KovaConfig = { repos: {} };
  for (const [name, repo] of Object.entries(config.repos)) {
    resolved.repos[name] = { ...repo, path: resolveRepoPath(repo.path) };
  }
  return resolved;
}

/** Detect the origin remote URL for a repo path. Returns undefined on failure. */
export async function detectGitRemoteUrl(repoPath: string): Promise<string | undefined> {
  try {
    const result = await $`git -C ${repoPath} remote get-url origin`.quiet();
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Type guard for objects with string keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Check if the raw YAML explicitly set `isolation` for a given repo. */
function hasExplicitIsolation(raw: unknown, repoName: string): boolean {
  if (!isRecord(raw)) return false;
  const repos = raw.repos;
  if (!isRecord(repos)) return false;
  const repo = repos[repoName];
  if (!isRecord(repo)) return false;
  return 'isolation' in repo;
}

/** Resolve isolation defaults for repos that don't have explicit isolation set. */
async function resolveIsolationDefaults(config: KovaConfig, raw: unknown): Promise<KovaConfig> {
  const result: KovaConfig = { repos: {} };
  for (const [name, repo] of Object.entries(config.repos)) {
    if (hasExplicitIsolation(raw, name)) {
      result.repos[name] = repo;
      continue;
    }
    const remoteUrl = await detectGitRemoteUrl(repo.path);
    if (remoteUrl) {
      const resolved = resolveIsolationDefault(remoteUrl);
      result.repos[name] = { ...repo, isolation: resolved };
    } else {
      result.repos[name] = repo;
    }
  }
  return result;
}

export async function loadConfig(configPath?: string): Promise<KovaConfig> {
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const raw = yaml.load(content);
    const parsed = KovaConfigSchema.parse(raw);
    const pathsResolved = resolvePaths(parsed);
    return resolveIsolationDefaults(pathsResolved, raw);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Config file not found: ${filePath}`);
    }
    throw error;
  }
}

/** Look up a repo by its config key name. */
export function findRepoByName(config: KovaConfig, name: string): { name: string; config: RepoConfig } | undefined {
  const repo = config.repos[name];
  if (!repo) return undefined;
  return { name, config: repo };
}

export function resolveRepoConfig(repoPath: string): RepoConfig {
  return RepoConfigSchema.parse({ path: repoPath });
}

export function detectRepoName(repoPath: string): string {
  return path.basename(repoPath);
}
