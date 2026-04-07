// Handoff context injection — builds per-wave context from previous wave artifacts.
// Each wave gets a focused, formatted summary (not raw JSON) of only the handoffs it needs.

import type {
  AssessResult,
  Issue,
  QualityResult,
  ReviewResult,
  SpecResult,
  WaveName,
  WaveResult,
} from '../types/index.js';

/** Approximate tokens from character count (~4 chars/token). */
const CHARS_PER_TOKEN = 4;
const DEFAULT_TOKEN_BUDGET = 8_000;

export interface ContextOptions {
  /** PR context string to append (only for spec/impl waves). */
  prContext?: string;
  /** Coverage threshold percentage (quality wave). */
  coverageThreshold?: number;
  /** Whether this is a re-impl after review findings. */
  isReimpl?: boolean;
  /** Token budget for truncation (default: 8000). */
  tokenBudget?: number;
  /** Escalation hint injected after diagnosis (APPROACH_WRONG / MISSING_CONTEXT). */
  escalationHint?: string;
}

type Handoffs = Partial<Record<string, WaveResult>>;

/**
 * Build focused context for a wave from previous handoff artifacts.
 * Each wave gets only the sections it needs — no raw JSON dumps.
 */
export function buildWaveContext(
  wave: WaveName,
  issue: Issue,
  handoffs: Handoffs,
  options: ContextOptions = {},
): string {
  const { tokenBudget = DEFAULT_TOKEN_BUDGET } = options;

  const builders: Record<string, () => string> = {
    spec: () => buildSpecContext(issue, handoffs, options),
    test: () => buildTestContext(handoffs),
    impl: () => buildImplContext(handoffs, options),
    quality: () => buildQualityContext(options),
    review: () => buildReviewContext(handoffs),
  };

  const builder = builders[wave];
  if (!builder) {
    return '';
  }

  return truncateToTokenBudget(builder(), tokenBudget);
}

/**
 * Truncate text to fit within a token budget.
 * Uses a rough 4-chars-per-token heuristic.
 */
export function truncateToTokenBudget(text: string, tokenBudget: number): string {
  const charBudget = tokenBudget * CHARS_PER_TOKEN;
  if (text.length <= charBudget) {
    return text;
  }
  const truncated = text.slice(0, charBudget);
  return `${truncated}\n\n[truncated — exceeded ${tokenBudget} token budget]`;
}

// --- Type guards for runtime safety ---

function isAssessResult(v: unknown): v is AssessResult {
  return v != null && typeof v === 'object' && 'grade' in v && 'surface_area' in v;
}

function isSpecResult(v: unknown): v is SpecResult {
  return v != null && typeof v === 'object' && 'pieces' in v && Array.isArray((v as SpecResult).pieces);
}

function isQualityResult(v: unknown): v is QualityResult {
  return v != null && typeof v === 'object' && 'all_passing' in v && 'lint' in v;
}

function isReviewResult(v: unknown): v is ReviewResult {
  return v != null && typeof v === 'object' && 'verdict' in v && 'findings' in v;
}

// --- Per-wave context builders ---

function buildSpecContext(issue: Issue, handoffs: Handoffs, options: ContextOptions): string {
  const sections: string[] = [];

  sections.push(`# Issue #${issue.number}: ${issue.title}\n\n${issue.body}`);

  const assess = handoffs.assess?.artifact;
  if (isAssessResult(assess)) {
    sections.push(formatAssessSection(assess));
  }

  if (options.prContext) {
    sections.push(options.prContext);
  }

  return sections.join('\n\n');
}

function buildTestContext(handoffs: Handoffs): string {
  const sections: string[] = [];

  const spec = handoffs.spec?.artifact;
  if (isSpecResult(spec)) {
    sections.push(formatSpecSection(spec));
  }

  return sections.join('\n\n');
}

