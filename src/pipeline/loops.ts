// T↔I loop controller — orchestrator-driven test/impl retry loop.
// R→I→T review loop controller — review/impl/test retry loop.
// Test agent runs once (writes tests). Impl agent spawns fresh per attempt.
// Tests run via bash (orchestrator), NOT via the agent.

import { exec as execCb } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { buildWaveSessionId, type OutputFormat, resolveThinkingLevel } from '../ai/index.js';
import { dispatchExecuteWave, type SandboxContext } from '../sandbox/dispatch.js';
import { detectTooling } from '../services/language-detect.js';
import type { ProjectContext } from '../services/project-context.js';
import { compareBaselineFailures } from '../services/review-baseline.js';
import { scanDiffForBlockingFindings } from '../services/review-prescan.js';
import type {
  Issue,
  QualityRemediation,
  QualityResult,
  RepoConfig,
  ReviewFinding,
  ReviewResult,
  SpecPiece,
  SpecResult,
  WaveName,
  WaveResult,
} from '../types/index.js';
import { ReviewResultSchema } from '../types/index.js';
import { log } from '../utils/logger.js';
import { executePiecesInBatches } from './batch-scheduler.js';
import { buildPieceContext, buildWaveContext } from './context.js';
import { loadPrompt, resolvePromptsDir } from './prompts.js';
import { classifyReviewFindings } from './review-classifier.js';
import { loadReviewPersonaPrompt, selectReviewerPersona } from './review-persona.js';

const exec = promisify(execCb);

// --- Types ---

export interface TestRunResult {
  passed: boolean;
  output: string;
  exitCode: number;
}

export type TestRunner = (command: string, workDir: string) => Promise<TestRunResult>;

export type TILoopDiagnosis = 'SPEC_WRONG' | 'APPROACH_WRONG' | 'MISSING_CONTEXT' | 'STUCK';

export type ThrashingSignal = 'SAME_FILES' | 'DIFFERENT_FILES' | 'NORMAL' | 'INSUFFICIENT_DATA';

export type DiffRunner = (workDir: string) => Promise<string[]>;

export type FileReader = (filePath: string) => Promise<string>;

export interface TILoopConfig {
  issue: Issue;
  workDir: string;
  repoConfig: RepoConfig;
  waveResults: Partial<Record<WaveName, WaveResult>>;
  maxRetries?: number;
  /**
   * Extra impl attempts granted on top of the default budget (issue #282
   * explore-mode plumbing). Same semantics as `PieceTILoopConfig.extraImplAttempts`:
   * raises `maxRetries` from 3 to `3 + extraImplAttempts`, unless `maxRetries`
   * is explicitly set (explicit wins).
   */
  extraImplAttempts?: number;
  testCommand?: string;
  prContext?: string;
  codebaseContext?: string;
  /** Issue #273 — exact graph spans + callers/callees for issue-named symbols. */
  codegraphContext?: string;
  /** Issue #275 — framework-resolved route→handler bindings + 1-hop callers/callees. */
  callPathContext?: string;
  projectContext?: ProjectContext | undefined;
  testRunner?: TestRunner;
  diffRunner?: DiffRunner;
  fileReader?: FileReader;
  /**
   * When set, every wave inside this loop is routed through the docker sandbox
   * container instead of running in-process on the host. This is the integration
   * point for `config.isolation === 'docker'` (see issue #319).
   */
  sandbox?: SandboxContext | undefined;
  /**
   * Optional prompt-cache affinity context (issue #297). When set, every
   * test/impl wave inside this loop is dispatched with a deterministic
   * sessionId of the form `kova-<repo>-<issue>-<wave>`.
   */
  cacheContext?: { repo: string; issue: string | number };
  /**
   * Issue #283 — when true, skip the test-writing wave inside the TI loop
   * and run impl against tests that already exist in the worktree. Used by
   * pipeline-scope IMPL_ONLY and REFACTOR.
   */
  skipTestPhase?: boolean | undefined;
  /**
   * Issue #283 — when true, skip the impl wave and impl retry loop. Used by
   * pipeline-scope TEST_ONLY: the orchestrator wants tests written but no
   * implementation. The returned `implWaveResult` is a synthetic skip-marker.
   */
  skipImplPhase?: boolean | undefined;
}

export interface TILoopResult {
  testWaveResult: WaveResult;
  implWaveResult: WaveResult;
  testsPassing: boolean;
  totalCost: number;
  attempts: number;
  diagnosis?: TILoopDiagnosis;
  shouldRespec?: boolean;
  modifiedFilesPerAttempt: string[][];
  thrashingSignal?: ThrashingSignal;
}

export type FileWriter = (filePath: string, content: string) => Promise<void>;

/**
 * Pre-scan runner injectable for tests. Returns deterministic blocking
 * findings (secrets, eval/injection) over diff-added lines.
 */
export type PrescanRunner = (workDir: string) => Promise<{
  findings: Array<{ file: string; line: number | null; type: string; snippet: string }>;
  blocking: boolean;
  summary: string;
}>;

export interface ReviewLoopConfig {
  issue: Issue;
  workDir: string;
  repoConfig: RepoConfig;
  waveResults: Partial<Record<WaveName, WaveResult>>;
  maxIterations?: number;
  testCommand?: string;
  testRunner?: TestRunner;
  fileWriter?: FileWriter;
  prContext?: string;
  projectContext?: ProjectContext | undefined;
  playwright?: { enabled: boolean } | undefined;
  reviewFeedbackContext?: string;
  /**
   * Pre-formatted regression-surface context (#276) — dependents (callers +
   * importers) of the symbols/files changed in the worktree. Computed by
   * fix.ts from the codegraph before this loop is entered. When set, it is
   * injected into every review iteration so the reviewer reads dependents
   * alongside the quality report.
   */
  regressionSurfaceContext?: string;
  /** Route every wave through the docker sandbox container when set. */
  sandbox?: SandboxContext | undefined;
  /**
   * Optional prompt-cache affinity context (issue #297). When set, the review
   * + per-piece test/impl waves inside this loop are dispatched with a
   * deterministic sessionId built via `buildWaveSessionId(...)`.
   */
  cacheContext?: { repo: string; issue: string | number };
  /**
   * Optional pre-scan over diff-added lines. When provided and the result is
   * `blocking`, the orchestrator forces verdict = needs_fixes regardless of
   * the model's judgment. Hits are surfaced as critical findings.
   */
  prescanRunner?: PrescanRunner;
  /**
   * Baseline failing-test names recorded before WAVE I ran. Compared against
   * `currentFailures` to detect newly-failing tests (regressions). Provide
   * both, or neither — providing only one is a no-op.
   */
  baselineFailures?: string[];
  /**
   * Current failing-test names after WAVE I. See `baselineFailures`.
   */
  currentFailures?: string[];
}

export interface ReviewLoopResult {
  reviewWaveResult: WaveResult;
  qualityWaveResult?: WaveResult | undefined;
  totalCost: number;
  iterations: number;
  knownIssues: ReviewFinding[];
}

// --- Per-piece TI loop types ---

export interface PieceTILoopConfig {
  piece: SpecPiece;
  pieceIndex: number;
  workDir: string;
  repoConfig: RepoConfig;
  maxRetries?: number | undefined;
  /**
   * Extra impl attempts granted on top of the default budget (issue #282
   * explore-mode plumbing). Increases `maxRetries` from the default 3 to
   * `3 + extraImplAttempts`. Ignored when `maxRetries` is explicitly set —
   * explicit `maxRetries` always wins so callers can override unconditionally.
   */
  extraImplAttempts?: number | undefined;
  testCommand?: string | undefined;
  projectContext?: ProjectContext | undefined;
  testRunner?: TestRunner | undefined;
  diffRunner?: DiffRunner | undefined;
  /**
   * Optional file reader for MISSING_CONTEXT diagnosis (issue #284).
   * When the mid-loop diagnosis is MISSING_CONTEXT, paths cited in the
   * failure output are read via this reader and injected into the impl
   * context. Defaults to `defaultFileReader` (fs.readFile).
   */
  fileReader?: FileReader | undefined;
  /** Route every wave through the docker sandbox container when set. */
  sandbox?: SandboxContext | undefined;
  /**
   * Optional prompt-cache affinity context (issue #297). Forwarded to every
   * dispatched test/impl wave so the provider can key prompt caching off
   * `kova-<repo>-<issue>-<wave>`.
   */
  cacheContext?: { repo: string; issue: string | number } | undefined;
  /**
   * When true, skip the test-writing wave and run impl only against tests
   * that already exist in the worktree. Used by pipeline-scope IMPL_ONLY and
   * REFACTOR (issue #283). The returned `testWaveResult` is a synthetic
   * skip-marker; impl still runs the test command via `testRunner` to gate
   * its retries.
   */
  skipTestPhase?: boolean | undefined;
  /**
   * Issue #283 — when true, skip the impl wave and impl retry loop. Used by
   * pipeline-scope TEST_ONLY. The returned `implWaveResult` is a synthetic
   * skip-marker.
   */
  skipImplPhase?: boolean | undefined;
}

export interface PieceTILoopResult {
  pieceIndex: number;
  testWaveResult: WaveResult;
  implWaveResult: WaveResult;
  testsPassing: boolean;
  cost: number;
  attempts: number;
  diagnosis?: TILoopDiagnosis;
  /**
   * True when mid-loop diagnosis was SPEC_WRONG and the loop broke early.
   * The orchestrator should re-run spec rather than burn more retries.
   * Issue #284 — parity with runTILoop.
   */
  shouldRespec?: boolean;
}

