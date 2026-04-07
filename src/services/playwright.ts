// Playwright service — resolves playwright configuration for frontend repos.
// Provides env vars and ensures the screenshots directory exists.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RepoConfig } from '../types/index.js';
import type { DetectedTooling } from './language-detect.js';

const DEFAULT_SCREENSHOTS_DIR = '.kova/screenshots';

/** Returns true when config.playwright.enabled AND tooling.repoType is 'frontend'. */
export function isPlaywrightEnabled(config: RepoConfig, tooling: DetectedTooling): boolean {
  return config.playwright?.enabled === true && tooling.repoType === 'frontend';
}

/** Returns playwright-related env vars when enabled, empty object otherwise. */
export function resolvePlaywrightEnv(config: RepoConfig, tooling: DetectedTooling): Record<string, string> {
  if (!isPlaywrightEnabled(config, tooling)) {
    return {};
  }

  const screenshotsDir = config.playwright?.screenshots_dir ?? DEFAULT_SCREENSHOTS_DIR;

  return {
    PLAYWRIGHT_MCP_ENABLED: 'true',
    PLAYWRIGHT_SCREENSHOTS_DIR: screenshotsDir,
  };
}

/** Creates the screenshots directory (recursive). Returns the absolute path. */
export async function ensureScreenshotsDir(workDir: string, config?: RepoConfig): Promise<string> {
  const screenshotsDir = config?.playwright?.screenshots_dir ?? DEFAULT_SCREENSHOTS_DIR;
  const fullPath = join(workDir, screenshotsDir);
  await mkdir(fullPath, { recursive: true });
  return fullPath;
}
