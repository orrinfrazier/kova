// Project context loader — reads CLAUDE.md, style config, and CI config
// from a target repository and returns pre-truncated content for prompt injection.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { truncateToTokenBudget } from './context.js';

export interface ProjectContext {
  claudeMd: string;
  styleConfig: string;
  ciConfig: string;
}

export interface ProjectContextBudget {
  claudeMd: number;
  styleConfig: number;
  ciConfig: number;
}

const DEFAULT_BUDGET: ProjectContextBudget = {
  claudeMd: 2000,
  styleConfig: 1000,
  ciConfig: 1000,
};

const STYLE_CONFIG_PRIORITY = [
  'biome.json',
  'biome.jsonc',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.yml',
  'eslint.config.js',
  '.editorconfig',
] as const;

async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return '';
  }
}

async function loadClaudeMd(workDir: string): Promise<string> {
  return readFileSafe(join(workDir, 'CLAUDE.md'));
}

async function loadStyleConfig(workDir: string): Promise<string> {
  for (const filename of STYLE_CONFIG_PRIORITY) {
    const content = await readFileSafe(join(workDir, filename));
    if (content) {
      return `--- ${filename} ---\n${content}`;
    }
  }
  return '';
}

async function loadCiConfig(workDir: string): Promise<string> {
  const workflowsDir = join(workDir, '.github', 'workflows');
  let entries: string[];
  try {
    entries = await readdir(workflowsDir);
  } catch {
    return '';
  }

  const yamlFiles = entries.filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')).sort();

  if (yamlFiles.length === 0) return '';

  const sections: string[] = [];
  for (const filename of yamlFiles) {
    const content = await readFileSafe(join(workflowsDir, filename));
    if (content) {
      sections.push(`--- ${filename} ---\n${content}`);
    }
  }

  return sections.join('\n\n');
}

export async function loadProjectContext(
  workDir: string,
  budget: ProjectContextBudget = DEFAULT_BUDGET,
): Promise<ProjectContext> {
  const [claudeMd, styleConfig, ciConfig] = await Promise.all([
    loadClaudeMd(workDir),
    loadStyleConfig(workDir),
    loadCiConfig(workDir),
  ]);

  return {
    claudeMd: claudeMd ? truncateToTokenBudget(claudeMd, budget.claudeMd) : '',
    styleConfig: styleConfig ? truncateToTokenBudget(styleConfig, budget.styleConfig) : '',
    ciConfig: ciConfig ? truncateToTokenBudget(ciConfig, budget.ciConfig) : '',
  };
}
