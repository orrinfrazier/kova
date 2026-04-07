// T↔I loop controller — orchestrator-driven test/impl retry loop.
// Test agent runs once (writes tests). Impl agent spawns fresh per attempt.
// Tests run via bash (orchestrator), NOT via the agent.

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { executeWaveWithRetry } from '../ai/index.js';
import { detectTooling } from '../services/language-detect.js';
import type { Issue, RepoConfig, WaveName, WaveResult } from '../types/index.js';
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