export interface ParallelPieceTILoopConfig {
  issue: Issue;
  workDir: string;
  repoConfig: RepoConfig;
  waveResults: Partial<Record<WaveName, WaveResult>>;
  maxConcurrent?: number | undefined;
  testCommand?: string | undefined;
  testRunner?: TestRunner | undefined;
  diffRunner?: DiffRunner | undefined;
  prContext?: string | undefined;
  codebaseContext?: string | undefined;
  /** Issue #273 — exact graph spans + callers/callees for issue-named symbols. */
  codegraphContext?: string | undefined;
  /** Issue #275 — framework-resolved route→handler bindings + 1-hop callers/callees. */
  callPathContext?: string | undefined;
  projectContext?: ProjectContext | undefined;
  /** Route every wave through the docker sandbox container when set. */
  sandbox?: SandboxContext | undefined;
  /**
   * Optional prompt-cache affinity context (issue #297). When set, every
   * test/impl wave inside this loop is dispatched with a deterministic
   * sessionId of the form `kova-<repo>-<issue>-<wave>`. Built upstream by
   * fix.ts via `buildWaveSessionId(...)`.
   */
  cacheContext?: { repo: string; issue: string | number };
  /**
   * Issue #283 — when true, skip the test-writing wave per piece and rely on
   * the existing test suite as the regression net. Forwarded to every per-
   * piece TI loop. Used by pipeline-scope IMPL_ONLY and REFACTOR.
   */
  skipTestPhase?: boolean | undefined;
  /**
   * Issue #283 — when true, skip the impl wave per piece. Used by
   * pipeline-scope TEST_ONLY.
   */
  skipImplPhase?: boolean | undefined;
  /**
   * Extra impl attempts granted per piece on top of the default budget
   * (issue #282 explore-mode plumbing). Forwarded to every `runPieceTILoop`
   * call and to the 1-piece `runTILoop` shortcut. Default 0.
   */
  extraImplAttempts?: number | undefined;
}

export interface ParallelPieceTILoopResult {
  testWaveResult: WaveResult;
  implWaveResult: WaveResult;
  testsPassing: boolean;
  totalCost: number;
  attempts: number;
  pieceResults: PieceTILoopResult[];
  diagnosis?: TILoopDiagnosis;
  shouldRespec?: boolean;
  modifiedFilesPerAttempt: string[][];
}

// --- Test command resolution ---

const TEST_COMMANDS: Record<string, string> = {
  vitest: 'npx vitest run',
  jest: 'npx jest',
  'cargo-test': 'cargo test',
  'go-test': 'go test ./...',
  pytest: 'pytest',
};

export async function resolveTestCommand(workDir: string, testCommand?: string): Promise<string> {
  if (testCommand) return testCommand;

  const tooling = await detectTooling(workDir);
  if (tooling.testRunner) {
    const cmd = TEST_COMMANDS[tooling.testRunner];
    if (cmd) return cmd;
  }

  throw new Error('Cannot detect test command — provide testCommand in TILoopConfig');
}

// --- Default test runner (bash execution) ---

export const defaultTestRunner: TestRunner = async (command, workDir) => {
  try {
    const { stdout, stderr } = await exec(command, {
      cwd: workDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { passed: true, output: stdout || stderr, exitCode: 0 };
  } catch (error: unknown) {
    const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const output = [e.stderr, e.stdout].filter(Boolean).join('\n') || e.message || String(error);
    const exitCode = typeof e.code === 'number' ? e.code : 1;
    return { passed: false, output, exitCode };
  }
};

// --- Default diff runner (git diff --name-only) ---

export const defaultFileReader: FileReader = async (filePath) => {
  return fs.readFile(filePath, 'utf-8');
};

export const defaultDiffRunner: DiffRunner = async (workDir) => {
  try {
    const { stdout } = await exec('git diff --name-only', {
      cwd: workDir,
      timeout: 10_000,
    });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return [];
  }
};

// --- Thrashing detection ---

/** Compare modified file lists across attempts to detect thrashing patterns. */
export function detectThrashing(modifiedFilesPerAttempt: string[][]): ThrashingSignal {
  if (modifiedFilesPerAttempt.length < 2) return 'INSUFFICIENT_DATA';

  // Filter out empty attempts — no signal from zero modifications
  const nonEmpty = modifiedFilesPerAttempt.filter((files) => files.length > 0);
  if (nonEmpty.length < 2) return 'INSUFFICIENT_DATA';

  // Compare consecutive pairs — average overlap ratio (intersection / avg set size)
  let totalRatio = 0;
  let pairs = 0;

  for (let i = 1; i < nonEmpty.length; i++) {
    const prev = new Set(nonEmpty[i - 1]);
    const curr = nonEmpty[i] as string[];
    const intersection = curr.filter((f) => prev.has(f)).length;
    const avgSize = (prev.size + curr.length) / 2;
    totalRatio += intersection / avgSize;
    pairs++;
  }

  const avgOverlap = totalRatio / pairs;

  if (avgOverlap >= 0.8) return 'SAME_FILES';
  if (avgOverlap < 0.2) return 'DIFFERENT_FILES';
  return 'NORMAL';
}

// --- Output normalization ---

const MISSING_CONTEXT_PATTERNS = [
  /cannot find module/i,
  /no such file or directory/i,
  /not provided/i,
  /cannot resolve/i,
  /module not found/i,
  /could not find/i,
];

// --- Type error detection ---

const TYPE_ERROR_PATTERN = /^(.+?)\(\d+,\d+\):\s*error\s+TS\d+:/;

/** Extract file paths referenced in TypeScript-style error lines (e.g. "src/foo.ts(10,5): error TS2322: ..."). */
function extractErrorFiles(output: string): string[] {
  const files = new Set<string>();
  for (const line of output.split('\n')) {
    const match = line.trim().match(TYPE_ERROR_PATTERN);
    if (match?.[1]) {
      files.add(match[1].trim());
    }
  }
  return [...files];
}

// --- Early first-failure diagnosis ---

/**
 * Classify a diagnosis from a single failure output using static analysis.
 * Returns `undefined` when no confident diagnosis can be made (falls through
 * to the existing 2-attempt `classifyDiagnosis` logic).
 */
export function classifyFirstFailure(output: string, specFiles: string[]): TILoopDiagnosis | undefined {
  if (!output || output.trim().length === 0) return undefined;

  // 1. Import / module-not-found patterns → MISSING_CONTEXT immediately
  if (MISSING_CONTEXT_PATTERNS.some((pattern) => pattern.test(output))) {
    return 'MISSING_CONTEXT';
  }

  // 2. Check if errors reference files outside the spec's file list → MISSING_CONTEXT
  const errorFiles = extractErrorFiles(output);
  if (errorFiles.length > 0 && specFiles.length > 0) {
    const specSet = new Set(specFiles);
    const allInScope = errorFiles.every((f) => specSet.has(f));

    if (!allInScope) {
      return 'MISSING_CONTEXT';
    }

    // 3. All type errors are in spec-listed files → likely APPROACH_WRONG
    return 'APPROACH_WRONG';
  }

  // 4. No confident diagnosis — fall through to existing 2-attempt logic
  return undefined;
}

/** Strip timestamps, durations, line numbers, and summary counts so outputs are comparable across runs. */
export function normalizeTestOutput(output: string): string {
  return output
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\d.]*Z?\s*/g, '') // ISO timestamps
    .replace(/\b\d+(\.\d+)?m?s\b/g, '') // durations: 123ms, 1.234s, 0.5s
    .replace(/:\d+:\d+/g, '') // file:line:col references
    .replace(/\b\d+ (failed|passed)\b/g, '') // summary counts: "2 failed, 8 passed"
    .replace(/Time:\s+\S+/g, '') // Time: 1.234s
    .replace(/Duration:\s+\S+/g, ''); // Duration: 123ms
}

/** Extract failing test names from test runner output (vitest, jest, cargo test, pytest, go test). */
export function extractFailingTestNames(output: string): string[] {
  const names = new Set<string>();

  for (const line of output.split('\n')) {
    const trimmed = line.trim();

    // Vitest: " FAIL  src/auth.test.ts > AuthService > validates expired tokens"
    const vitestMatch = trimmed.match(/^FAIL\s+\S+\s+>\s+(.+)/);
    if (vitestMatch?.[1]) {
      names.add(vitestMatch[1].trim());
      continue;
    }

    // Jest: "  ● AuthService › validates expired tokens"
    const jestMatch = trimmed.match(/^●\s+(.+)/);
    if (jestMatch?.[1]) {
      names.add(jestMatch[1].trim());
      continue;
    }

    // Cargo test: "test auth::tests::validates_expired_tokens ... FAILED"
    const cargoMatch = trimmed.match(/^test\s+(\S+)\s+\.\.\.\s+FAILED/);
    if (cargoMatch?.[1]) {
      names.add(cargoMatch[1]);
      continue;
    }

    // Pytest: "FAILED tests/test_auth.py::TestAuth::test_validates_expired_tokens"
    const pytestMatch = trimmed.match(/^FAILED\s+\S+::(\S+)$/);
    if (pytestMatch?.[1]) {
      names.add(pytestMatch[1]);
      continue;
    }

    // Go test: "--- FAIL: TestValidatesExpiredTokens (0.00s)"
    const goMatch = trimmed.match(/^---\s+FAIL:\s+(\S+)/);
    if (goMatch?.[1]) {
      names.add(goMatch[1]);
    }
  }

  return [...names];
}

// --- Missing file path extraction ---

const MISSING_PATH_PATTERNS = [
  /cannot find module '([^']+)'/gi,
  /no such file or directory,?\s+open\s+'([^']+)'/gi,
  /module not found:.*?'([^']+)'/gi,
  /cannot resolve '([^']+)'/gi,
  /could not find '([^']+)'/gi,
];

/** Extract file paths referenced in missing-module/file error messages. */
export function extractMissingFilePaths(output: string): string[] {
  const paths = new Set<string>();
  for (const pattern of MISSING_PATH_PATTERNS) {
    for (const match of output.matchAll(pattern)) {
      if (match[1]) paths.add(match[1]);
    }
  }
  return [...paths];
}

// --- Diagnosis classification ---

