// Brainstorm orchestrator — spawns an opus agent to analyze a codebase
// and generate a structured suite of issue suggestions.

import { z } from 'zod';
import { getWaveTools, type OutputFormat, resolveModel, resolveThinkingLevel, spawnWaveAgent } from '../ai/index.js';
import type { BrainstormIssue, BrainstormResult, RepoConfig } from '../types/index.js';
import { BrainstormResultSchema } from '../types/index.js';
import { log } from '../utils/logger.js';
import { loadPrompt } from './prompts.js';

function toOutputFormat(schema: z.ZodType): OutputFormat {
  return {
    type: 'json_schema',
    schema: z.toJSONSchema(schema, { target: 'draft-07' }) as Record<string, unknown>,
    zodSchema: schema,
  };
}

export interface BrainstormOptions {
  repoPath: string;
  config: RepoConfig;
  focus?: string[] | undefined;
}

export interface BrainstormReturn {
  success: boolean;
  issues: BrainstormIssue[];
  summary?: string;
  cost: number;
  model: string;
  error?: string;
}

export async function brainstorm(options: BrainstormOptions): Promise<BrainstormReturn> {
  const { repoPath, config, focus } = options;

  const model = resolveModel('large');
  const tools = getWaveTools('brainstorm', repoPath);
  const systemPrompt = await loadPrompt('brainstorm');
  const thinkingLevel = resolveThinkingLevel(config, 'brainstorm');

  const focusAreas = focus ?? config.rules.focus;

  let userMessage = `Analyze the codebase at ${repoPath} and identify improvements. Read key files, understand the architecture, then produce a structured list of issues.`;
  if (focusAreas && focusAreas.length > 0) {
    userMessage += `\n\nIMPORTANT: ONLY generate issues within these focus areas: ${focusAreas.join(', ')}. Do not generate issues outside these categories.`;
  }

  try {
    const handoff = await spawnWaveAgent<BrainstormResult>({
      wave: 'brainstorm',
      model: model.id,
      tools,
      systemPrompt,
      handoffContext: '',
      userMessage,
      cwd: repoPath,
      thinkingLevel,
      outputFormat: toOutputFormat(BrainstormResultSchema),
    });

    if (handoff.confidence === 'low' || typeof handoff.artifact === 'string') {
      log.warn('[brainstorm] Agent returned low confidence or unparseable output');
      return {
        success: false,
        issues: [],
        cost: handoff.cost,
        model: handoff.model,
        error: 'Agent output could not be parsed as structured issues',
      };
    }

    const artifact = handoff.artifact;
    return {
      success: true,
      issues: artifact.issues,
      summary: artifact.summary,
      cost: handoff.cost,
      model: handoff.model,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[brainstorm] Failed: ${message}`);
    return {
      success: false,
      issues: [],
      cost: 0,
      model: model.id,
      error: message,
    };
  }
}

/** Pretty-print brainstorm issues to stdout for user preview. */
export function printBrainstormPreview(result: BrainstormReturn): void {
  if (!result.success) {
    console.error(`Brainstorm failed: ${result.error}`);
    return;
  }

  if (result.summary) {
    console.log(`\n${result.summary}\n`);
  }

  console.log(`Found ${result.issues.length} issue(s):\n`);

  for (const [i, issue] of result.issues.entries()) {
    const labels = issue.labels.length > 0 ? ` [${issue.labels.join(', ')}]` : '';
    console.log(`  ${i + 1}. [${issue.priority.toUpperCase()}] ${issue.title}${labels}`);
    console.log(`     ${issue.category} — ${issue.body.slice(0, 120)}${issue.body.length > 120 ? '...' : ''}`);
    if (issue.dependencies?.length) {
      console.log(`     depends on: ${issue.dependencies.join(', ')}`);
    }
    console.log();
  }

  console.log(`Cost: $${result.cost.toFixed(4)} | Model: ${result.model}`);
}
