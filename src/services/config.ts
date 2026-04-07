// Config loader — reads repos.yaml and validates with Zod.

import yaml from 'js-yaml';
import { fs, path } from 'zx';
import { type KovaConfig, KovaConfigSchema, type RepoConfig, RepoConfigSchema } from '../types/index.js';

const DEFAULT_CONFIG_PATH = 'repos.yaml';

export async function loadConfig(configPath?: string): Promise<KovaConfig> {
  const filePath = configPath ?? DEFAULT_CONFIG_PATH;

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const raw = yaml.load(content);
    return KovaConfigSchema.parse(raw);
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Config file not found: ${filePath}`);
    }
    throw error;
  }
}

export function resolveRepoConfig(repoPath: string): RepoConfig {
  return RepoConfigSchema.parse({ path: repoPath });
}

export function detectRepoName(repoPath: string): string {
  return path.basename(repoPath);
}
