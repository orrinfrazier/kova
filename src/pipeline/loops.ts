// T↔I loop controller — orchestrator-driven test/impl retry loop.
// R→I→T review loop controller — review/impl/test retry loop.
// Test agent runs once (writes tests). Impl agent spawns fresh per attempt.
// Tests run via bash (orchestrator), NOT via the agent.

import { exec as execCb } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { executeWaveWithRetry, type OutputFormat, resolveThinkingLevel } from '../ai/index.js';
import { detectTooling } from '../services/language-detect.js';
import type {
  Issue,
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
import { loadPrompt } from './prompts.js';

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

export interface TILoopConfig {
  issue: Issue;
  workDir: string;
  repoConfig: RepoConfig;
  waveResults: Partial<Record<WaveName, WaveResult>>;
  maxRetries?: number;
  testCommand?: string;
  prContext?: string;
  codebaseContext?: string;
  testRunner?: TestRunner;
  diffRunner?: DiffRunner;
}

export interface TILoopResult {
  testWaveResult: WaveResult;
  implWaveResult: WaveResult;
  testsPassing: boolean;
  totalCost: number;
  attempts: number;
  diagnosis?: TILoopDiagnosis;
  modifiedFilesPerAttempt: string[][];
  thrashingSignal?: ThrashingSignal;
}

export type FileWriter = (filePath: string, content: string) => Promise<void>;

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
  playwright?: { enabled: boolean } | undefined;
  reviewFeedbackContext?: string;
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
  testCommand?: string | undefined;
  testRunner?: TestRunner | undefined;
  diffRunner?: DiffRunner | undefined;
}

export interface PieceTILoopResult {
  pieceIndex: number;
  testWaveResult: WaveResult;
  implWaveResult: WaveResult;
  testsPassing: boolean;
  cost: number;
  attempts: number;
  diagnosis?: TILoopDiagnosis;
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
}

export interface ParallelPieceTILoopResult {
  testWaveResult: WaveResult;
  implWaveResult: WaveResult;
  testsPassing: boolean;
  totalCost: number;
  attempts: number;
  pieceResults: PieceTILoopResult[];
  diagnosis?: TILoopDiagnosis;
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

// --- Wave result conversion ---

function toWaveResult(
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
  };
}

// --- TI Loop Controller ---