export function classifyDiagnosis(failureOutputs: string[], thrashingSignal?: ThrashingSignal): TILoopDiagnosis {
  if (failureOutputs.length < 2) return 'STUCK';

  // Check for MISSING_CONTEXT patterns across all outputs — highest priority
  const allHaveMissingContext = failureOutputs.every((output) =>
    MISSING_CONTEXT_PATTERNS.some((pattern) => pattern.test(output)),
  );
  if (allHaveMissingContext) return 'MISSING_CONTEXT';

  // Apply thrashing signal overrides before test-output-based classification
  if (thrashingSignal === 'DIFFERENT_FILES') return 'STUCK';

  // Extract failing test names from each attempt
  const namesByAttempt = failureOutputs.map(extractFailingTestNames);
  const allHaveNames = namesByAttempt.every((names) => names.length > 0);

  if (allHaveNames) {
    // Length >= 2 guaranteed by early return above — [0] is safe
    const firstNames = new Set(namesByAttempt[0] as string[]);
    const allSameTests = namesByAttempt.slice(1).every((names) => {
      if (names.length !== firstNames.size) return false;
      return names.every((n) => firstNames.has(n));
    });

    if (allSameTests) {
      // SAME_FILES thrashing: same tests fail + same files modified = wrong strategy, not wrong spec
      return thrashingSignal === 'SAME_FILES' ? 'APPROACH_WRONG' : 'SPEC_WRONG';
    }
    return 'APPROACH_WRONG';
  }

  // Fallback: normalized line overlap (for unrecognized test runners)
  // Length >= 2 guaranteed by early return above — [0] is safe
  const first = normalizeTestOutput(failureOutputs[0] as string);
  const firstLines = new Set(first.split('\n').filter((l) => l.trim().length > 0));

  const allSimilar = failureOutputs.slice(1).every((output) => {
    const normalized = normalizeTestOutput(output);
    const lines = normalized.split('\n').filter((l) => l.trim().length > 0);
    const matching = lines.filter((l) => firstLines.has(l)).length;
    return matching / Math.max(lines.length, 1) > 0.8;
  });

  if (allSimilar) {
    return thrashingSignal === 'SAME_FILES' ? 'APPROACH_WRONG' : 'SPEC_WRONG';
  }
  return 'APPROACH_WRONG';
}

// --- Shared mid-loop diagnosis helper (Issue #284) ---
//
// Both runTILoop (single piece) and runPieceTILoop (per-piece, used for 2+
// pieces) need the same logic to translate a list of failure outputs +
// modified-files history into either an escalation hint, a missing-context
// hint (with injected file contents), or an early-break signal for SPEC_WRONG.
//
// Before this helper existed, runTILoop handled all four diagnoses while
// runPieceTILoop only handled APPROACH_WRONG — multi-piece issues silently
// lost MISSING_CONTEXT file injection, STUCK partial-fix hinting, and
// SPEC_WRONG early-break. See the spec on issue #284.

export interface MidLoopDiagnosisInput {
  /** All test failure outputs collected so far this loop. */
  failureOutputs: string[];
  /** Files modified per impl attempt (parallel to failureOutputs). Empty array → INSUFFICIENT_DATA thrashing. */
  modifiedFilesPerAttempt: string[][];
  /** Spec-listed files for the current piece (or all spec files for single-piece runTILoop). */
  specFiles: string[];
  /** Resolved working directory for file-reading (used when MISSING_CONTEXT cites relative paths). */
  workDir: string;
  /** Injectable file reader (defaults to fs.readFile via defaultFileReader). */
  fileReader?: FileReader;
}

export interface MidLoopDiagnosisResult {
  /** Hint to prepend to the impl context (APPROACH_WRONG / STUCK). */
  escalationHint?: string;
  /** Block of file contents to append to the impl context (MISSING_CONTEXT). */
  missingContextHint?: string;
  /** True when the helper detected SPEC_WRONG — caller should break the impl retry loop. */
  shouldBreakForRespec: boolean;
}

/**
 * Given the failure history of an impl retry loop, decide what hint (if any)
 * to inject into the next impl context, and whether to break early for
 * re-spec. Shared between runTILoop and runPieceTILoop so both loops respond
 * to every diagnosis type identically. See issue #284.
 */
export async function applyMidLoopDiagnosis(input: MidLoopDiagnosisInput): Promise<MidLoopDiagnosisResult> {
  const { failureOutputs, modifiedFilesPerAttempt, specFiles, workDir, fileReader = defaultFileReader } = input;

  if (failureOutputs.length < 2) {
    return { shouldBreakForRespec: false };
  }

  const thrashing = detectThrashing(modifiedFilesPerAttempt);
  const diagnosis = classifyDiagnosis(failureOutputs, thrashing);
  log.info(`[mid-loop-diagnosis] After ${failureOutputs.length} failures: ${diagnosis} (thrashing: ${thrashing})`);

  switch (diagnosis) {
    case 'APPROACH_WRONG': {
      const prevAttempts = failureOutputs
        .map((output, i) => `### Attempt ${i + 1}\n\`\`\`\n${output}\n\`\`\``)
        .join('\n\n');
      return {
        escalationHint: `Diagnosis: APPROACH_WRONG — each attempt fails different tests.\nThe previous approach failed. Try a fundamentally different strategy.\n\n${prevAttempts}`,
        shouldBreakForRespec: false,
      };
    }
    case 'SPEC_WRONG': {
      // Break early — spec needs re-running, no point trying more impl attempts.
      return { shouldBreakForRespec: true };
    }
    case 'MISSING_CONTEXT': {
      // Extract file paths from errors, read them, inject as context.
      const lastOutput = failureOutputs.at(-1) ?? '';
      const missingPaths = extractMissingFilePaths(lastOutput);
      if (missingPaths.length === 0) {
        // specFiles is unused for MISSING_CONTEXT today, but is reserved for
        // future per-piece scoping (e.g. only inject files inside the piece).
        void specFiles;
        return { shouldBreakForRespec: false };
      }
      const fileContents: string[] = [];
      for (const filePath of missingPaths) {
        try {
          const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(workDir, filePath);
          const content = await fileReader(resolvedPath);
          fileContents.push(`### ${filePath}\n\`\`\`\n${content}\n\`\`\``);
        } catch {
          log.warn(`[mid-loop-diagnosis] Could not read missing file: ${filePath}`);
        }
      }
      if (fileContents.length === 0) {
        return { shouldBreakForRespec: false };
      }
      return {
        missingContextHint: `## Missing Context — Injected Files\n\nThe previous attempt failed because these files were referenced but not available to you:\n\n${fileContents.join('\n\n')}`,
        shouldBreakForRespec: false,
      };
    }
    case 'STUCK': {
      // Inject partial-fix hint — focus on passing a subset of tests.
      const lastOutput = failureOutputs.at(-1) ?? '';
      const failedMatch = lastOutput.match(/(\d+)\s+failed/);
      const passedMatch = lastOutput.match(/(\d+)\s+passed/);
      const failedCount = failedMatch?.[1] ? Number.parseInt(failedMatch[1], 10) : 0;
      const passedCount = passedMatch?.[1] ? Number.parseInt(passedMatch[1], 10) : 0;
      const countInfo = failedCount > 0 || passedCount > 0 ? ` (${failedCount} failing, ${passedCount} passing)` : '';
      return {
        escalationHint: `Diagnosis: STUCK — repeated attempts have not made progress${countInfo}.\nFocus on a partial fix: keep passing tests green and fix the easiest failing test first. It is acceptable to submit a partial solution that passes a subset of tests.`,
        shouldBreakForRespec: false,
      };
    }
  }
}

// --- Wave result conversion ---

/**
 * Convert a dispatch result into a `WaveResult`. Exported for unit testing
 * the consensus-telemetry propagation contract (#262); internal call sites
 * use it directly.
 *
 * When the dispatch result carries optional `consensus` metadata (only
 * threaded through when the wave ran via a pool/adjudicator), it's copied
 * onto the resulting `WaveResult`. Single-model dispatch results leave the
 * field undefined — existing consumers stay unaffected.
 */
export function toWaveResult(
  wave: WaveName,
  execResult: {
    result: string | null;
    success: boolean;
    duration: number;
    cost: number;
    turns: number;
    model?: string | undefined;
    provider?: string | undefined;
    structuredOutput?: unknown;
    consensus?: import('../types/index.js').WaveResultConsensus | undefined;
  },
): WaveResult {
  return {
    wave,
    success: execResult.success,
    artifact: execResult.structuredOutput ?? execResult.result,
    duration: execResult.duration,
    cost: execResult.cost,
    turns: execResult.turns,
    ...(execResult.model != null && { model: execResult.model }),
    ...(execResult.provider != null && { provider: execResult.provider }),
    ...(execResult.consensus != null && { consensus: execResult.consensus }),
  };
}

// --- TI Loop Controller ---

