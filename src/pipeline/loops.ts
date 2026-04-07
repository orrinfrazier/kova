// T↔I loop controller — orchestrator-driven test/impl retry loop.
// R→I→T review loop controller — review/impl/test retry loop.
// Test agent runs once (writes tests). Impl agent spawns fresh per attempt.
// Tests run via bash (orchestrator), NOT via the agent.

import { exec as execCb } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { executeWaveWithRetry, type OutputFormat } from '../ai/index.js';
import { detectTooling } from '../services/language-detect.js';
import type { Issue, RepoConfig, ReviewFinding, ReviewResult, WaveName, WaveResult } from '../types/index.js';
import { ReviewResultSchema } from '../types/index.js';
import { log } from '../utils/logger.js';
import { buildWaveContext } from './context.js';
import { loadPrompt } from './prompts.js';

const exec = promisify(execCb);

// --- Types ---

export interface TestRunResult {
  passed: boolean;
  output: string;
  exitCode: number;
}

export type TestRunner = (command: string, workDir: string) => Promise<TestRunResult>;

export type TILoopDiagnosis = 'SPEC_WRONG' | 'APPROACH_WRONG' | 'STUCK';

export interface TILoopConfig {
  issue: Issue;
  workDir: string;
  repoConfig: RepoConfig;
  waveResults: Partial<Record<WaveName, WaveResult>>;
  maxRetries?: number;
  testCommand?: string;
  prContext?: string;
  testRunner?: TestRunner;
}

export interface TILoopResult {
  testWaveResult: WaveResult;
  implWaveResult: WaveResult;
  testsPassing: boolean;
  totalCost: number;
  attempts: number;
  diagnosis?: TILoopDiagnosis;
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
}

export interface ReviewLoopResult {
  reviewWaveResult: WaveResult;
  qualityWaveResult?: WaveResult | undefined;
  totalCost: number;
  iterations: number;
  knownIssues: ReviewFinding[];
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

// --- Diagnosis classification ---

function classifyDiagnosis(failureOutputs: string[]): TILoopDiagnosis {
  if (failureOutputs.length < 2) return 'STUCK';

  // Length >= 2 guaranteed by early return above
  const first = failureOutputs[0] as string;
  const firstLines = new Set(first.split('\n'));

  const allSimilar = failureOutputs.slice(1).every((output) => {
    const lines = output.split('\n');
    const matching = lines.filter((l) => firstLines.has(l)).length;
    return matching / Math.max(lines.length, 1) > 0.8;
  });

  return allSimilar ? 'SPEC_WRONG' : 'APPROACH_WRONG';
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
  };
}

// --- TI Loop Controller ---

export async function runTILoop(config: TILoopConfig): Promise<TILoopResult> {
  const { issue, workDir, repoConfig, waveResults, maxRetries = 3, prContext, testRunner = defaultTestRunner } = config;

  if (maxRetries < 1) {
    throw new Error('maxRetries must be at least 1');
  }

  const testCmd = await resolveTestCommand(workDir, config.testCommand);
  log.info(`[ti-loop] Test command: ${testCmd}`);

  let totalCost = 0;

  // Step 1: Spawn test agent — writes tests, verifies they fail
  log.info('[ti-loop] Running test wave (write failing tests)');
  const testSystemPrompt = await loadPrompt('test');
  const testExecResult = await executeWaveWithRetry({
    wave: 'test',
    systemPrompt: testSystemPrompt,
    userMessage: buildWaveContext('test', issue, waveResults),
    cwd: workDir,
    modelTier: repoConfig.model.test,
  });

  const testWaveResult = toWaveResult('test', testExecResult);
  totalCost += testExecResult.cost;

  // Prepare updated wave results with test for impl context building
  const updatedWaveResults = { ...waveResults, test: testWaveResult };

  // Step 2: Impl retry loop — orchestrator runs tests via bash
  const failureOutputs: string[] = [];
  let implWaveResult: WaveResult | undefined;
  let testsPassing = false;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    log.info(`[ti-loop] Impl attempt ${attempt + 1}/${maxRetries}`);

    // Build impl context — fresh each time with spec + test failures only
    let implContext = buildWaveContext('impl', issue, updatedWaveResults, {
      ...(prContext != null && { prContext }),
    });
    if (failureOutputs.length > 0) {
      const lastFailure = failureOutputs.at(-1) as string;
      implContext += `\n\n## Previous Test Failure Output\n\n\`\`\`\n${lastFailure}\n\`\`\``;
    }

    const implSystemPrompt = await loadPrompt('impl');
    const implExecResult = await executeWaveWithRetry({
      wave: 'impl',
      systemPrompt: implSystemPrompt,
      userMessage: implContext,
      cwd: workDir,
      modelTier: repoConfig.model.impl,
    });

    implWaveResult = toWaveResult('impl', implExecResult);
    totalCost += implExecResult.cost;

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
  if (!testsPassing) {
    diagnosis = classifyDiagnosis(failureOutputs);
    log.error(`[ti-loop] All ${maxRetries} attempts exhausted — diagnosis: ${diagnosis}`);
  }

  const attempts = failureOutputs.length + (testsPassing ? 1 : 0);

  return {
    testWaveResult,
    implWaveResult: implWaveResult as WaveResult,
    testsPassing,
    totalCost,
    attempts,
    ...(diagnosis != null && { diagnosis }),
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
    const reviewSystemPrompt = await loadPrompt('review');
    const reviewExecResult = await executeWaveWithRetry({
      wave: 'review',
      systemPrompt: reviewSystemPrompt,
      userMessage: buildWaveContext('review', issue, waveResults),
      cwd: workDir,
      modelTier: repoConfig.model.review,
      outputFormat: reviewOutputFormat(),
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
          const implSystemPrompt = await loadPrompt('impl');
          const implExecResult = await executeWaveWithRetry({
            wave: 'impl',
            systemPrompt: implSystemPrompt,
            userMessage: implContext,
            cwd: workDir,
            modelTier: repoConfig.model.impl,
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
      const implSystemPrompt = await loadPrompt('impl');
      const implExecResult = await executeWaveWithRetry({
        wave: 'impl',
        systemPrompt: implSystemPrompt,
        userMessage: implContext,
        cwd: workDir,
        modelTier: repoConfig.model.impl,
      });
      totalCost += implExecResult.cost;
      waveResults.impl = toWaveResult('impl', implExecResult);

      // Verify tests still pass (safety net)
      const verifyRun = await testRunner(testCmd, workDir);
      if (!verifyRun.passed) {
        log.warn('[review-loop] Tests broke during MECHANICAL_FIX impl');
      }
    }

    // Step 5: Re-run quality gates
    const qualitySystemPrompt = await loadPrompt('quality');
    const qualityExecResult = await executeWaveWithRetry({
      wave: 'quality',
      systemPrompt: qualitySystemPrompt,
      userMessage: buildWaveContext('quality', issue, waveResults, {
        coverageThreshold: repoConfig.rules.coverage,
      }),
      cwd: workDir,
      modelTier: repoConfig.model.quality,
    });
    qualityWaveResult = toWaveResult('quality', qualityExecResult);
    totalCost += qualityExecResult.cost;
    waveResults.quality = qualityWaveResult;
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
