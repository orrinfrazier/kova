// Config loader — reads repos.yaml and validates with Zod.

import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import yaml from 'js-yaml';
import { fs, path } from 'zx';
import { type KovaConfig, KovaConfigSchema, type RepoConfig, RepoConfigSchema } from '../types/index.js';

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

export async function loadConfig(configPath?: string): Promise<KovaConfig> {
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const raw = yaml.load(content);
    const parsed = KovaConfigSchema.parse(raw);
    return resolvePaths(parsed);
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