export async function runTILoop(config: TILoopConfig): Promise<TILoopResult> {
  const {
    issue,
    workDir,
    repoConfig,
    waveResults,
    prContext,
    codebaseContext,
    codegraphContext,
    callPathContext,
    projectContext,
    testRunner = defaultTestRunner,
    diffRunner = defaultDiffRunner,
    fileReader = defaultFileReader,
    sandbox,
    cacheContext,
    skipTestPhase = false,
    skipImplPhase = false,
    extraImplAttempts,
  } = config;
  // Issue #282 explore-mode plumbing: explicit `maxRetries` wins; otherwise
  // raise the default 3-attempt budget by `extraImplAttempts` (0 by default).
  const maxRetries =
    config.maxRetries ?? (extraImplAttempts != null && extraImplAttempts > 0 ? 3 + extraImplAttempts : 3);
  // Issue #297: build per-wave sessionIds once so every dispatched call gets
  // a stable cache-affinity key without re-deriving the slug on each turn.
  const testSessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: 'test' }) : undefined;
  const implSessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: 'impl' }) : undefined;

  if (maxRetries < 1) {
    throw new Error('maxRetries must be at least 1');
  }

  const testCmd = await resolveTestCommand(workDir, config.testCommand);
  log.info(`[ti-loop] Test command: ${testCmd}`);

  let totalCost = 0;
  const resolvedPromptsDir = resolvePromptsDir(repoConfig.path, repoConfig.prompts_dir);

  // Step 1: Spawn test agent — writes tests, verifies they fail.
  // Issue #283: when the pipeline scope says to skip the test wave (IMPL_ONLY
  // / REFACTOR), use a synthetic skip-result. Impl still gates on testRunner
  // below so existing red tests guide the retry loop.
  let testWaveResult: WaveResult;
  if (skipTestPhase) {
    log.info('[ti-loop] Test wave skipped by pipeline scope');
    testWaveResult = {
      wave: 'test',
      success: true,
      artifact: { skipped: true, reason: 'pipeline-scope' },
      duration: 0,
      cost: 0,
      turns: 0,
    };
  } else {
    log.info('[ti-loop] Running test wave (write failing tests)');
    const testSystemPrompt = await loadPrompt('test', repoConfig.tools, projectContext, resolvedPromptsDir);
    const testExecResult = await dispatchExecuteWave(
      {
        wave: 'test',
        systemPrompt: testSystemPrompt,
        userMessage: buildWaveContext('test', issue, waveResults),
        cwd: workDir,
        modelTier: repoConfig.model.test,
        thinkingLevel: resolveThinkingLevel(repoConfig, 'test'),
        customTools: repoConfig.tools,
        ...(testSessionId != null && { sessionId: testSessionId }),
      },
      sandbox,
    );

    testWaveResult = toWaveResult('test', testExecResult);
    totalCost += testExecResult.cost;
  }

  // Prepare updated wave results with test for impl context building
  const updatedWaveResults = { ...waveResults, test: testWaveResult };

  // Issue #283: TEST_ONLY scope — skip the impl retry loop entirely. Return a
  // synthetic impl wave result and `testsPassing: true` (tests written; not
  // yet expected to pass).
  if (skipImplPhase) {
    log.info('[ti-loop] Impl wave skipped by pipeline scope (TEST_ONLY)');
    const implSkip: WaveResult = {
      wave: 'impl',
      success: true,
      artifact: { skipped: true, reason: 'pipeline-scope' },
      duration: 0,
      cost: 0,
      turns: 0,
    };
    return {
      testWaveResult,
      implWaveResult: implSkip,
      testsPassing: true,
      totalCost,
      attempts: 0,
      modifiedFilesPerAttempt: [],
    };
  }

  // Step 2: Impl retry loop — orchestrator runs tests via bash
  const failureOutputs: string[] = [];
  const modifiedFilesPerAttempt: string[][] = [];
  let implWaveResult: WaveResult | undefined;
  let testsPassing = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    log.info(`[ti-loop] Impl attempt ${attempt + 1}/${maxRetries}`);

    // Classify diagnosis mid-loop to drive strategy per diagnosis type
    let escalationHint: string | undefined;
    let missingContextHint: string | undefined;
    let shouldBreakForRespec = false;

    // Early diagnosis after first failure via static analysis (saves 1 retry cycle)
    if (failureOutputs.length === 1) {
      const specArtifact = waveResults.spec?.artifact;
      const specFiles = isSpecResult(specArtifact) ? specArtifact.pieces.flatMap((p) => p.files) : [];
      const earlyDiagnosis = classifyFirstFailure(failureOutputs[0] as string, specFiles);
      if (earlyDiagnosis != null) {
        escalationHint = `Early diagnosis: ${earlyDiagnosis} — detected from first failure output.\n\n### Attempt 1\n\`\`\`\n${failureOutputs[0]}\n\`\`\``;
      }
    }

    // Diagnosis-driven strategy after 2+ failures — delegated to shared helper (issue #284)
    if (failureOutputs.length >= 2) {
      const specArtifact = waveResults.spec?.artifact;
      const specFiles = isSpecResult(specArtifact) ? specArtifact.pieces.flatMap((p) => p.files) : [];
      const midResult = await applyMidLoopDiagnosis({
        failureOutputs,
        modifiedFilesPerAttempt,
        specFiles,
        workDir,
        fileReader,
      });
      escalationHint = midResult.escalationHint ?? escalationHint;
      missingContextHint = midResult.missingContextHint;
      shouldBreakForRespec = midResult.shouldBreakForRespec;
    }

    // SPEC_WRONG: break early — caller will re-run spec
    if (shouldBreakForRespec) {
      log.info('[ti-loop] SPEC_WRONG detected mid-loop — breaking early for re-spec');
      break;
    }

    // Build impl context — fresh each time with spec + test failures only
    let implContext = buildWaveContext('impl', issue, updatedWaveResults, {
      ...(prContext != null && { prContext }),
      ...(codegraphContext != null && { codegraphContext }),
      ...(callPathContext != null && { callPathContext }),
      ...(codebaseContext != null && { codebaseContext }),
      ...(escalationHint != null && { escalationHint }),
    });
    if (missingContextHint != null) {
      implContext += `\n\n${missingContextHint}`;
    }
    if (failureOutputs.length > 0) {
      const lastFailure = failureOutputs.at(-1) as string;
      implContext += `\n\n## Previous Test Failure Output\n\n\`\`\`\n${lastFailure}\n\`\`\``;
    }

    const implSystemPrompt = await loadPrompt('impl', repoConfig.tools, projectContext, resolvedPromptsDir);
    const implExecResult = await dispatchExecuteWave(
      {
        wave: 'impl',
        systemPrompt: implSystemPrompt,
        userMessage: implContext,
        cwd: workDir,
        modelTier: repoConfig.model.impl,
        thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
        customTools: repoConfig.tools,
        ...(implSessionId != null && { sessionId: implSessionId }),
      },
      sandbox,
    );

    implWaveResult = toWaveResult('impl', implExecResult);
    totalCost += implExecResult.cost;

    // Capture modified files after impl, before test run
    const modifiedFiles = await diffRunner(workDir);
    modifiedFilesPerAttempt.push(modifiedFiles);

    // Run tests via bash — orchestrator, NOT the agent
    log.info(`[ti-loop] Running tests via bash: ${testCmd}`);
    const testRun = await testRunner(testCmd, workDir);

    if (testRun.passed) {
      log.info(`[ti-loop] Tests passing on attempt ${attempt + 1}`);
      testsPassing = true;
      break;
    }

    log.warn(`[ti-loop] Tests failed on attempt ${attempt + 1} (exit ${testRun.exitCode})`);
    failureOutputs.push(testRun.output);
  }

  // Step 3: Diagnosis if all attempts exhausted (or broke early for re-spec)
  let diagnosis: TILoopDiagnosis | undefined;
  let thrashingSignal: ThrashingSignal | undefined;
  let shouldRespec = false;
  if (!testsPassing) {
    thrashingSignal = detectThrashing(modifiedFilesPerAttempt);
    diagnosis = classifyDiagnosis(failureOutputs, thrashingSignal);
    shouldRespec = diagnosis === 'SPEC_WRONG';
    log.error(
      `[ti-loop] All ${failureOutputs.length} attempts exhausted — diagnosis: ${diagnosis}, thrashing: ${thrashingSignal}${shouldRespec ? ', will re-spec' : ''}`,
    );
  }

  const attempts = failureOutputs.length + (testsPassing ? 1 : 0);

  return {
    testWaveResult,
    implWaveResult: implWaveResult as WaveResult,
    testsPassing,
    totalCost,
    attempts,
    modifiedFilesPerAttempt,
    ...(diagnosis != null && { diagnosis }),
    ...(shouldRespec && { shouldRespec }),
    ...(thrashingSignal != null && { thrashingSignal }),
  };
}

// --- Per-piece TI Loop ---