export async function runTILoop(config: TILoopConfig): Promise<TILoopResult> {
  const {
    issue,
    workDir,
    repoConfig,
    waveResults,
    maxRetries = 3,
    prContext,
    codebaseContext,
    testRunner = defaultTestRunner,
    diffRunner = defaultDiffRunner,
  } = config;

  if (maxRetries < 1) {
    throw new Error('maxRetries must be at least 1');
  }

  const testCmd = await resolveTestCommand(workDir, config.testCommand);
  log.info(`[ti-loop] Test command: ${testCmd}`);

  let totalCost = 0;

  // Step 1: Spawn test agent — writes tests, verifies they fail
  log.info('[ti-loop] Running test wave (write failing tests)');
  const testSystemPrompt = await loadPrompt('test', repoConfig.tools);
  const testExecResult = await executeWaveWithRetry({
    wave: 'test',
    systemPrompt: testSystemPrompt,
    userMessage: buildWaveContext('test', issue, waveResults),
    cwd: workDir,
    modelTier: repoConfig.model.test,
    thinkingLevel: resolveThinkingLevel(repoConfig, 'test'),
    customTools: repoConfig.tools,
  });

  const testWaveResult = toWaveResult('test', testExecResult);
  totalCost += testExecResult.cost;

  // Prepare updated wave results with test for impl context building
  const updatedWaveResults = { ...waveResults, test: testWaveResult };

  // Step 2: Impl retry loop — orchestrator runs tests via bash
  const failureOutputs: string[] = [];
  const modifiedFilesPerAttempt: string[][] = [];
  let implWaveResult: WaveResult | undefined;
  let testsPassing = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    log.info(`[ti-loop] Impl attempt ${attempt + 1}/${maxRetries}`);

    // Classify diagnosis mid-loop to inject escalation hint for APPROACH_WRONG
    let escalationHint: string | undefined;
    if (failureOutputs.length >= 2) {
      const midDiagnosis = classifyDiagnosis(failureOutputs);
      if (midDiagnosis === 'APPROACH_WRONG') {
        const prevAttempts = failureOutputs
          .map((output, i) => `### Attempt ${i + 1}\n\`\`\`\n${output}\n\`\`\``)
          .join('\n\n');
        escalationHint = `Diagnosis: APPROACH_WRONG — each attempt fails different tests.\nThe previous approach failed. Try a fundamentally different strategy.\n\n${prevAttempts}`;
      }
    }

    // Build impl context — fresh each time with spec + test failures only
    let implContext = buildWaveContext('impl', issue, updatedWaveResults, {
      ...(prContext != null && { prContext }),
      ...(codebaseContext != null && { codebaseContext }),
      ...(escalationHint != null && { escalationHint }),
    });
    if (failureOutputs.length > 0) {
      const lastFailure = failureOutputs.at(-1) as string;
      implContext += `\n\n## Previous Test Failure Output\n\n\`\`\`\n${lastFailure}\n\`\`\``;
    }

    const implSystemPrompt = await loadPrompt('impl', repoConfig.tools);
    const implExecResult = await executeWaveWithRetry({
      wave: 'impl',
      systemPrompt: implSystemPrompt,
      userMessage: implContext,
      cwd: workDir,
      modelTier: repoConfig.model.impl,
      thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
      customTools: repoConfig.tools,
    });

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

  // Step 3: Diagnosis if all attempts exhausted
  let diagnosis: TILoopDiagnosis | undefined;
  let thrashingSignal: ThrashingSignal | undefined;
  if (!testsPassing) {
    thrashingSignal = detectThrashing(modifiedFilesPerAttempt);
    diagnosis = classifyDiagnosis(failureOutputs, thrashingSignal);
    log.error(
      `[ti-loop] All ${maxRetries} attempts exhausted — diagnosis: ${diagnosis}, thrashing: ${thrashingSignal}`,
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
    ...(thrashingSignal != null && { thrashingSignal }),
  };
}

// --- Per-piece TI Loop ---

export async function runPieceTILoop(config: PieceTILoopConfig): Promise<PieceTILoopResult> {
  const { piece, pieceIndex, workDir, repoConfig, maxRetries = 3, testRunner = defaultTestRunner } = config;

  if (maxRetries < 1) {
    throw new Error('maxRetries must be at least 1');
  }

  const testCmd = await resolveTestCommand(workDir, config.testCommand);
  log.info(`[piece-ti-loop] Piece ${pieceIndex} (${piece.name}): test command: ${testCmd}`);

  let cost = 0;

  // Step 1: Test agent — scoped to this piece only
  log.info(`[piece-ti-loop] Piece ${pieceIndex}: running test wave`);
  const testSystemPrompt = await loadPrompt('test', repoConfig.tools);
  const testExecResult = await executeWaveWithRetry({
    wave: 'test',
    systemPrompt: testSystemPrompt,
    userMessage: buildPieceContext('test', piece),
    cwd: workDir,
    modelTier: repoConfig.model.test,
    thinkingLevel: resolveThinkingLevel(repoConfig, 'test'),
    customTools: repoConfig.tools,
  });

  const testWaveResult = toWaveResult('test', testExecResult);
  cost += testExecResult.cost;

  // Step 2: Impl retry loop — piece-scoped context
  const failureOutputs: string[] = [];
  let implWaveResult: WaveResult | undefined;
  let testsPassing = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    log.info(`[piece-ti-loop] Piece ${pieceIndex}: impl attempt ${attempt + 1}/${maxRetries}`);

    let escalationHint: string | undefined;
    if (failureOutputs.length >= 2) {
      const midDiagnosis = classifyDiagnosis(failureOutputs);
      if (midDiagnosis === 'APPROACH_WRONG') {
        const prevAttempts = failureOutputs
          .map((output, i) => `### Attempt ${i + 1}\n\`\`\`\n${output}\n\`\`\``)
          .join('\n\n');
        escalationHint = `Diagnosis: APPROACH_WRONG — each attempt fails different tests.\nTry a fundamentally different strategy.\n\n${prevAttempts}`;
      }
    }

    const implContext = buildPieceContext('impl', piece, {
      ...(escalationHint != null && { escalationHint }),
      ...(failureOutputs.length > 0 && { lastFailureOutput: failureOutputs.at(-1) }),
    });

    const implSystemPrompt = await loadPrompt('impl', repoConfig.tools);
    const implExecResult = await executeWaveWithRetry({
      wave: 'impl',
      systemPrompt: implSystemPrompt,
      userMessage: implContext,
      cwd: workDir,
      modelTier: repoConfig.model.impl,
      thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
      customTools: repoConfig.tools,
    });

    implWaveResult = toWaveResult('impl', implExecResult);
    cost += implExecResult.cost;

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

  // Diagnosis if all retries exhausted
  let diagnosis: TILoopDiagnosis | undefined;
  if (!testsPassing && failureOutputs.length >= 2) {
    diagnosis = classifyDiagnosis(failureOutputs);
    log.error(`[piece-ti-loop] Piece ${pieceIndex}: all retries exhausted — diagnosis: ${diagnosis}`);
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
      ...(prContext != null && { prContext }),
      ...(codebaseContext != null && { codebaseContext }),
      ...(config.diffRunner != null && { diffRunner: config.diffRunner }),
      ...(config.testCommand != null && { testCommand: config.testCommand }),
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
        testRunner,
        ...(config.testCommand != null && { testCommand: config.testCommand }),
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

  return {
    testWaveResult: aggregatedTestResult,
    implWaveResult: aggregatedImplResult,
    testsPassing: allPassing,
    totalCost,
    attempts: maxAttempts,
    pieceResults,
    ...(firstFailure?.diagnosis != null && { diagnosis: firstFailure.diagnosis }),
    modifiedFilesPerAttempt: [],
  };
}

// --- Default file writer ---

const defaultFileWriter: FileWriter = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
};

// --- Review test file writing ---

async function writeReviewTests(findings: ReviewFinding[], workDir: string, writer: FileWriter): Promise<string[]> {
  const filesWritten: string[] = [];

  for (const finding of findings) {
    if (!finding.test_code) continue;

    const ext = path.extname(finding.file);
    const base = finding.file.replace(ext, '');
    const testFile = `${base}.review.test${ext}`;
    const fullPath = path.join(workDir, testFile);

    await writer(fullPath, finding.test_code);
    filesWritten.push(testFile);
  }

  return filesWritten;
}

// --- Review output format ---

function reviewOutputFormat(): OutputFormat {
  return {
    type: 'json_schema',
    schema: z.toJSONSchema(ReviewResultSchema, { target: 'draft-07' }) as Record<string, unknown>,
    zodSchema: ReviewResultSchema,
  };
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
    reviewFeedbackContext,
    testRunner = defaultTestRunner,
    fileWriter = defaultFileWriter,
  } = config;

  if (maxIterations < 1) {
    throw new Error('maxIterations must be at least 1');
  }

  const testCmd = await resolveTestCommand(workDir, config.testCommand);
  let totalCost = 0;
  let reviewWaveResult: WaveResult | undefined;
  let qualityWaveResult: WaveResult | undefined;
  let lastReview: ReviewResult | undefined;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    log.info(`[review-loop] Iteration ${iteration + 1}/${maxIterations}`);

    // Step 1: Fresh review agent — no prior review bias
    const reviewSystemPrompt = await loadPrompt('review', repoConfig.tools);
    const reviewExecResult = await executeWaveWithRetry({
      wave: 'review',
      systemPrompt: reviewSystemPrompt,
      userMessage: buildWaveContext('review', issue, waveResults, {
        ...(reviewFeedbackContext != null && { reviewFeedbackContext }),
      }),
      cwd: workDir,
      modelTier: repoConfig.model.review,
      outputFormat: reviewOutputFormat(),
      thinkingLevel: resolveThinkingLevel(repoConfig, 'review'),
      customTools: repoConfig.tools,
      playwright: config.playwright,
    });

    reviewWaveResult = toWaveResult('review', reviewExecResult);
    totalCost += reviewExecResult.cost;
    waveResults.review = reviewWaveResult;

    lastReview = reviewExecResult.structuredOutput as ReviewResult | undefined;

    // If review passes, we're done
    if (!lastReview || lastReview.verdict === 'pass') {
      log.info('[review-loop] Review passed');
      return {
        reviewWaveResult,
        qualityWaveResult,
        totalCost,
        iterations: iteration + 1,
        knownIssues: [],
      };
    }

    log.info(`[review-loop] Review found ${lastReview.findings.length} finding(s) — applying fixes`);

    // Step 2: Categorize findings
    const needsNewTests = lastReview.findings.filter((f) => f.category === 'needs_new_tests');
    const mechanicalFixes = lastReview.findings.filter((f) => f.category === 'mechanical_fix');

    // Track whether quality re-run is needed:
    // - NEEDS_NEW_TESTS present → always re-run (new code written)
    // - Only MECHANICAL_FIX + tests pass → skip quality
    // - MECHANICAL_FIX + tests fail → re-run quality
    let needQualityRerun = needsNewTests.length > 0;

    // Step 3: Path 1 — NEEDS_NEW_TESTS (ratcheting eval)
    if (needsNewTests.length > 0) {
      const testFilesWritten = await writeReviewTests(needsNewTests, workDir, fileWriter);

      if (testFilesWritten.length > 0) {
        // Ratchet: verify new tests fail (proving they catch the gap)
        const ratchetRun = await testRunner(testCmd, workDir);
        if (ratchetRun.passed) {
          log.warn('[review-loop] Ratchet: new tests already pass — skipping impl for needs_new_tests');
        } else {
          log.info('[review-loop] Ratchet confirmed — new tests fail, spawning impl agent');
          const implContext = buildNeedsNewTestsImplContext(needsNewTests, testFilesWritten, waveResults, prContext);
          const implSystemPrompt = await loadPrompt('impl', repoConfig.tools);
          const implExecResult = await executeWaveWithRetry({
            wave: 'impl',
            systemPrompt: implSystemPrompt,
            userMessage: implContext,
            cwd: workDir,
            modelTier: repoConfig.model.impl,
            thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
            customTools: repoConfig.tools,
          });
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
      const implSystemPrompt = await loadPrompt('impl', repoConfig.tools);
      const implExecResult = await executeWaveWithRetry({
        wave: 'impl',
        systemPrompt: implSystemPrompt,
        userMessage: implContext,
        cwd: workDir,
        modelTier: repoConfig.model.impl,
        thinkingLevel: resolveThinkingLevel(repoConfig, 'impl'),
        customTools: repoConfig.tools,
      });
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
      const qualitySystemPrompt = await loadPrompt('quality', repoConfig.tools);
      const qualityExecResult = await executeWaveWithRetry({
        wave: 'quality',
        systemPrompt: qualitySystemPrompt,
        userMessage: buildWaveContext('quality', issue, waveResults, {
          coverageThreshold: repoConfig.rules.coverage,
        }),
        cwd: workDir,
        modelTier: repoConfig.model.quality,
        thinkingLevel: resolveThinkingLevel(repoConfig, 'quality'),
        customTools: repoConfig.tools,
      });
      qualityWaveResult = toWaveResult('quality', qualityExecResult);
      totalCost += qualityExecResult.cost;
      waveResults.quality = qualityWaveResult;
    } else {
      log.info('[review-loop] Skipping quality re-run — only mechanical fixes with passing tests');
    }
  }

  // Max iterations reached — collect remaining findings as known issues
  const knownIssues = lastReview?.findings ?? [];
  log.warn(`[review-loop] Max iterations (${maxIterations}) reached — ${knownIssues.length} known issue(s) remain`);

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
