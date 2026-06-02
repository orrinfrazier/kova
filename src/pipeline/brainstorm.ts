// Brainstorm orchestrator — spawns an opus agent to analyze a codebase
// and generate a structured suite of issue suggestions.

import { z } from 'zod';
import {
  getModelString,
  getWaveTools,
  type OutputFormat,
  resolveThinkingLevel,
  resolveWaveModel,
  spawnWaveAgent,
} from '../ai/index.js';
import {
  appendCycle,
  type DiminishingReturnsReport,
  detectDiminishingReturns,
  loadHistory,
} from '../services/brainstorm-history.js';
import {
  type CrossRepoConfig,
  classifyProposalsAgainstOpenIssues,
  fetchCrossRepoIssues,
  fetchSameRepoIssues,
  formatCrossRepoContext,
  formatSameRepoContext,
  type ProposalSkipEntry,
} from '../services/cross-repo-issues.js';
import { loadProjectContext } from '../services/project-context.js';
import type { BrainstormIssue, BrainstormResult, RepoConfig } from '../types/index.js';
import { BrainstormResultSchema } from '../types/index.js';
import { log } from '../utils/logger.js';
import { loadPrompt, resolvePromptsDir } from './prompts.js';
import { loadWaveSkills } from './skills-loader.js';

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
  kovaConfig?: CrossRepoConfig | undefined;
}

export interface BrainstormReturn {
  success: boolean;
  issues: BrainstormIssue[];
  filtered: BrainstormIssue[];
  /**
   * Proposals dropped because they collide with an existing open issue in the
   * same repo. Each entry records the proposal and the matched open-issue title.
   * Undefined / empty when no same-repo dedup was performed or no collisions
   * were found.
   */
  skipped?: ProposalSkipEntry[];
  summary?: string;
  cost: number;
  model: string;
  error?: string;
  diminishingReturns?: DiminishingReturnsReport;
}

export async function brainstorm(options: BrainstormOptions): Promise<BrainstormReturn> {
  const { repoPath, config, threshold = DEFAULT_CONFIDENCE_THRESHOLD, focus, kovaConfig } = options;

  const model = resolveWaveModel(config.model.brainstorm);
  const tools = getWaveTools('brainstorm', repoPath);
  const projectContext = await loadProjectContext(repoPath);
  const resolvedPromptsDir = resolvePromptsDir(repoPath, config.prompts_dir);

  // Issue #298: surface SKILL.md skills to the brainstorm system prompt when
  // configured. Mirrors the loading pattern in `fix()` — undefined config or an
  // empty skill set leaves the prompt unchanged (backward compat).
  const skills = config.skills ? await loadWaveSkills({ dirs: config.skills.dirs, cwd: repoPath }) : [];
  const systemPrompt = await loadPrompt('brainstorm', undefined, projectContext, resolvedPromptsDir, {
    ...(skills.length > 0 &&
      config.skills && {
        skills: { skills, enabledWaves: config.skills.enabled_waves },
      }),
  });
  const thinkingLevel = resolveThinkingLevel(config, 'brainstorm');

  const focusAreas = focus ?? config.rules.focus;

  // Fetch cross-repo issues for dedup context (best-effort)
  let crossRepoContext = '';
  if (kovaConfig) {
    try {
      const crossRepoEntries = await fetchCrossRepoIssues(repoPath, kovaConfig);
      crossRepoContext = formatCrossRepoContext(crossRepoEntries);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[brainstorm] Cross-repo issue fetch failed (continuing): ${message}`);
    }
  }

  // Fetch same-repo open issues for in-repo dedup + post-hoc classification (best-effort)
  let sameRepoIssues: Awaited<ReturnType<typeof fetchSameRepoIssues>> = [];
  let sameRepoContext = '';
  try {
    sameRepoIssues = await fetchSameRepoIssues(repoPath);
    sameRepoContext = formatSameRepoContext(sameRepoIssues);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[brainstorm] Same-repo issue fetch failed (continuing): ${message}`);
  }

  let userMessage = `Analyze the codebase at ${repoPath} and identify improvements. Read key files, understand the architecture, then produce a structured list of issues.`;
  if (focusAreas && focusAreas.length > 0) {
    userMessage += `\n\nIMPORTANT: ONLY generate issues within these focus areas: ${focusAreas.join(', ')}. Do not generate issues outside these categories.`;
  }
  if (crossRepoContext) {
    userMessage += crossRepoContext;
  }
  if (sameRepoContext) {
    userMessage += sameRepoContext;
  }

  try {
    const handoff = await spawnWaveAgent<BrainstormResult>({
      wave: 'brainstorm',
      model: getModelString(model),
      tools,
      systemPrompt,
      handoffContext: '',
      userMessage,
      cwd: repoPath,
      thinkingLevel,
      outputFormat: toOutputFormat(BrainstormResultSchema),
    });

    if (handoff.confidence === 'low' || handoff.parsed === false) {
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

    // Classify proposals against currently-open same-repo issues. Skipped
    // proposals are dropped from both `issues` and `filtered` and surfaced
    // as a separate `skipped` list so the user sees what was already tracked.
    const { kept, skipped } = classifyProposalsAgainstOpenIssues(artifact.issues, sameRepoIssues);

    const passing = kept.filter((issue) => issue.confidence >= threshold);
    const filtered = kept.filter((issue) => issue.confidence < threshold);

    // Diminishing returns detection runs against ALL agent proposals
    // (kept + skipped) — staleness is a property of agent output, not a
    // property of post-classification kept set.
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
      skipped,
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
      model: getModelString(model),
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

  if (result.skipped && result.skipped.length > 0) {
    console.log(`Skipped as already-tracked: ${result.skipped.length}\n`);
    for (const entry of result.skipped) {
      console.log(`  - ${entry.proposal.title}`);
      console.log(`     matched open issue: ${entry.matchedTitle}`);
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