export async function runPieceTILoop(config: PieceTILoopConfig): Promise<PieceTILoopResult> {
  const {
    piece,
    pieceIndex,
    workDir,
    repoConfig,
    projectContext,
    testRunner = defaultTestRunner,
    diffRunner = defaultDiffRunner,
    fileReader = defaultFileReader,
    sandbox,
    cacheContext,
    skipTestPhase = false,
    skipImplPhase = false,
    extraImplAttempts,
  } = config;

  // Issue #282 explore-mode plumbing: explicit `maxRetries` always wins so
  // existing callers stay deterministic. When `maxRetries` is omitted and
  // `extraImplAttempts > 0`, raise the default 3-attempt budget by that
  // amount — every other case keeps the default 3.
  const maxRetries =
    config.maxRetries ?? (extraImplAttempts != null && extraImplAttempts > 0 ? 3 + extraImplAttempts : 3);

  if (maxRetries < 1) {
    throw new Error('maxRetries must be at least 1');
  }

  // Issue #297: piece-scoped sessionIds — same `<repo>-<issue>` slug, per-wave
  // suffix. All pieces of one issue share the cache namespace per wave.
  const testSessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: 'test' }) : undefined;
  const implSessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: 'impl' }) : undefined;

  const testCmd = await resolveTestCommand(workDir, config.testCommand);
  log.info(`[piece-ti-loop] Piece ${pieceIndex} (${piece.name}): test command: ${testCmd}`);

  let cost = 0;
  const resolvedPromptsDir = resolvePromptsDir(repoConfig.path, repoConfig.prompts_dir);

  // Step 1: Test agent — scoped to this piece only.
  // Issue #283: when the pipeline scope says the test wave should be skipped
  // (IMPL_ONLY / REFACTOR), use a synthetic skip-result and skip dispatching
  // the test agent entirely. Impl still gates on `testRunner` below so
  // existing red tests guide the retry loop.
  let testWaveResult: WaveResult;
  if (skipTestPhase) {
    log.info(`[piece-ti-loop] Piece ${pieceIndex}: test wave skipped by pipeline scope`);
    testWaveResult = {
      wave: 'test',
      success: true,
      artifact: { skipped: true, reason: 'pipeline-scope' },
      duration: 0,
      cost: 0,
      turns: 0,
    };
  } else {
    log.info(`[piece-ti-loop] Piece ${pieceIndex}: running test wave`);
    const testSystemPrompt = await loadPrompt('test', repoConfig.tools, projectContext, resolvedPromptsDir);
    const testExecResult = await dispatchExecuteWave(
      {
        wave: 'test',
        systemPrompt: testSystemPrompt,
        userMessage: buildPieceContext('test', piece),
        cwd: workDir,
        modelTier: repoConfig.model.test,
        thinkingLevel: resolveThinkingLevel(repoConfig, 'test'),
        customTools: repoConfig.tools,
        ...(testSessionId != null && { sessionId: testSessionId }),
      },
      sandbox,
    );

    testWaveResult = toWaveResult('test', testExecResult);
    cost += testExecResult.cost;
  }

  // Issue #283: TEST_ONLY scope — skip the impl retry loop entirely. Return
  // a synthetic impl wave result and `testsPassing: true` (tests written;
  // not yet expected to pass).
  if (skipImplPhase) {
    log.info(`[piece-ti-loop] Piece ${pieceIndex}: impl wave skipped by pipeline scope`);
    const implSkip: WaveResult = {
      wave: 'impl',
      success: true,
      artifact: { skipped: true, reason: 'pipeline-scope' },
      duration: 0,
      cost: 0,
      turns: 0,
    };
    return {
      pieceIndex,
      testWaveResult,
      implWaveResult: implSkip,
      testsPassing: true,
      cost,
      attempts: 0,
    };
  }

  // Step 2: Impl retry loop — piece-scoped context.
  // Issue #284: mirrors runTILoop's full-fidelity diagnosis switch via the
  // shared applyMidLoopDiagnosis helper. Previously only APPROACH_WRONG was
  // handled; multi-piece issues now also benefit from MISSING_CONTEXT file
  // injection, STUCK partial-fix hints, and SPEC_WRONG early break.
  const failureOutputs: string[] = [];
  const modifiedFilesPerAttempt: string[][] = [];
  let implWaveResult: WaveResult | undefined;
  let testsPassing = false;
  let shouldBreakForRespec = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    log.info(`[piece-ti-loop] Piece ${pieceIndex}: impl attempt ${attempt + 1}/${maxRetries}`);

    let escalationHint: string | undefined;
    let missingContextHint: string | undefined;

    // Early diagnosis after first failure via static analysis (saves 1 retry cycle)
    if (failureOutputs.length === 1) {
      const earlyDiagnosis = classifyFirstFailure(failureOutputs[0] as string, piece.files);
      if (earlyDiagnosis != null) {
        escalationHint = `Early diagnosis: ${earlyDiagnosis} — detected from first failure output.\n\n### Attempt 1\n\`\`\`\n${failureOutputs[0]}\n\`\`\``;
      }
    }

    // Diagnosis-driven strategy after 2+ failures — shared helper with runTILoop (issue #284)
    if (failureOutputs.length >= 2) {
      const midResult = await applyMidLoopDiagnosis({
        failureOutputs,
        modifiedFilesPerAttempt,
        specFiles: piece.files,
        workDir,
        fileReader,
      });
      escalationHint = midResult.escalationHint ?? escalationHint;
      missingContextHint = midResult.missingContextHint;
      shouldBreakForRespec = midResult.shouldBreakForRespec;
    }

    // SPEC_WRONG: break early — caller will re-run spec
    if (shouldBreakForRespec) {
      log.info(`[piece-ti-loop] Piece ${pieceIndex}: SPEC_WRONG detected mid-loop — breaking early for re-spec`);
      break;
    }

    let implContext = buildPieceContext('impl', piece, {
      ...(escalationHint != null && { escalationHint }),
      ...(failureOutputs.length > 0 && { lastFailureOutput: failureOutputs.at(-1) }),
    });
    if (missingContextHint != null) {
      implContext += `\n\n${missingContextHint}`;
    }

    const implSystemPrompt = await loadPrompt('impl', repoConfig.tools, projectContext, resolvedPromptsDir);
    const implExecResult = await dispatchExecuteWave(
      {
        wave: 'impl',
        systemPrompt: implSystemPrompt,
        userMessage: implContext,
        cwd: workDir,
        modelTier: repoConfig.model.impl,
        thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
        customTools: repoConfig.tools,
        // Issue #250: scope impl-wave Write/Edit calls to this piece's file list.
        // Models occasionally edited unrelated files (e.g. gemma4 modifying
        // surreal-bench while working on domain-networking); this guard rejects
        // out-of-scope edits with a clear error message before they execute.
        pieceFiles: piece.files,
        ...(implSessionId != null && { sessionId: implSessionId }),
      },
      sandbox,
    );

    implWaveResult = toWaveResult('impl', implExecResult);
    cost += implExecResult.cost;

    // Capture modified files after impl, before test run (issue #284 — feeds thrashing detection)
    const modifiedFiles = await diffRunner(workDir);
    modifiedFilesPerAttempt.push(modifiedFiles);

    // Run tests via bash
    log.info(`[piece-ti-loop] Piece ${pieceIndex}: running tests`);
    const testRun = await testRunner(testCmd, workDir);

    if (testRun.passed) {
      log.info(`[piece-ti-loop] Piece ${pieceIndex}: tests passing on attempt ${attempt + 1}`);
      testsPassing = true;
      break;
    }

    log.warn(`[piece-ti-loop] Piece ${pieceIndex}: tests failed on attempt ${attempt + 1}`);
    failureOutputs.push(testRun.output);
  }

  // Final diagnosis if all retries exhausted (or broke early for re-spec).
  // When broken early, the helper already returned SPEC_WRONG; surface it.
  let diagnosis: TILoopDiagnosis | undefined;
  let shouldRespec = false;
  if (!testsPassing && shouldBreakForRespec) {
    diagnosis = 'SPEC_WRONG';
    shouldRespec = true;
    log.error(`[piece-ti-loop] Piece ${pieceIndex}: SPEC_WRONG — will re-spec`);
  } else if (!testsPassing && failureOutputs.length >= 2) {
    const finalThrashing = detectThrashing(modifiedFilesPerAttempt);
    diagnosis = classifyDiagnosis(failureOutputs, finalThrashing);
    shouldRespec = diagnosis === 'SPEC_WRONG';
    log.error(
      `[piece-ti-loop] Piece ${pieceIndex}: all retries exhausted — diagnosis: ${diagnosis}, thrashing: ${finalThrashing}${shouldRespec ? ', will re-spec' : ''}`,
    );
  } else if (!testsPassing) {
    diagnosis = 'STUCK';
  }

  const attempts = failureOutputs.length + (testsPassing ? 1 : 0);

  return {
    pieceIndex,
    testWaveResult,
    implWaveResult: implWaveResult as WaveResult,
    testsPassing,
    cost,
    attempts,
    ...(diagnosis != null && { diagnosis }),
    ...(shouldRespec && { shouldRespec }),
  };
}

// --- Parallel piece TI loop orchestrator ---

function isSpecResult(v: unknown): v is SpecResult {
  return v != null && typeof v === 'object' && 'pieces' in v && Array.isArray((v as SpecResult).pieces);
}