function buildImplContext(handoffs: Handoffs, options: ContextOptions): string {
  const sections: string[] = [];

  if (options.escalationHint) {
    sections.push(`## Escalation\n\n${options.escalationHint}`);
  }

  if (options.isReimpl) {
    const review = handoffs.review?.artifact;
    if (isReviewResult(review)) {
      sections.push(formatReviewFindingsSection(review));
    }
  }

  const spec = handoffs.spec?.artifact;
  if (isSpecResult(spec)) {
    sections.push(formatSpecSection(spec));
  }

  const test = handoffs.test?.artifact as { test_files_created?: string[]; test_count?: number } | undefined;
  if (test?.test_files_created && test.test_files_created.length > 0) {
    const fileList = test.test_files_created.map((f) => `- ${f}`).join('\n');
    sections.push(`## Test Files (${test.test_count ?? test.test_files_created.length} tests)\n\n${fileList}`);
  }

  if (options.prContext) {
    sections.push(options.prContext);
  }

  return sections.join('\n\n');
}

function buildQualityContext(options: ContextOptions): string {
  const threshold = options.coverageThreshold ?? 80;
  return `Run all quality gates: lint, typecheck, tests, coverage (threshold: ${threshold}%). Fix any failures.`;
}

function buildReviewContext(handoffs: Handoffs): string {
  const sections: string[] = [];

  const spec = handoffs.spec?.artifact;
  if (isSpecResult(spec)) {
    sections.push(`## Spec Summary\n\n${spec.summary}`);
  }

  const quality = handoffs.quality?.artifact;
  if (isQualityResult(quality)) {
    sections.push(formatQualitySection(quality));
  }

  return sections.join('\n\n');
}

// --- Formatting helpers ---

function formatAssessSection(assess: AssessResult): string {
  const files =
    assess.surface_area.files.length > 0
      ? assess.surface_area.files.map((f) => `- ${f}`).join('\n')
      : 'None identified';

  return [
    `## Assessment`,
    ``,
    `- **Grade:** ${assess.grade}`,
    `- **Risk:** ${assess.risk}`,
    `- **Estimated lines:** ${assess.surface_area.estimated_lines}`,
    `- **Modules:** ${assess.surface_area.modules_affected.join(', ') || 'N/A'}`,
    ``,
    `### Surface Area`,
    files,
    ``,
    `### Reasoning`,
    assess.reasoning,
  ].join('\n');
}

function formatSpecSection(spec: SpecResult): string {
  const pieces = spec.pieces
    .map((p) => {
      const criteria = p.acceptance_criteria.map((c) => `  - ${c}`).join('\n');
      const files = p.files.map((f) => `  - ${f}`).join('\n');
      return [`### ${p.name}`, p.description, ``, `**Files:**`, files, ``, `**Acceptance Criteria:**`, criteria].join(
        '\n',
      );
    })
    .join('\n\n');

  const constraints =
    spec.constraints.length > 0 ? `\n\n## Constraints\n${spec.constraints.map((c) => `- ${c}`).join('\n')}` : '';

  return `## Spec: ${spec.summary}\n\n${pieces}${constraints}`;
}

function formatQualitySection(quality: QualityResult): string {
  const coverage = quality.coverage != null ? `${quality.coverage}%` : 'N/A';
  return [
    `## Quality Gates`,
    ``,
    `- lint: ${quality.lint}`,
    `- typecheck: ${quality.typecheck}`,
    `- tests: ${quality.tests}`,
    `- coverage: ${coverage}`,
    `- audit: ${quality.audit}`,
    `- all passing: ${quality.all_passing}`,
  ].join('\n');
}

function formatReviewFindingsSection(review: ReviewResult): string {
  const findings = review.findings
    .map((f) => {
      const loc = f.line != null ? `${f.file} line ${f.line}` : f.file;
      return `- [${f.severity}] ${loc}: ${f.description} (${f.category})`;
    })
    .join('\n');

  return `## Review findings\n\n${review.summary}\n\n${findings}`;
}
