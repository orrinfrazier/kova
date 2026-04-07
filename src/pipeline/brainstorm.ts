// Brainstorm orchestrator — spawns an opus agent to analyze a codebase
// and generate a structured suite of issue suggestions.

import { z } from 'zod';
import { getWaveTools, type OutputFormat, resolveModel, resolveThinkingLevel, spawnWaveAgent } from '../ai/index.js';
import {
  appendCycle,
  type DiminishingReturnsReport,
  detectDiminishingReturns,
  loadHistory,
} from '../services/brainstorm-history.js';
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

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;

export interface BrainstormOptions {
  repoPath: string;
  config: RepoConfig;
  threshold?: number;
  focus?: string[] | undefined;
}

export interface BrainstormReturn {
  success: boolean;
  issues: BrainstormIssue[];
  filtered: BrainstormIssue[];
  summary?: string;
  cost: number;
  model: string;
  error?: string;
  diminishingReturns?: DiminishingReturnsReport;
}

export async function brainstorm(options: BrainstormOptions): Promise<BrainstormReturn> {
  const { repoPath, config, threshold = DEFAULT_CONFIDENCE_THRESHOLD, focus } = options;

  const model = resolveModel(config.model.brainstorm);
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
        filtered: [],
        cost: handoff.cost,
        model: handoff.model,
        error: 'Agent output could not be parsed as structured issues',
      };
    }

    const artifact = handoff.artifact;
    const passing = artifact.issues.filter((issue) => issue.confidence >= threshold);
    const filtered = artifact.issues.filter((issue) => issue.confidence < threshold);

    // Diminishing returns detection
    const history = await loadHistory(repoPath);
    const report = detectDiminishingReturns(artifact.issues, history);

    // Persist this cycle for future comparison
    await appendCycle(repoPath, {
      timestamp: new Date().toISOString(),
      issues: artifact.issues.map((i) => ({ title: i.title, category: i.category })),
      summary: artifact.summary,
    });

    return {
      success: true,
      issues: passing,
      filtered,
      summary: artifact.summary,
      cost: handoff.cost,
      model: handoff.model,
      diminishingReturns: report,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`[brainstorm] Failed: ${message}`);
    return {
      success: false,
      issues: [],
      filtered: [],
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

  if (result.filtered.length > 0) {
    console.log(`Filtered (below threshold): ${result.filtered.length}\n`);
    for (const issue of result.filtered) {
      console.log(`  - [${issue.confidence.toFixed(2)}] ${issue.title}`);
    }
    console.log();
  }

  console.log(`Cost: $${result.cost.toFixed(4)} | Model: ${result.model}`);

  // Diminishing returns warnings
  if (result.diminishingReturns) {
    const dr = result.diminishingReturns;
    if (dr.isStale) {
      console.log(
        `\nWarning: ${dr.overlapPercent}% overlap with previous brainstorm cycles (${dr.duplicateIssues.length} duplicate(s))`,
      );
    }
    if (dr.shouldStop) {
      console.log(`Suggestion: Only ${dr.novelCount} novel issue(s) generated. Consider stopping brainstorm cycles.`);
    }
  }
}