export async function runParallelPieceTILoop(config: ParallelPieceTILoopConfig): Promise<ParallelPieceTILoopResult> {
  const {
    issue,
    workDir,
    repoConfig,
    waveResults,
    maxConcurrent = 3,
    testRunner = defaultTestRunner,
    prContext,
    codebaseContext,
    codegraphContext,
    callPathContext,
    projectContext,
    sandbox,
    cacheContext,
    skipTestPhase = false,
    skipImplPhase = false,
    extraImplAttempts,
  } = config;

  // Extract spec pieces
  const specArtifact = waveResults.spec?.artifact;
  if (!isSpecResult(specArtifact) || specArtifact.pieces.length === 0) {
    throw new Error('Cannot run parallel piece TI loop without spec pieces');
  }

  const { pieces, dependency_order } = specArtifact;

  // 1 piece — backward compatible, delegate to existing runTILoop
  if (pieces.length === 1) {
    log.info('[parallel-ti] Single piece — delegating to runTILoop (no sub-worktrees)');
    const tiResult = await runTILoop({
      issue,
      workDir,
      repoConfig,
      waveResults,
      testRunner,
      projectContext,
      ...(prContext != null && { prContext }),
      ...(codebaseContext != null && { codebaseContext }),
      ...(codegraphContext != null && { codegraphContext }),
      ...(callPathContext != null && { callPathContext }),
      ...(config.diffRunner != null && { diffRunner: config.diffRunner }),
      ...(config.testCommand != null && { testCommand: config.testCommand }),
      ...(sandbox != null && { sandbox }),
      ...(cacheContext != null && { cacheContext }),
      ...(skipTestPhase && { skipTestPhase: true }),
      ...(skipImplPhase && { skipImplPhase: true }),
      ...(extraImplAttempts != null && { extraImplAttempts }),
    });

    return {
      testWaveResult: tiResult.testWaveResult,
      implWaveResult: tiResult.implWaveResult,
      testsPassing: tiResult.testsPassing,
      totalCost: tiResult.totalCost,
      attempts: tiResult.attempts,
      pieceResults: [
        {
          pieceIndex: 0,
          testWaveResult: tiResult.testWaveResult,
          implWaveResult: tiResult.implWaveResult,
          testsPassing: tiResult.testsPassing,
          cost: tiResult.totalCost,
          attempts: tiResult.attempts,
          ...(tiResult.diagnosis != null && { diagnosis: tiResult.diagnosis }),
        },
      ],
      ...(tiResult.diagnosis != null && { diagnosis: tiResult.diagnosis }),
      ...(tiResult.shouldRespec && { shouldRespec: true }),
      modifiedFilesPerAttempt: tiResult.modifiedFilesPerAttempt,
    };
  }

  // Multiple pieces — fan out via batch scheduler
  log.info(`[parallel-ti] ${pieces.length} pieces, max ${maxConcurrent} concurrent`);

  const pieceResults: PieceTILoopResult[] = [];

  await executePiecesInBatches({
    pieces,
    dependencyOrder: dependency_order,
    maxConcurrent,
    executePiece: async (piece, pieceIndex) => {
      // Use workDir directly with piece index in path for isolation
      const pieceWorkDir = `${workDir}/piece-${pieceIndex}`;

      const result = await runPieceTILoop({
        piece,
        pieceIndex,
        workDir: pieceWorkDir,
        repoConfig,
        projectContext,
        testRunner,
        // Issue #284: forward diffRunner so thrashing detection has signal and
        // SPEC_WRONG diagnoses surface here too (not just in the single-piece path).
        ...(config.diffRunner != null && { diffRunner: config.diffRunner }),
        ...(config.testCommand != null && { testCommand: config.testCommand }),
        ...(sandbox != null && { sandbox }),
        ...(cacheContext != null && { cacheContext }),
        ...(skipTestPhase && { skipTestPhase: true }),
        ...(skipImplPhase && { skipImplPhase: true }),
        ...(extraImplAttempts != null && { extraImplAttempts }),
      });

      pieceResults.push(result);

      return {
        pieceIndex,
        success: result.testsPassing,
        ...(result.diagnosis != null && { error: result.diagnosis }),
      };
    },
  });

  // Sort piece results by pieceIndex for deterministic output
  pieceResults.sort((a, b) => a.pieceIndex - b.pieceIndex);

  const totalCost = pieceResults.reduce((sum, r) => sum + r.cost, 0);
  const allPassing = pieceResults.every((r) => r.testsPassing);
  const maxAttempts = Math.max(...pieceResults.map((r) => r.attempts), 0);
  const firstFailure = pieceResults.find((r) => !r.testsPassing);

  // Aggregate wave results
  const aggregatedTestResult: WaveResult = {
    wave: 'test',
    success: true,
    artifact: { pieces: pieceResults.map((r) => ({ pieceIndex: r.pieceIndex, artifact: r.testWaveResult.artifact })) },
    duration: pieceResults.reduce((sum, r) => sum + r.testWaveResult.duration, 0),
    cost: pieceResults.reduce((sum, r) => sum + r.testWaveResult.cost, 0),
    turns: pieceResults.reduce((sum, r) => sum + r.testWaveResult.turns, 0),
  };

  const aggregatedImplResult: WaveResult = {
    wave: 'impl',
    success: allPassing,
    artifact: { pieces: pieceResults.map((r) => ({ pieceIndex: r.pieceIndex, artifact: r.implWaveResult.artifact })) },
    duration: pieceResults.reduce((sum, r) => sum + r.implWaveResult.duration, 0),
    cost: pieceResults.reduce((sum, r) => sum + r.implWaveResult.cost, 0),
    turns: pieceResults.reduce((sum, r) => sum + r.implWaveResult.turns, 0),
  };

  // Issue #284: if any piece returned SPEC_WRONG, surface shouldRespec so the
  // orchestrator (fix.ts) can re-run spec instead of burning further retries —
  // matches the single-piece passthrough that already lives a few lines above.
  const anyRespecNeeded = pieceResults.some((r) => r.shouldRespec === true);
  // Prefer the SPEC_WRONG piece's diagnosis when present, otherwise fall back
  // to the first failure's diagnosis (preserves existing behavior).
  const respecPiece = pieceResults.find((r) => r.shouldRespec === true);
  const surfacedDiagnosis = respecPiece?.diagnosis ?? firstFailure?.diagnosis;

  return {
    testWaveResult: aggregatedTestResult,
    implWaveResult: aggregatedImplResult,
    testsPassing: allPassing,
    totalCost,
    attempts: maxAttempts,
    pieceResults,
    ...(surfacedDiagnosis != null && { diagnosis: surfacedDiagnosis }),
    ...(anyRespecNeeded && { shouldRespec: true }),
    modifiedFilesPerAttempt: [],
  };
}

// --- Default file writer ---

const defaultFileWriter: FileWriter = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
};

// --- Review test file writing ---

interface WriteReviewTestsResult {
  /** Test files that were written to disk (one per finding that had `test_code`). */
  filesWritten: string[];
  /** Findings that lacked `test_code` and could not be written — surfaced as known issues. */
  skipped: ReviewFinding[];
}

async function writeReviewTests(
  findings: ReviewFinding[],
  workDir: string,
  writer: FileWriter,
): Promise<WriteReviewTestsResult> {
  const filesWritten: string[] = [];
  const skipped: ReviewFinding[] = [];

  for (const finding of findings) {
    if (!finding.test_code) {
      // Guard, not silent skip: the reviewer prompt REQUIRES test_code for
      // needs_new_tests findings (see prompts/review.md). When it is missing,
      // we cannot ratchet-then-impl, so we surface the finding so the
      // orchestrator can flag it instead of dropping it on the floor.
      log.warn(
        `[review-loop] needs_new_tests finding for ${finding.file} is missing test_code — surfacing as known issue (reviewer must emit runnable failing test code)`,
      );
      skipped.push(finding);
      continue;
    }

    const ext = path.extname(finding.file);
    const base = finding.file.replace(ext, '');
    const testFile = `${base}.review.test${ext}`;
    const fullPath = path.join(workDir, testFile);

    await writer(fullPath, finding.test_code);
    filesWritten.push(testFile);
  }

  return { filesWritten, skipped };
}

// Stable key for deduping skipped findings across loop iterations.
function findingKey(f: ReviewFinding): string {
  return `${f.category}::${f.file}::${f.line ?? ''}::${f.description}`;
}

// --- Review output format ---

function reviewOutputFormat(): OutputFormat {
  return {
    type: 'json_schema',
    schema: z.toJSONSchema(ReviewResultSchema, { target: 'draft-07' }) as Record<string, unknown>,
    zodSchema: ReviewResultSchema,
  };
}

/**
 * Apply the optional review-classifier opt-in (issue #320, pattern 3).
 *
 * When `repos.yaml` sets `review.classify_inline: true`, partition the loop's
 * `knownIssues` into "real" and "probe". Only real findings flow downstream
 * to the PR body. Probes get a single log line so they show up in telemetry
 * but never produce user-facing comments. Default (flag false) is a no-op.
 */
function applyClassifyInlineGate(knownIssues: ReviewFinding[], repoConfig: RepoConfig): ReviewFinding[] {
  if (repoConfig.review?.classify_inline !== true) {
    return knownIssues;
  }
  const { real, probe } = classifyReviewFindings(knownIssues);
  if (probe.length > 0) {
    log.info(
      `[review-classifier] classify_inline=true: kept ${real.length} real finding(s), filtered ${probe.length} probe(s)`,
    );
  }
  return real;
}

// --- Review Loop Controller ---

export async function runReviewLoop(config: ReviewLoopConfig): Promise<ReviewLoopResult> {
  const {
    issue,
    workDir,
    repoConfig,
    waveResults,
    maxIterations = 2,
    prContext,
    projectContext,
    reviewFeedbackContext,
    regressionSurfaceContext,
    testRunner = defaultTestRunner,
    fileWriter = defaultFileWriter,
    sandbox,
    prescanRunner,
    baselineFailures,
    currentFailures,
    cacheContext,
  } = config;
  // Issue #297: per-wave sessionIds for the review/impl retries. The review
  // loop does not dispatch its own 'test' wave (tests are run via bash, not
  // an agent), so no test sessionId is built here.
  const reviewSessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: 'review' }) : undefined;
  const implSessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: 'impl' }) : undefined;

  if (maxIterations < 1) {
    throw new Error('maxIterations must be at least 1');
  }

  const testCmd = await resolveTestCommand(workDir, config.testCommand);
  const resolvedPromptsDir = resolvePromptsDir(repoConfig.path, repoConfig.prompts_dir);
  let totalCost = 0;
  let reviewWaveResult: WaveResult | undefined;
  let qualityWaveResult: WaveResult | undefined;
  let lastReview: ReviewResult | undefined;
  // Accumulates needs_new_tests findings that the reviewer returned without
  // `test_code` across all iterations. These cannot be ratcheted/impl'd, so
  // they surface in the final knownIssues — never silently dropped.
  const skippedSurfacedFindings = new Map<string, ReviewFinding>();

  // Deterministic pre-scan + baseline gate — runs ONCE before the loop.
  // Both are orchestrator-side fail-closed signals: any hit forces verdict
  // to needs_fixes regardless of what the model returns.
  const prescanFn: PrescanRunner = prescanRunner ?? scanDiffForBlockingFindings;
  const prescan = await prescanFn(workDir);
  if (prescan.blocking) {
    log.warn(
      `[review-loop] Static pre-scan found ${prescan.findings.length} blocking finding(s) — verdict will be overridden to needs_fixes`,
    );
  }

  const haveBaselineSignal = baselineFailures != null && currentFailures != null;
  const baseline = haveBaselineSignal
    ? compareBaselineFailures(baselineFailures, currentFailures)
    : { newRegressions: [], preexisting: [], blocking: false, summary: '' };
  if (baseline.blocking) {
    log.warn(
      `[review-loop] Baseline gate detected ${baseline.newRegressions.length} new regression(s) — verdict will be overridden to needs_fixes`,
    );
  }

  // Build the static "data" block passed to the reviewer once per iteration.
  // The reviewer must treat these as confirmed findings, not re-derive them.
  const buildPrescanContext = (): string | undefined => {
    const lines: string[] = [];
    if (prescan.findings.length > 0 || prescan.blocking) {
      lines.push('## Deterministic Pre-Scan (orchestrator-confirmed)');
      lines.push('');
      lines.push(prescan.summary);
    }
    if (haveBaselineSignal) {
      if (lines.length > 0) lines.push('');
      lines.push('## Baseline Regression Gate (orchestrator-confirmed)');
      lines.push('');
      lines.push(baseline.summary);
    }
    return lines.length > 0 ? lines.join('\n') : undefined;
  };

  // Synthesize ReviewFindings from blocking signals so they surface in
  // knownIssues even if the model returns pass.
  const blockingFindings: ReviewFinding[] = [];
  for (const f of prescan.findings) {
    blockingFindings.push({
      category: 'mechanical_fix',
      file: f.file,
      ...(f.line != null && { line: f.line }),
      description: `[pre-scan] ${f.type} detected in added diff line: ${f.snippet}`,
      severity: 'critical',
    });
  }
  if (baseline.blocking) {
    blockingFindings.push({
      category: 'mechanical_fix',
      file: 'TEST_SUITE',
      description: `[baseline] regression: ${baseline.newRegressions.length} newly failing test(s): ${baseline.newRegressions.join(', ')}`,
      severity: 'critical',
    });
  }
  const forceFailFromOrchestrator = prescan.blocking || baseline.blocking;

  // Pick the reviewer persona ONCE per loop entry — labels + assess
  // modules_affected drive the choice, generalist is the fallback. The
  // persona prompt is read-only (same tools as the existing generic review.md).
  const assessArtifact = waveResults.assess?.artifact;
  const modulesAffected =
    assessArtifact != null &&
    typeof assessArtifact === 'object' &&
    'surface_area' in assessArtifact &&
    assessArtifact.surface_area != null &&
    typeof assessArtifact.surface_area === 'object' &&
    'modules_affected' in assessArtifact.surface_area &&
    Array.isArray((assessArtifact.surface_area as { modules_affected?: unknown }).modules_affected)
      ? ((assessArtifact.surface_area as { modules_affected: unknown[] }).modules_affected.filter(
          (m): m is string => typeof m === 'string',
        ) as string[])
      : [];
  const persona = selectReviewerPersona({
    labels: issue.labels ?? [],
    modulesAffected,
  });
  log.info(`[review-loop] Persona: ${persona}`);

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    log.info(`[review-loop] Iteration ${iteration + 1}/${maxIterations}`);

    // Step 1: Fresh review agent — no prior review bias.
    // Pre-scan + baseline are injected as DATA (not re-derived by the model).
    const reviewSystemPrompt = await loadReviewPersonaPrompt(
      persona,
      // Review wave is read-only — never receives customTools (loadPrompt
      // only appends them to impl/quality anyway).
      undefined,
      projectContext,
      resolvedPromptsDir,
    );
    const prescanContext = buildPrescanContext();
    const baseUserMessage = buildWaveContext('review', issue, waveResults, {
      ...(reviewFeedbackContext != null && { reviewFeedbackContext }),
      ...(regressionSurfaceContext != null && { regressionSurfaceContext }),
    });
    const reviewUserMessage = prescanContext != null ? `${prescanContext}\n\n${baseUserMessage}` : baseUserMessage;
    const reviewExecResult = await dispatchExecuteWave(
      {
        wave: 'review',
        systemPrompt: reviewSystemPrompt,
        userMessage: reviewUserMessage,
        cwd: workDir,
        modelTier: repoConfig.model.review,
        outputFormat: reviewOutputFormat(),
        thinkingLevel: resolveThinkingLevel(repoConfig, 'review'),
        customTools: repoConfig.tools,
        playwright: config.playwright,
        ...(reviewSessionId != null && { sessionId: reviewSessionId }),
      },
      sandbox,
    );

    reviewWaveResult = toWaveResult('review', reviewExecResult);
    totalCost += reviewExecResult.cost;
    waveResults.review = reviewWaveResult;

    lastReview = reviewExecResult.structuredOutput as ReviewResult | undefined;

    // Orchestrator-side override: if pre-scan or baseline-gate flagged
    // anything, force verdict to needs_fixes and merge synthetic findings.
    if (forceFailFromOrchestrator && lastReview) {
      const merged: ReviewResult = {
        verdict: 'needs_fixes',
        findings: [...lastReview.findings, ...blockingFindings],
        summary: `${lastReview.summary} | Orchestrator override: pre-scan/baseline blocking signals present.`,
      };
      lastReview = merged;
    } else if (forceFailFromOrchestrator && !lastReview) {
      // Model returned no structured output — still force a needs_fixes verdict.
      lastReview = {
        verdict: 'needs_fixes',
        findings: blockingFindings,
        summary: 'Orchestrator override: pre-scan/baseline blocking signals present.',
      };
    }

    // If review passes, we're done — but still surface any skipped findings
    // (missing test_code) collected across iterations. A `pass` verdict from
    // the reviewer does not retroactively mean the unguardable findings were
    // resolved; the orchestrator must see them.
    if (!lastReview || lastReview.verdict === 'pass') {
      log.info('[review-loop] Review passed');
      const rawKnownIssues = Array.from(skippedSurfacedFindings.values());
      if (rawKnownIssues.length > 0) {
        log.warn(
          `[review-loop] ${rawKnownIssues.length} needs_new_tests finding(s) surfaced as known issues (missing test_code from reviewer)`,
        );
      }
      const knownIssues = applyClassifyInlineGate(rawKnownIssues, repoConfig);
      return {
        reviewWaveResult,
        qualityWaveResult,
        totalCost,
        iterations: iteration + 1,
        knownIssues,
      };
    }

    log.info(`[review-loop] Review found ${lastReview.findings.length} finding(s) — applying fixes`);

    // Step 2: Categorize findings.
    // Orchestrator-synthesized findings (pre-scan / baseline) are surfaced as
    // critical knownIssues but NOT dispatched to impl — the agent cannot "fix"
    // a hardcoded key by editing diff lines it wasn't asked about, and asking
    // it to fix regressions implies a re-impl loop we explicitly want to defer
    // to the next /fix run. Filter them out of the impl-dispatch buckets.
    const orchestratorSynthesized = new Set(blockingFindings.map((f) => findingKey(f)));
    const reviewerFindings = lastReview.findings.filter((f) => !orchestratorSynthesized.has(findingKey(f)));
    const needsNewTests = reviewerFindings.filter((f) => f.category === 'needs_new_tests');
    const mechanicalFixes = reviewerFindings.filter((f) => f.category === 'mechanical_fix');

    // Synthesized findings still go into knownIssues — surface them once now
    // so they survive even if a later iteration's review returns pass.
    for (const f of blockingFindings) {
      skippedSurfacedFindings.set(findingKey(f), f);
    }

    // Track whether quality re-run is needed:
    // - NEEDS_NEW_TESTS present → always re-run (new code written)
    // - Only MECHANICAL_FIX + tests pass → skip quality
    // - MECHANICAL_FIX + tests fail → re-run quality
    let needQualityRerun = needsNewTests.length > 0;

    // Step 3: Path 1 — NEEDS_NEW_TESTS (ratcheting eval)
    if (needsNewTests.length > 0) {
      const { filesWritten: testFilesWritten, skipped: skippedThisIter } = await writeReviewTests(
        needsNewTests,
        workDir,
        fileWriter,
      );

      // Surface every skipped finding (missing test_code) so the orchestrator
      // sees them in knownIssues even if a later iteration's review returns
      // `pass` and the lastReview-based capture misses them.
      for (const skipped of skippedThisIter) {
        skippedSurfacedFindings.set(findingKey(skipped), skipped);
      }

      if (testFilesWritten.length > 0) {
        // Ratchet: verify new tests fail (proving they catch the gap)
        const ratchetRun = await testRunner(testCmd, workDir);
        if (ratchetRun.passed) {
          log.warn('[review-loop] Ratchet: new tests already pass — skipping impl for needs_new_tests');
        } else {
          log.info('[review-loop] Ratchet confirmed — new tests fail, spawning impl agent');
          const implContext = buildNeedsNewTestsImplContext(needsNewTests, testFilesWritten, waveResults, prContext);
          const implSystemPrompt = await loadPrompt('impl', repoConfig.tools, projectContext, resolvedPromptsDir);
          const implExecResult = await dispatchExecuteWave(
            {
              wave: 'impl',
              systemPrompt: implSystemPrompt,
              userMessage: implContext,
              cwd: workDir,
              modelTier: repoConfig.model.impl,
              thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
              customTools: repoConfig.tools,
              ...(implSessionId != null && { sessionId: implSessionId }),
            },
            sandbox,
          );
          totalCost += implExecResult.cost;
          waveResults.impl = toWaveResult('impl', implExecResult);

          // Verify ALL tests pass (old + new)
          const verifyRun = await testRunner(testCmd, workDir);
          if (!verifyRun.passed) {
            log.warn('[review-loop] Tests still failing after NEEDS_NEW_TESTS impl');
          }
        }
      }
    }

    // Step 4: Path 2 — MECHANICAL_FIX (refactoring)
    if (mechanicalFixes.length > 0) {
      log.info(`[review-loop] Applying ${mechanicalFixes.length} mechanical fix(es)`);
      const implContext = buildMechanicalFixImplContext(mechanicalFixes, waveResults, prContext);
      const implSystemPrompt = await loadPrompt('impl', repoConfig.tools, projectContext, resolvedPromptsDir);
      const implExecResult = await dispatchExecuteWave(
        {
          wave: 'impl',
          systemPrompt: implSystemPrompt,
          userMessage: implContext,
          cwd: workDir,
          modelTier: repoConfig.model.impl,
          thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
          customTools: repoConfig.tools,
          ...(implSessionId != null && { sessionId: implSessionId }),
        },
        sandbox,
      );
      totalCost += implExecResult.cost;
      waveResults.impl = toWaveResult('impl', implExecResult);

      // Verify tests still pass (safety net)
      const verifyRun = await testRunner(testCmd, workDir);
      if (!verifyRun.passed) {
        log.warn('[review-loop] Tests broke during MECHANICAL_FIX impl');
        needQualityRerun = true;
      }
    }

    // Step 5: Re-run quality gates (only if new code was written or mechanical fixes broke tests)
    if (needQualityRerun) {
      const qualitySystemPrompt = await loadPrompt('quality', repoConfig.tools, projectContext, resolvedPromptsDir);
      const qualityExecResult = await dispatchExecuteWave(
        {
          wave: 'quality',
          systemPrompt: qualitySystemPrompt,
          userMessage: buildWaveContext('quality', issue, waveResults, {
            coverageThreshold: repoConfig.rules.coverage,
          }),
          cwd: workDir,
          modelTier: repoConfig.model.quality,
          thinkingLevel: resolveThinkingLevel(repoConfig, 'quality'),
          customTools: repoConfig.tools,
        },
        sandbox,
      );
      qualityWaveResult = toWaveResult('quality', qualityExecResult);
      totalCost += qualityExecResult.cost;
      waveResults.quality = qualityWaveResult;
    } else {
      log.info('[review-loop] Skipping quality re-run — only mechanical fixes with passing tests');
    }
  }

  // Max iterations reached — collect remaining findings as known issues.
  // Merge lastReview.findings with skipped-because-missing-test_code findings
  // so the orchestrator sees both categories. Dedup by file+description so
  // a finding that the reviewer returned in both forms (with and without
  // test_code across iterations) only counts once.
  const finalKnown = new Map<string, ReviewFinding>();
  for (const f of lastReview?.findings ?? []) {
    finalKnown.set(findingKey(f), f);
  }
  for (const [k, f] of skippedSurfacedFindings) {
    if (!finalKnown.has(k)) {
      finalKnown.set(k, f);
    }
  }
  const rawKnownIssues = Array.from(finalKnown.values());
  log.warn(`[review-loop] Max iterations (${maxIterations}) reached — ${rawKnownIssues.length} known issue(s) remain`);
  const knownIssues = applyClassifyInlineGate(rawKnownIssues, repoConfig);

  return {
    reviewWaveResult: reviewWaveResult as WaveResult,
    qualityWaveResult,
    totalCost,
    iterations: maxIterations,
    knownIssues,
  };
}

// --- Review loop context builders ---

function buildNeedsNewTestsImplContext(
  findings: ReviewFinding[],
  testFiles: string[],
  waveResults: Partial<Record<WaveName, WaveResult>>,
  prContext?: string,
): string {
  const sections: string[] = [];

  sections.push('## Review Findings — NEEDS_NEW_TESTS\n');
  sections.push('Fix the code so that the following new tests pass:\n');
  for (const f of findings) {
    const loc = f.line != null ? `${f.file} line ${f.line}` : f.file;
    sections.push(`- [${f.severity}] ${loc}: ${f.description}`);
  }

  if (testFiles.length > 0) {
    sections.push(`\n## New Test Files Written\n`);
    for (const tf of testFiles) {
      sections.push(`- ${tf}`);
    }
  }

  // Include spec context if available
  const spec = waveResults.spec?.artifact;
  if (spec != null && typeof spec === 'object' && 'summary' in spec) {
    sections.push(`\n## Spec\n\n${(spec as { summary: string }).summary}`);
  }

  if (prContext) {
    sections.push(`\n${prContext}`);
  }

  return sections.join('\n');
}

function buildMechanicalFixImplContext(
  findings: ReviewFinding[],
  waveResults: Partial<Record<WaveName, WaveResult>>,
  prContext?: string,
): string {
  const sections: string[] = [];

  sections.push('## Review Findings — MECHANICAL_FIX\n');
  sections.push('Apply the following mechanical fixes. Existing tests are the safety net — do not break them.\n');
  for (const f of findings) {
    const loc = f.line != null ? `${f.file} line ${f.line}` : f.file;
    sections.push(`- [${f.severity}] ${loc}: ${f.description}`);
  }

  const spec = waveResults.spec?.artifact;
  if (spec != null && typeof spec === 'object' && 'summary' in spec) {
    sections.push(`\n## Spec\n\n${(spec as { summary: string }).summary}`);
  }

  if (prContext) {
    sections.push(`\n${prContext}`);
  }

  return sections.join('\n');
}

// --- Quality Retry Loop Types (Issue #217) ---

export interface QualityRetryConfig {
  issue: Issue;
  workDir: string;
  repoConfig: RepoConfig;
  waveResults: Partial<Record<WaveName, WaveResult>>;
  testRunner?: TestRunner;
  testCommand?: string;
  projectContext?: ProjectContext | undefined;
  /** Route every wave through the docker sandbox container when set. */
  sandbox?: SandboxContext | undefined;
  /**
   * Optional prompt-cache affinity context (issue #297). Threaded into the
   * impl-retry dispatch so the cache stays hot when WAVE Q has to bounce work
   * back to impl.
   */
  cacheContext?: { repo: string; issue: string | number } | undefined;
}

export interface QualityRetryResult {
  qualityWaveResult: WaveResult;
  retried: boolean;
  totalCost: number;
}

// --- Quality Retry Loop Controller ---

/**
 * After quality wave completes, check if test failures need a focused impl retry.
 * Max 1 retry cycle: impl → quality re-run.
 */
export async function runQualityRetryLoop(config: QualityRetryConfig): Promise<QualityRetryResult> {
  const {
    issue,
    workDir,
    repoConfig,
    waveResults,
    projectContext,
    testRunner = defaultTestRunner,
    sandbox,
    cacheContext,
  } = config;
  // Issue #297: per-wave sessionIds for impl/quality retry.
  const implSessionId = cacheContext != null ? buildWaveSessionId({ ...cacheContext, wave: 'impl' }) : undefined;

  const qualityWaveResult = waveResults.quality;
  if (!qualityWaveResult) {
    throw new Error('quality wave result required for quality retry loop');
  }

  const failureInfo = extractTestFailureInfo(qualityWaveResult.artifact);
  if (!failureInfo.shouldRetry) {
    log.info('[quality-retry] No retryable test failures — skipping');
    return { qualityWaveResult, retried: false, totalCost: 0 };
  }

  log.info(`[quality-retry] Test failures detected (${failureInfo.errors.length} error(s)) — triggering impl retry`);

  let totalCost = 0;
  const testCmd = await resolveTestCommand(workDir, config.testCommand);
  const resolvedPromptsDir = resolvePromptsDir(repoConfig.path, repoConfig.prompts_dir);

  // Step 1: Focused impl retry with quality failure context
  const escalationHint = buildQualityFailureEscalation(failureInfo);
  const implContext = buildWaveContext('impl', issue, waveResults, {
    escalationHint,
  });

  const implSystemPrompt = await loadPrompt('impl', repoConfig.tools, projectContext, resolvedPromptsDir);
  const implExecResult = await dispatchExecuteWave(
    {
      wave: 'impl',
      systemPrompt: implSystemPrompt,
      userMessage: implContext,
      cwd: workDir,
      modelTier: repoConfig.model.impl,
      thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
      customTools: repoConfig.tools,
      ...(implSessionId != null && { sessionId: implSessionId }),
    },
    sandbox,
  );
  totalCost += implExecResult.cost;
  waveResults.impl = toWaveResult('impl', implExecResult);

  // Verify tests pass after impl retry
  const verifyRun = await testRunner(testCmd, workDir);
  if (!verifyRun.passed) {
    log.warn('[quality-retry] Tests still failing after impl retry');
  }

  // Step 2: Re-run quality gates
  const qualitySystemPrompt = await loadPrompt('quality', repoConfig.tools, projectContext, resolvedPromptsDir);
  const qualityExecResult = await dispatchExecuteWave(
    {
      wave: 'quality',
      systemPrompt: qualitySystemPrompt,
      userMessage: buildWaveContext('quality', issue, waveResults, {
        coverageThreshold: repoConfig.rules.coverage,
      }),
      cwd: workDir,
      modelTier: repoConfig.model.quality,
      thinkingLevel: resolveThinkingLevel(repoConfig, 'quality'),
      customTools: repoConfig.tools,
    },
    sandbox,
  );
  totalCost += qualityExecResult.cost;

  const updatedQualityResult = toWaveResult('quality', qualityExecResult);
  waveResults.quality = updatedQualityResult;

  return {
    qualityWaveResult: updatedQualityResult,
    retried: true,
    totalCost,
  };
}

// --- Quality failure analysis helpers ---

interface TestFailureInfo {
  shouldRetry: boolean;
  errors: string[];
  suggestedAction: string;
}

function extractTestFailureInfo(artifact: unknown): TestFailureInfo {
  // New structured format (QualityRemediation)
  if (isQualityRemediation(artifact)) {
    const testsGate = artifact.gates.find((g) => g.gate === 'tests');
    if (testsGate && testsGate.status === 'failed' && testsGate.suggested_action === 'retry_impl') {
      return {
        shouldRetry: true,
        errors: testsGate.remaining_errors,
        suggestedAction: testsGate.suggested_action,
      };
    }
    return { shouldRetry: false, errors: [], suggestedAction: 'none' };
  }

  // Legacy format (QualityResult)
  if (isLegacyQualityResult(artifact)) {
    if (artifact.tests === 'fail' && artifact.lint === 'pass' && artifact.typecheck === 'pass') {
      return {
        shouldRetry: true,
        errors: ['Tests failed (legacy format — no detailed error info)'],
        suggestedAction: 'retry_impl',
      };
    }
    return { shouldRetry: false, errors: [], suggestedAction: 'none' };
  }

  return { shouldRetry: false, errors: [], suggestedAction: 'none' };
}

function isQualityRemediation(v: unknown): v is QualityRemediation {
  return v != null && typeof v === 'object' && 'gates' in v && Array.isArray((v as QualityRemediation).gates);
}

function isLegacyQualityResult(v: unknown): v is QualityResult {
  return v != null && typeof v === 'object' && 'all_passing' in v && 'lint' in v && 'tests' in v;
}

function buildQualityFailureEscalation(failureInfo: TestFailureInfo): string {
  const sections = [
    '## Quality Wave — Test Failures Detected',
    '',
    'The quality wave detected test failures after the initial implementation.',
    'Fix the failing tests without changing the test files themselves.',
    '',
    '### Failing Tests',
  ];

  for (const error of failureInfo.errors) {
    sections.push(`- ${error}`);
  }

  sections.push('', `Suggested action: ${failureInfo.suggestedAction}`);

  return sections.join('\n');
}
