import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig, SpecPiece, WaveName, WaveResult } from '../types/index.js';

// Mock the AI layer — no real Agent SDK calls in tests
vi.mock('../ai/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ai/index.js')>();
  return {
    executeWaveWithRetry: vi.fn(),
    resolveThinkingLevel: actual.resolveThinkingLevel,
  };
});

// Mock language detection
vi.mock('../services/language-detect.js', () => ({
  detectTooling: vi.fn().mockResolvedValue({
    language: 'typescript',
    testRunner: 'vitest',
  }),
}));

// Mock prompt loading
vi.mock('./prompts.js', () => ({
  loadPrompt: vi.fn().mockResolvedValue('mock system prompt'),
}));

const {
  runTILoop,
  runPieceTILoop,
  runParallelPieceTILoop,
  runReviewLoop,
  resolveTestCommand,
  normalizeTestOutput,
  extractFailingTestNames,
  classifyDiagnosis,
  detectThrashing,
} = await import('./loops.js');
const { executeWaveWithRetry } = await import('../ai/index.js');
const { detectTooling } = await import('../services/language-detect.js');

type TestRunner = (command: string, workDir: string) => Promise<{ passed: boolean; output: string; exitCode: number }>;

const mockExecute = vi.mocked(executeWaveWithRetry);

function makeIssue(n = 42): Issue {
  return { number: n, title: `Test issue ${n}`, body: 'body', labels: [], url: `https://example.com/${n}` };
}

function makeConfig(): RepoConfig {
  return {
    path: '/tmp/test',
    rules: { coverage: 80, auto_merge: false, max_issues_per_run: 10 },
    model: {
      assess: 'large',
      spec: 'large',
      test: 'medium',
      impl: 'medium',
      quality: 'small',
      review: 'large',
      brainstorm: 'large',
    },
    isolation: 'none',
  };
}

function testWaveExecResult(overrides?: Partial<Record<string, unknown>>) {
  return {
    result: 'done',
    success: true,
    duration: 100,
    turns: 1,
    cost: 0.05,
    model: 'test-model',
    structuredOutput: { test_files_created: ['src/__tests__/foo.test.ts'], test_count: 3, all_failing: true },
    ...overrides,
  };
}

function implWaveExecResult(overrides?: Partial<Record<string, unknown>>) {
  return {
    result: 'done',
    success: true,
    duration: 200,
    turns: 5,
    cost: 0.1,
    model: 'impl-model',
    ...overrides,
  };
}

describe('runTILoop', () => {
  let mockTestRunner: TestRunner;

  beforeEach(() => {
    mockExecute.mockClear();
    mockTestRunner = vi.fn();
    // Default: test wave first, then impl for all subsequent calls
    mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValue(implWaveExecResult());
  });

  it('runs test agent once and impl agent once when tests pass on first attempt', async () => {
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls.filter((w) => w === 'test')).toHaveLength(1);
    expect(waveCalls.filter((w) => w === 'impl')).toHaveLength(1);
    expect(result.testsPassing).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.diagnosis).toBeUndefined();
  });

  it('retries impl when tests fail, succeeds on second attempt', async () => {
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL: expected X', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const implCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'impl');
    expect(implCalls).toHaveLength(2);
    expect(result.testsPassing).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.diagnosis).toBeUndefined();
  });

  it('passes test failure output to impl retry context', async () => {
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL: TypeError at line 42', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const implCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'impl');
    // First impl: no failure context
    expect(implCalls.at(0)?.[0].userMessage).not.toContain('Previous Test Failure Output');
    // Second impl: includes failure output from first attempt
    expect(implCalls.at(1)?.[0].userMessage).toContain('Previous Test Failure Output');
    expect(implCalls.at(1)?.[0].userMessage).toContain('FAIL: TypeError at line 42');
  });

  it('each impl retry is a fresh agent call (not accumulated context)', async () => {
    // Use same test name → SPEC_WRONG diagnosis (no escalation hint), isolating the "fresh context" behavior
    const sameTestFail1 = ' FAIL  src/a.test.ts > suite > test one\n   Error: attempt-1-detail';
    const sameTestFail2 = ' FAIL  src/a.test.ts > suite > test one\n   Error: attempt-2-detail';

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: sameTestFail1, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: sameTestFail2, exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const implCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'impl');
    expect(implCalls).toHaveLength(3);

    // Third impl should only have the LAST failure in "Previous Test Failure Output", not accumulated history
    const thirdImplMsg = implCalls.at(2)?.[0].userMessage;
    expect(thirdImplMsg).toContain('attempt-2-detail');
    // Should not contain the first error (fresh context, only most recent failure)
    expect(thirdImplMsg).not.toContain('attempt-1-detail');
  });

  it('runs tests via bash (testRunner), not via agent', async () => {
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    // testRunner was called — this is the bash execution
    expect(mockTestRunner).toHaveBeenCalledWith('npm test', '/tmp/test');

    // Agent was only called for test wave (write tests) and impl — no extra bash agent
    const waveNames = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveNames).toEqual(['test', 'impl']);
  });

  it('defaults to 3 maxRetries', async () => {
    vi.mocked(mockTestRunner).mockResolvedValue({ passed: false, output: 'fail', exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const implCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'impl');
    expect(implCalls).toHaveLength(3);
    expect(result.attempts).toBe(3);
    expect(result.testsPassing).toBe(false);
  });

  it('honors configurable maxRetries', async () => {
    vi.mocked(mockTestRunner).mockResolvedValue({ passed: false, output: 'fail', exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      maxRetries: 2,
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const implCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'impl');
    expect(implCalls).toHaveLength(2);
    expect(result.attempts).toBe(2);
    expect(result.testsPassing).toBe(false);
  });

  it('returns SPEC_WRONG diagnosis when same test names fail across attempts', async () => {
    const attempt1 = [
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens',
      '   AssertionError: expected true to be false',
      '     at src/auth.test.ts:42:10',
      '   Duration: 123ms',
      ' FAIL  src/auth.test.ts > AuthService > rejects invalid signatures',
      '   Error: token verification failed',
      '     at src/auth.test.ts:58:5',
      '   Duration: 45ms',
      '',
      ' Tests: 2 failed, 8 passed',
      ' Time:  1.234s',
    ].join('\n');
    const attempt2 = [
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens',
      '   AssertionError: expected true to be false',
      '     at src/auth.test.ts:42:10',
      '   Duration: 187ms',
      ' FAIL  src/auth.test.ts > AuthService > rejects invalid signatures',
      '   Error: token verification failed',
      '     at src/auth.test.ts:58:5',
      '   Duration: 31ms',
      '',
      ' Tests: 2 failed, 8 passed',
      ' Time:  1.891s',
    ].join('\n');
    const attempt3 = [
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens',
      '   AssertionError: expected true to be false',
      '     at src/auth.test.ts:42:10',
      '   Duration: 99ms',
      ' FAIL  src/auth.test.ts > AuthService > rejects invalid signatures',
      '   Error: token verification failed',
      '     at src/auth.test.ts:58:5',
      '   Duration: 67ms',
      '',
      ' Tests: 2 failed, 8 passed',
      ' Time:  0.987s',
    ].join('\n');

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: attempt1, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: attempt2, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: attempt3, exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(false);
    expect(result.diagnosis).toBe('SPEC_WRONG');
  });

  it('returns APPROACH_WRONG diagnosis when different test names fail across attempts', async () => {
    const attempt1 = [
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens',
      '   TypeError: cannot read undefined',
      '     at src/auth.ts:5:12',
      '   Duration: 44ms',
    ].join('\n');
    const attempt2 = [
      ' FAIL  src/parser.test.ts > Parser > handles nested expressions',
      '   RangeError: maximum call stack exceeded',
      '     at src/parser.ts:99:3',
      '   Duration: 201ms',
    ].join('\n');
    const attempt3 = [
      ' FAIL  src/config.test.ts > Config > loads YAML files',
      '   SyntaxError: unexpected token',
      '     at src/config.ts:1:1',
      '   Duration: 12ms',
    ].join('\n');

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: attempt1, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: attempt2, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: attempt3, exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(false);
    expect(result.diagnosis).toBe('APPROACH_WRONG');
  });

  it('returns STUCK diagnosis when only one failure attempt', async () => {
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: false, output: 'fail', exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      maxRetries: 1,
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.diagnosis).toBe('STUCK');
  });

  it('returns MISSING_CONTEXT when impl output contains "cannot find" patterns', async () => {
    const missingCtxOutput = [
      "error TS2307: Cannot find module './missing-service' or its corresponding type declarations.",
      '  at src/handler.ts:3:1',
      '',
      ' FAIL  src/handler.test.ts > Handler > processes requests',
      "   Error: Cannot find module './missing-service'",
      '   Duration: 5ms',
    ].join('\n');

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: missingCtxOutput, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: missingCtxOutput, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: missingCtxOutput, exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(false);
    expect(result.diagnosis).toBe('MISSING_CONTEXT');
  });

  it('tracks cost across all attempts', async () => {
    mockExecute.mockReset();
    // Test wave: cost 0.05
    mockExecute.mockResolvedValueOnce(testWaveExecResult({ cost: 0.05 }));
    // Impl attempt 1: cost 0.10
    mockExecute.mockResolvedValueOnce(implWaveExecResult({ cost: 0.1 }));
    // Impl attempt 2: cost 0.15
    mockExecute.mockResolvedValueOnce(implWaveExecResult({ cost: 0.15 }));

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'fail', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.totalCost).toBeCloseTo(0.3);
    expect(result.attempts).toBe(2);
  });

  it('returns both test and impl wave results', async () => {
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testWaveResult.wave).toBe('test');
    expect(result.testWaveResult.success).toBe(true);
    expect(result.testWaveResult.cost).toBe(0.05);

    expect(result.implWaveResult.wave).toBe('impl');
    expect(result.implWaveResult.success).toBe(true);
    expect(result.implWaveResult.cost).toBe(0.1);
  });

  it('uses correct model tiers from config', async () => {
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const testCall = mockExecute.mock.calls.find((c) => c[0].wave === 'test');
    const implCall = mockExecute.mock.calls.find((c) => c[0].wave === 'impl');
    expect(testCall?.[0].modelTier).toBe('medium');
    expect(implCall?.[0].modelTier).toBe('medium');
  });

  it('passes existing waveResults to context builder for impl', async () => {
    const specResult: WaveResult = {
      wave: 'spec',
      success: true,
      artifact: { summary: 'test spec', pieces: [], dependency_order: [], constraints: [] },
      duration: 100,
      cost: 0.01,
      turns: 1,
    };
    const waveResults: Partial<Record<WaveName, WaveResult>> = { spec: specResult };

    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults,
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    // The impl wave should have received context built from spec + test results
    const implCall = mockExecute.mock.calls.find((c) => c[0].wave === 'impl');
    expect(implCall).toBeDefined();
    // Context building happens internally — just verify the call was made
    expect(implCall?.[0].userMessage).toBeDefined();
  });

  it('injects escalation hint into impl context when APPROACH_WRONG diagnosed mid-loop', async () => {
    // Attempt 1: fails with test A
    const attempt1Output =
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens\n   TypeError: cannot read undefined';
    // Attempt 2: fails with different test B (→ APPROACH_WRONG)
    const attempt2Output =
      ' FAIL  src/parser.test.ts > Parser > handles nested expressions\n   RangeError: maximum call stack exceeded';

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: attempt1Output, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: attempt2Output, exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const implCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'impl');
    expect(implCalls).toHaveLength(3);

    // First impl: no escalation (0 failures)
    expect(implCalls.at(0)?.[0].userMessage).not.toContain('Escalation');
    // Second impl: no escalation (only 1 failure, can't classify yet)
    expect(implCalls.at(1)?.[0].userMessage).not.toContain('Escalation');
    // Third impl: APPROACH_WRONG diagnosed from 2 failures → escalation hint injected
    expect(implCalls.at(2)?.[0].userMessage).toContain('Escalation');
    expect(implCalls.at(2)?.[0].userMessage).toContain('different strategy');
  });

  it('escalation hint summarizes previous approaches from failure outputs', async () => {
    const attempt1Output =
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens\n   TypeError: cannot read undefined';
    const attempt2Output =
      ' FAIL  src/parser.test.ts > Parser > handles nested expressions\n   RangeError: maximum call stack exceeded';

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: attempt1Output, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: attempt2Output, exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const implCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'impl');
    const thirdImplMsg = implCalls.at(2)?.[0].userMessage as string;

    // Should reference previous failure outputs so the agent knows what was tried
    expect(thirdImplMsg).toContain('Attempt 1');
    expect(thirdImplMsg).toContain('Attempt 2');
  });

  it('does not inject escalation hint for SPEC_WRONG diagnosis', async () => {
    // Same test names fail across attempts → SPEC_WRONG, not APPROACH_WRONG
    const sameFailure = ' FAIL  src/auth.test.ts > AuthService > validates expired tokens\n   Error: fail';

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: sameFailure, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: sameFailure, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: sameFailure, exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    const implCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'impl');
    // No impl call should have escalation hint for SPEC_WRONG
    for (const call of implCalls) {
      expect(call[0].userMessage).not.toContain('Escalation');
    }
    expect(result.diagnosis).toBe('SPEC_WRONG');
  });

  it('throws when maxRetries is less than 1', async () => {
    await expect(
      runTILoop({
        issue: makeIssue(),
        workDir: '/tmp/test',
        repoConfig: makeConfig(),
        waveResults: {},
        maxRetries: 0,
        testRunner: mockTestRunner,
        testCommand: 'npm test',
      }),
    ).rejects.toThrow('maxRetries must be at least 1');
  });

  it('propagates error when test wave agent fails', async () => {
    mockExecute.mockReset();
    mockExecute.mockRejectedValueOnce(new Error('Agent billing error'));

    await expect(
      runTILoop({
        issue: makeIssue(),
        workDir: '/tmp/test',
        repoConfig: makeConfig(),
        waveResults: {},
        testRunner: mockTestRunner,
        testCommand: 'npm test',
      }),
    ).rejects.toThrow('Agent billing error');
  });
});

describe('resolveTestCommand', () => {
  beforeEach(() => {
    vi.mocked(detectTooling).mockClear();
  });

  it('returns explicit command when provided', async () => {
    expect(await resolveTestCommand('/tmp', 'cargo test')).toBe('cargo test');
  });

  it('detects vitest test command from tooling', async () => {
    vi.mocked(detectTooling).mockResolvedValueOnce({
      language: 'typescript',
      testRunner: 'vitest',
    });
    expect(await resolveTestCommand('/tmp')).toBe('npx vitest run');
  });

  it('detects jest test command from tooling', async () => {
    vi.mocked(detectTooling).mockResolvedValueOnce({
      language: 'typescript',
      testRunner: 'jest',
    });
    expect(await resolveTestCommand('/tmp')).toBe('npx jest');
  });

  it('detects cargo test command from tooling', async () => {
    vi.mocked(detectTooling).mockResolvedValueOnce({
      language: 'rust',
      testRunner: 'cargo-test',
    });
    expect(await resolveTestCommand('/tmp')).toBe('cargo test');
  });

  it('detects go test command from tooling', async () => {
    vi.mocked(detectTooling).mockResolvedValueOnce({
      language: 'go',
      testRunner: 'go-test',
    });
    expect(await resolveTestCommand('/tmp')).toBe('go test ./...');
  });

  it('detects pytest command from tooling', async () => {
    vi.mocked(detectTooling).mockResolvedValueOnce({
      language: 'python',
      testRunner: 'pytest',
    });
    expect(await resolveTestCommand('/tmp')).toBe('pytest');
  });

  it('throws when no test command detected', async () => {
    vi.mocked(detectTooling).mockResolvedValueOnce({ language: 'unknown' });
    await expect(resolveTestCommand('/tmp')).rejects.toThrow('Cannot detect test command');
  });

  it('throws when test runner is unrecognized', async () => {
    vi.mocked(detectTooling).mockResolvedValueOnce({
      language: 'typescript',
      testRunner: 'unknown-runner',
    });
    await expect(resolveTestCommand('/tmp')).rejects.toThrow('Cannot detect test command');
  });
});

// --- normalizeTestOutput tests ---

describe('normalizeTestOutput', () => {
  it('strips timestamps from output lines', () => {
    const input = '2026-04-07T12:34:56.789Z  FAIL  src/auth.test.ts > test name';
    const normalized = normalizeTestOutput(input);
    expect(normalized).not.toContain('2026-04-07T12:34:56.789Z');
    expect(normalized).toContain('FAIL');
  });

  it('strips duration values', () => {
    const input = '   Duration: 1234ms\n   Duration: 0.5s\n   Time:  3.456s';
    const normalized = normalizeTestOutput(input);
    expect(normalized).not.toMatch(/\d+ms/);
    expect(normalized).not.toMatch(/\d+\.\d+s/);
  });

  it('strips line numbers from stack traces', () => {
    const input = '    at src/auth.ts:42:10\n    at src/handler.ts:99:3';
    const normalized = normalizeTestOutput(input);
    expect(normalized).not.toContain(':42:10');
    expect(normalized).not.toContain(':99:3');
  });

  it('preserves test names and failure messages', () => {
    const input =
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens\n   AssertionError: expected true to be false';
    const normalized = normalizeTestOutput(input);
    expect(normalized).toContain('validates expired tokens');
    expect(normalized).toContain('AssertionError');
  });

  it('strips vitest/jest summary line counts', () => {
    const input = ' Tests: 2 failed, 8 passed\n Time:  1.234s';
    const normalized = normalizeTestOutput(input);
    expect(normalized).not.toMatch(/\d+ failed/);
    expect(normalized).not.toMatch(/\d+ passed/);
  });
});

// --- extractFailingTestNames tests ---

describe('extractFailingTestNames', () => {
  it('extracts vitest-style failing test names', () => {
    const output = [
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens',
      '   AssertionError: expected true to be false',
      '     at src/auth.test.ts:42:10',
      ' FAIL  src/auth.test.ts > AuthService > rejects invalid signatures',
      '   Error: token verification failed',
    ].join('\n');

    const names = extractFailingTestNames(output);
    expect(names).toEqual(['AuthService > validates expired tokens', 'AuthService > rejects invalid signatures']);
  });

  it('extracts jest-style failing test names', () => {
    const output = [
      '  ● AuthService › validates expired tokens',
      '',
      '    expect(received).toBe(expected)',
      '',
      '  ● AuthService › rejects invalid signatures',
      '',
      '    Error: token verification failed',
    ].join('\n');

    const names = extractFailingTestNames(output);
    expect(names).toEqual(['AuthService › validates expired tokens', 'AuthService › rejects invalid signatures']);
  });

  it('extracts cargo test failing test names', () => {
    const output = [
      'test auth::tests::validates_expired_tokens ... FAILED',
      'test auth::tests::rejects_invalid_signatures ... FAILED',
      '',
      'failures:',
      '    auth::tests::validates_expired_tokens',
      '    auth::tests::rejects_invalid_signatures',
    ].join('\n');

    const names = extractFailingTestNames(output);
    expect(names).toContain('auth::tests::validates_expired_tokens');
    expect(names).toContain('auth::tests::rejects_invalid_signatures');
  });

  it('extracts pytest failing test names', () => {
    const output = [
      'FAILED tests/test_auth.py::TestAuth::test_validates_expired_tokens',
      'FAILED tests/test_auth.py::TestAuth::test_rejects_invalid_signatures',
    ].join('\n');

    const names = extractFailingTestNames(output);
    expect(names).toContain('test_validates_expired_tokens');
    expect(names).toContain('test_rejects_invalid_signatures');
  });

  it('extracts go test failing test names', () => {
    const output = [
      '--- FAIL: TestValidatesExpiredTokens (0.00s)',
      '    auth_test.go:42: expected true, got false',
      '--- FAIL: TestRejectsInvalidSignatures (0.00s)',
      '    auth_test.go:58: token verification failed',
    ].join('\n');

    const names = extractFailingTestNames(output);
    expect(names).toContain('TestValidatesExpiredTokens');
    expect(names).toContain('TestRejectsInvalidSignatures');
  });

  it('returns empty array when no test names found', () => {
    const output = 'some random error output with no test names';
    const names = extractFailingTestNames(output);
    expect(names).toEqual([]);
  });

  it('deduplicates test names', () => {
    const output = [
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens',
      '   AssertionError: expected true to be false',
      ' FAIL  src/auth.test.ts > AuthService > validates expired tokens',
      '   AssertionError: expected true to be false',
    ].join('\n');

    const names = extractFailingTestNames(output);
    expect(names).toEqual(['AuthService > validates expired tokens']);
  });
});

// --- classifyDiagnosis unit tests ---

describe('classifyDiagnosis', () => {
  it('returns STUCK when fewer than 2 outputs', () => {
    expect(classifyDiagnosis(['single failure'])).toBe('STUCK');
    expect(classifyDiagnosis([])).toBe('STUCK');
  });

  it('returns SPEC_WRONG when same test names fail across all attempts', () => {
    const attempt1 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail\n   Duration: 100ms';
    const attempt2 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail\n   Duration: 200ms';
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('SPEC_WRONG');
  });

  it('returns APPROACH_WRONG when different test names fail across attempts', () => {
    const attempt1 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    const attempt2 = ' FAIL  src/b.test.ts > suite > test two\n   Error: fail';
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('APPROACH_WRONG');
  });

  it('returns MISSING_CONTEXT when output contains "cannot find module" patterns', () => {
    const attempt1 = "error TS2307: Cannot find module './missing'\n FAIL  src/a.test.ts > test\n   Duration: 5ms";
    const attempt2 = "error TS2307: Cannot find module './missing'\n FAIL  src/a.test.ts > test\n   Duration: 8ms";
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('MISSING_CONTEXT');
  });

  it('returns MISSING_CONTEXT when output contains "no such file" pattern', () => {
    const attempt1 = "Error: ENOENT: no such file or directory, open '/tmp/data.json'\n FAIL  src/a.test.ts > test";
    const attempt2 = "Error: ENOENT: no such file or directory, open '/tmp/data.json'\n FAIL  src/a.test.ts > test";
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('MISSING_CONTEXT');
  });

  it('returns MISSING_CONTEXT when output contains "not provided" pattern', () => {
    const attempt1 = 'Configuration not provided for database connection\n FAIL  src/a.test.ts > test';
    const attempt2 = 'Configuration not provided for database connection\n FAIL  src/a.test.ts > test';
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('MISSING_CONTEXT');
  });

  it('MISSING_CONTEXT takes priority over SPEC_WRONG when both match', () => {
    const attempt1 = "Cannot find module './service'\n FAIL  src/a.test.ts > test one\n   Error: fail";
    const attempt2 = "Cannot find module './service'\n FAIL  src/a.test.ts > test one\n   Error: fail";
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('MISSING_CONTEXT');
  });

  it('falls back to normalized line overlap when no test names extracted', () => {
    // No recognizable test name patterns, but similar output
    const attempt1 = 'error: compilation failed\nsrc/lib.rs: missing semicolon';
    const attempt2 = 'error: compilation failed\nsrc/lib.rs: missing semicolon';
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('SPEC_WRONG');
  });

  it('falls back to APPROACH_WRONG for dissimilar output without test names', () => {
    const attempt1 = 'error: compilation failed\nsrc/lib.rs: missing semicolon';
    const attempt2 = 'error: linking failed\nld: undefined symbol _main';
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('APPROACH_WRONG');
  });
});

// --- runReviewLoop tests ---

type FileWriter = (filePath: string, content: string) => Promise<void>;

function reviewExecResult(
  verdict: 'pass' | 'needs_fixes',
  findings: unknown[] = [],
  overrides?: Partial<Record<string, unknown>>,
) {
  return {
    result: 'done',
    success: true,
    duration: 100,
    turns: 2,
    cost: 0.08,
    model: 'review-model',
    structuredOutput: { verdict, findings, summary: 'review summary' },
    ...overrides,
  };
}

function qualityExecResult(overrides?: Partial<Record<string, unknown>>) {
  return {
    result: 'done',
    success: true,
    duration: 50,
    turns: 1,
    cost: 0.02,
    model: 'quality-model',
    structuredOutput: {
      lint: 'pass',
      typecheck: 'pass',
      tests: 'pass',
      coverage: 85,
      audit: 'pass',
      all_passing: true,
    },
    ...overrides,
  };
}

const needsNewTestsFinding = {
  category: 'needs_new_tests' as const,
  file: 'src/auth.ts',
  description: 'Missing edge case test for expired tokens',
  severity: 'high' as const,
  test_code: 'import { test } from "vitest";\ntest("expired token", () => { throw new Error("not implemented"); });',
};

const mechanicalFixFinding = {
  category: 'mechanical_fix' as const,
  file: 'src/utils.ts',
  line: 42,
  description: 'Unused variable should be removed',
  severity: 'low' as const,
};

describe('runReviewLoop', () => {
  let mockTestRunner: TestRunner;
  let mockFileWriter: FileWriter;

  beforeEach(() => {
    mockExecute.mockReset();
    mockTestRunner = vi.fn();
    mockFileWriter = vi.fn().mockResolvedValue(undefined);
  });

  it('returns immediately when review passes on first iteration', async () => {
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    expect(result.iterations).toBe(1);
    expect(result.knownIssues).toHaveLength(0);
    expect(result.reviewWaveResult.wave).toBe('review');
    expect(result.reviewWaveResult.success).toBe(true);
    // No impl/quality waves should have run
    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).toEqual(['review']);
  });

  it('handles NEEDS_NEW_TESTS path: writes tests, verifies ratchet, runs impl', async () => {
    // Iteration 1: review finds needs_new_tests
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [needsNewTestsFinding]));
    // Impl agent for needs_new_tests
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    // Quality gates
    mockExecute.mockResolvedValueOnce(qualityExecResult());
    // Iteration 2: fresh review passes
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    // Ratchet: tests should fail first (verifying new tests catch the gap)
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL: expired token test', exitCode: 1 })
      // After impl: tests should pass
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    // File writer should have been called with the test code
    expect(mockFileWriter).toHaveBeenCalledTimes(1);
    const writerCall = vi.mocked(mockFileWriter).mock.calls[0];
    expect(writerCall?.[0]).toContain('src/auth.review.test.ts');
    expect(writerCall?.[1]).toContain('expired token');

    // Ratchet check ran (tests should fail)
    expect(mockTestRunner).toHaveBeenCalledTimes(2);

    expect(result.iterations).toBe(2);
    expect(result.knownIssues).toHaveLength(0);
  });

  it('handles MECHANICAL_FIX path: runs impl, verifies tests, skips quality', async () => {
    // Iteration 1: review finds mechanical_fix
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [mechanicalFixFinding]));
    // Impl agent for mechanical fix
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    // NO quality — tests pass, only mechanical fixes
    // Iteration 2: fresh review passes
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    // After mechanical fix impl: tests should still pass
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    // No file writing for mechanical fixes
    expect(mockFileWriter).not.toHaveBeenCalled();

    // Tests ran once (verify nothing broke)
    expect(mockTestRunner).toHaveBeenCalledTimes(1);

    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).toEqual(['review', 'impl', 'review']);
    expect(result.iterations).toBe(2);
    expect(result.qualityWaveResult).toBeUndefined();
    expect(result.knownIssues).toHaveLength(0);
  });

  it('re-runs quality when mechanical fix breaks tests', async () => {
    // Iteration 1: review finds only mechanical fixes
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [mechanicalFixFinding]));
    // Impl agent for mechanical fix
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    // Quality gates (needed because tests broke)
    mockExecute.mockResolvedValueOnce(qualityExecResult());
    // Iteration 2: fresh review passes
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    // After mechanical fix impl: tests FAIL (quality re-run needed)
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: false, output: 'FAIL: broke something', exitCode: 1 });

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).toEqual(['review', 'impl', 'quality', 'review']);
    expect(result.iterations).toBe(2);
    expect(result.qualityWaveResult).toBeDefined();
    expect(result.knownIssues).toHaveLength(0);
  });

  it('handles both NEEDS_NEW_TESTS and MECHANICAL_FIX in same iteration', async () => {
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [needsNewTestsFinding, mechanicalFixFinding]));
    // Impl for needs_new_tests
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    // Impl for mechanical_fix
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    // Quality gates
    mockExecute.mockResolvedValueOnce(qualityExecResult());
    // Iteration 2: passes
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    vi.mocked(mockTestRunner)
      // Ratchet: fail (good)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL', exitCode: 1 })
      // After needs_new_tests impl: pass
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 })
      // After mechanical_fix impl: pass
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    // Both paths executed: file written for needs_new_tests only
    expect(mockFileWriter).toHaveBeenCalledTimes(1);

    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).toEqual(['review', 'impl', 'impl', 'quality', 'review']);
    expect(result.iterations).toBe(2);
    expect(result.knownIssues).toHaveLength(0);
  });

  it('caps at maxIterations and collects known issues', async () => {
    // Both iterations return needs_fixes (mechanical only, tests pass → no quality)
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [mechanicalFixFinding]));
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [mechanicalFixFinding]));
    mockExecute.mockResolvedValueOnce(implWaveExecResult());

    vi.mocked(mockTestRunner).mockResolvedValue({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      maxIterations: 2,
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    expect(result.iterations).toBe(2);
    expect(result.knownIssues).toHaveLength(1);
    expect(result.knownIssues[0]).toMatchObject({
      category: 'mechanical_fix',
      file: 'src/utils.ts',
    });
  });

  it('each review iteration uses a fresh agent call', async () => {
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [mechanicalFixFinding]));
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    // No quality — mechanical only, tests pass
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    vi.mocked(mockTestRunner).mockResolvedValue({ passed: true, output: 'ok', exitCode: 0 });

    await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    const reviewCalls = mockExecute.mock.calls.filter((c) => c[0].wave === 'review');
    expect(reviewCalls).toHaveLength(2);
    // Each is a separate call — fresh agent, no accumulated context
    expect(reviewCalls[0]).not.toBe(reviewCalls[1]);
  });

  it('tracks cost across all loop iterations', async () => {
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [mechanicalFixFinding], { cost: 0.1 }));
    mockExecute.mockResolvedValueOnce(implWaveExecResult({ cost: 0.2 }));
    // No quality — mechanical only, tests pass
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass', [], { cost: 0.08 }));

    vi.mocked(mockTestRunner).mockResolvedValue({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    expect(result.totalCost).toBeCloseTo(0.38);
  });

  it('skips impl when ratchet check passes (tests already pass with new test code)', async () => {
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [needsNewTestsFinding]));
    // Quality gates (no impl since ratchet passed)
    mockExecute.mockResolvedValueOnce(qualityExecResult());
    // Second review passes
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    // Ratchet: tests already pass — skip impl
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    // No impl wave should have run
    const waveCalls = mockExecute.mock.calls.map((c) => c[0].wave);
    expect(waveCalls).toEqual(['review', 'quality', 'review']);
    expect(result.knownIssues).toHaveLength(0);
  });

  it('skips needs_new_tests findings without test_code', async () => {
    const findingWithoutCode = { ...needsNewTestsFinding, test_code: undefined };
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [findingWithoutCode]));
    // Quality gates
    mockExecute.mockResolvedValueOnce(qualityExecResult());
    // Second review
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    // No files written, no ratchet check, no impl
    expect(mockFileWriter).not.toHaveBeenCalled();
    expect(mockTestRunner).not.toHaveBeenCalled();
  });

  it('throws when maxIterations is less than 1', async () => {
    await expect(
      runReviewLoop({
        issue: makeIssue(),
        workDir: '/tmp/test',
        repoConfig: makeConfig(),
        waveResults: {},
        maxIterations: 0,
        testRunner: mockTestRunner,
        fileWriter: mockFileWriter,
        testCommand: 'npm test',
      }),
    ).rejects.toThrow('maxIterations must be at least 1');
  });

  it('defaults to maxIterations of 2', async () => {
    // 3 iterations of needs_fixes — should only do 2 (mechanical only, tests pass → no quality)
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [mechanicalFixFinding]));
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [mechanicalFixFinding]));
    mockExecute.mockResolvedValueOnce(implWaveExecResult());

    vi.mocked(mockTestRunner).mockResolvedValue({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    // Default max is 2
    expect(result.iterations).toBe(2);
    expect(result.knownIssues).toHaveLength(1);
  });

  it('uses correct model tiers from config', async () => {
    // Use NEEDS_NEW_TESTS so quality runs (needed to verify quality model tier)
    mockExecute.mockResolvedValueOnce(reviewExecResult('needs_fixes', [needsNewTestsFinding]));
    mockExecute.mockResolvedValueOnce(implWaveExecResult());
    mockExecute.mockResolvedValueOnce(qualityExecResult());
    mockExecute.mockResolvedValueOnce(reviewExecResult('pass'));

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    await runReviewLoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      fileWriter: mockFileWriter,
      testCommand: 'npm test',
    });

    const reviewCall = mockExecute.mock.calls.find((c) => c[0].wave === 'review');
    const implCall = mockExecute.mock.calls.find((c) => c[0].wave === 'impl');
    const qualityCall = mockExecute.mock.calls.find((c) => c[0].wave === 'quality');
    expect(reviewCall?.[0].modelTier).toBe('large');
    expect(implCall?.[0].modelTier).toBe('medium');
    expect(qualityCall?.[0].modelTier).toBe('small');
  });
});

// --- detectThrashing tests ---

describe('detectThrashing', () => {
  it('returns INSUFFICIENT_DATA when fewer than 2 attempts', () => {
    expect(detectThrashing([])).toBe('INSUFFICIENT_DATA');
    expect(detectThrashing([['src/a.ts']])).toBe('INSUFFICIENT_DATA');
  });

  it('returns SAME_FILES when identical files modified across all attempts', () => {
    const attempts = [
      ['src/auth.ts', 'src/handler.ts'],
      ['src/auth.ts', 'src/handler.ts'],
      ['src/auth.ts', 'src/handler.ts'],
    ];
    expect(detectThrashing(attempts)).toBe('SAME_FILES');
  });

  it('returns SAME_FILES when overlap is >= 80%', () => {
    const attempts = [
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/f.ts'], // 4/5 = 80%
    ];
    expect(detectThrashing(attempts)).toBe('SAME_FILES');
  });

  it('returns DIFFERENT_FILES when overlap is < 20%', () => {
    const attempts = [
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'],
      ['src/f.ts', 'src/g.ts', 'src/h.ts', 'src/i.ts', 'src/j.ts'], // 0/5 = 0%
    ];
    expect(detectThrashing(attempts)).toBe('DIFFERENT_FILES');
  });

  it('returns NORMAL for partial overlap between 20% and 80%', () => {
    const attempts = [
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      ['src/a.ts', 'src/b.ts', 'src/e.ts', 'src/f.ts'], // 2/4 = 50%
    ];
    expect(detectThrashing(attempts)).toBe('NORMAL');
  });

  it('handles empty file lists within attempts', () => {
    const attempts = [[], []];
    // No files modified at all — insufficient signal, treat as INSUFFICIENT_DATA
    expect(detectThrashing(attempts)).toBe('INSUFFICIENT_DATA');
  });

  it('compares all pairs, not just adjacent attempts', () => {
    // Attempt 1 and 3 match, but attempt 2 is completely different
    const attempts = [
      ['src/a.ts', 'src/b.ts'],
      ['src/x.ts', 'src/y.ts'],
      ['src/a.ts', 'src/b.ts'],
    ];
    // Average overlap across consecutive pairs: (0% + 0%) / 2 = not SAME_FILES
    expect(detectThrashing(attempts)).not.toBe('SAME_FILES');
  });
});

// --- TILoop modified files tracking tests ---

describe('runTILoop — modified files tracking', () => {
  let mockTestRunner: TestRunner;
  type DiffRunner = (workDir: string) => Promise<string[]>;
  let mockDiffRunner: DiffRunner;

  beforeEach(() => {
    mockExecute.mockReset();
    mockTestRunner = vi.fn();
    mockDiffRunner = vi.fn();
    mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValue(implWaveExecResult());
  });

  it('captures modified files per attempt via diffRunner', async () => {
    vi.mocked(mockDiffRunner)
      .mockResolvedValueOnce(['src/auth.ts', 'src/handler.ts'])
      .mockResolvedValueOnce(['src/auth.ts', 'src/handler.ts']);

    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'fail', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      diffRunner: mockDiffRunner,
      testCommand: 'npm test',
    });

    expect(result.modifiedFilesPerAttempt).toEqual([
      ['src/auth.ts', 'src/handler.ts'],
      ['src/auth.ts', 'src/handler.ts'],
    ]);
  });

  it('includes modifiedFilesPerAttempt even when tests pass on first attempt', async () => {
    vi.mocked(mockDiffRunner).mockResolvedValueOnce(['src/auth.ts']);
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      diffRunner: mockDiffRunner,
      testCommand: 'npm test',
    });

    expect(result.modifiedFilesPerAttempt).toEqual([['src/auth.ts']]);
  });

  it('returns thrashingSignal in result when all attempts fail', async () => {
    // Same files every time → SAME_FILES thrashing
    vi.mocked(mockDiffRunner)
      .mockResolvedValueOnce(['src/auth.ts'])
      .mockResolvedValueOnce(['src/auth.ts'])
      .mockResolvedValueOnce(['src/auth.ts']);

    vi.mocked(mockTestRunner).mockResolvedValue({ passed: false, output: 'fail', exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      diffRunner: mockDiffRunner,
      testCommand: 'npm test',
    });

    expect(result.thrashingSignal).toBe('SAME_FILES');
    expect(result.modifiedFilesPerAttempt).toHaveLength(3);
  });

  it('passes thrashing signal to classifyDiagnosis when all attempts fail', async () => {
    // Different files each time → DIFFERENT_FILES
    vi.mocked(mockDiffRunner)
      .mockResolvedValueOnce(['src/a.ts'])
      .mockResolvedValueOnce(['src/b.ts'])
      .mockResolvedValueOnce(['src/c.ts']);

    // Same test name → would normally be SPEC_WRONG, but DIFFERENT_FILES thrashing should bias to STUCK
    const sameTestFail = ' FAIL  src/auth.test.ts > AuthService > validates expired tokens\n   Error: fail';
    vi.mocked(mockTestRunner).mockResolvedValue({ passed: false, output: sameTestFail, exitCode: 1 });

    const result = await runTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {},
      testRunner: mockTestRunner,
      diffRunner: mockDiffRunner,
      testCommand: 'npm test',
    });

    expect(result.thrashingSignal).toBe('DIFFERENT_FILES');
    expect(result.diagnosis).toBe('STUCK');
  });
});

// --- classifyDiagnosis with thrashing signal ---

describe('classifyDiagnosis with thrashing signal', () => {
  it('existing behavior unchanged when no thrashing signal', () => {
    const attempt1 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    const attempt2 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    expect(classifyDiagnosis([attempt1, attempt2])).toBe('SPEC_WRONG');
    expect(classifyDiagnosis([attempt1, attempt2], undefined)).toBe('SPEC_WRONG');
  });

  it('SAME_FILES thrashing overrides SPEC_WRONG to APPROACH_WRONG', () => {
    // Same tests fail → normally SPEC_WRONG
    // But SAME_FILES thrashing = right files, wrong strategy → APPROACH_WRONG
    const attempt1 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    const attempt2 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    expect(classifyDiagnosis([attempt1, attempt2], 'SAME_FILES')).toBe('APPROACH_WRONG');
  });

  it('DIFFERENT_FILES thrashing overrides to STUCK', () => {
    // Different tests fail → normally APPROACH_WRONG
    // But DIFFERENT_FILES thrashing = searching randomly → STUCK
    const attempt1 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    const attempt2 = ' FAIL  src/b.test.ts > suite > test two\n   Error: fail';
    expect(classifyDiagnosis([attempt1, attempt2], 'DIFFERENT_FILES')).toBe('STUCK');
  });

  it('NORMAL thrashing does not change diagnosis', () => {
    const attempt1 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    const attempt2 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    expect(classifyDiagnosis([attempt1, attempt2], 'NORMAL')).toBe('SPEC_WRONG');
  });

  it('INSUFFICIENT_DATA thrashing does not change diagnosis', () => {
    const attempt1 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    const attempt2 = ' FAIL  src/a.test.ts > suite > test one\n   Error: fail';
    expect(classifyDiagnosis([attempt1, attempt2], 'INSUFFICIENT_DATA')).toBe('SPEC_WRONG');
  });

  it('MISSING_CONTEXT still takes priority over thrashing', () => {
    const attempt1 = "Cannot find module './service'\n FAIL  src/a.test.ts > test one\n   Error: fail";
    const attempt2 = "Cannot find module './service'\n FAIL  src/a.test.ts > test one\n   Error: fail";
    expect(classifyDiagnosis([attempt1, attempt2], 'SAME_FILES')).toBe('MISSING_CONTEXT');
  });
});

// --- Per-piece TI loop ---

function makePiece(index: number): SpecPiece {
  return {
    name: `piece-${index}`,
    description: `Description for piece ${index}`,
    files: [`src/piece-${index}.ts`],
    acceptance_criteria: [`AC ${index}-1`, `AC ${index}-2`],
    wiring: index > 0 ? [`Imports from piece-${index - 1}`] : [],
  };
}

describe('runPieceTILoop', () => {
  let mockTestRunner: TestRunner;

  beforeEach(() => {
    mockExecute.mockClear();
    mockTestRunner = vi.fn();
    mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValue(implWaveExecResult());
  });

  it('runs test and impl agents with piece-scoped context', async () => {
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runPieceTILoop({
      piece: makePiece(0),
      pieceIndex: 0,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(true);
    expect(result.pieceIndex).toBe(0);
    expect(result.cost).toBeGreaterThan(0);

    // Verify context is piece-scoped — contains piece name but NOT full spec fields
    const testCall = mockExecute.mock.calls.find((c) => c[0].wave === 'test');
    expect(testCall?.[0].userMessage).toContain('piece-0');
    expect(testCall?.[0].userMessage).toContain('ONLY modify these');
    expect(testCall?.[0].userMessage).toContain('AC 0-1');
  });

  it('retries impl per piece independently (max 3)', async () => {
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'FAIL: test 1', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'FAIL: test 2', exitCode: 1 })
      .mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runPieceTILoop({
      piece: makePiece(0),
      pieceIndex: 0,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(true);
    expect(result.attempts).toBe(3);
  });

  it('returns diagnosis when all retries exhausted', async () => {
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: ' FAIL  src/a.test.ts > test\n   Error: x', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: ' FAIL  src/a.test.ts > test\n   Error: y', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: ' FAIL  src/a.test.ts > test\n   Error: z', exitCode: 1 });

    const result = await runPieceTILoop({
      piece: makePiece(0),
      pieceIndex: 0,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(false);
    expect(result.diagnosis).toBeDefined();
  });

  it('includes piece index in result', async () => {
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const result = await runPieceTILoop({
      piece: makePiece(2),
      pieceIndex: 2,
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.pieceIndex).toBe(2);
  });
});

describe('runParallelPieceTILoop', () => {
  let mockTestRunner: TestRunner;

  beforeEach(() => {
    mockExecute.mockClear();
    mockTestRunner = vi.fn();
  });

  it('1 piece — backward compatible, delegates to runTILoop (no sub-worktrees)', async () => {
    mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValue(implWaveExecResult());
    vi.mocked(mockTestRunner).mockResolvedValueOnce({ passed: true, output: 'ok', exitCode: 0 });

    const specResult = {
      summary: 'single piece',
      pieces: [makePiece(0)],
      dependency_order: [[0]],
      constraints: [],
    };

    const result = await runParallelPieceTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {
        spec: { wave: 'spec', success: true, artifact: specResult, duration: 100, cost: 0.01, turns: 1 },
      },
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(true);
    expect(result.totalCost).toBeGreaterThan(0);
    // Single piece should not create sub-worktrees — verified by no sub-worktree calls
  });

  it('3 pieces — each gets own TI loop, results aggregated', async () => {
    // Each piece needs test + impl calls = 2 calls per piece, so 6 total
    for (let i = 0; i < 3; i++) {
      mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValueOnce(implWaveExecResult());
    }
    vi.mocked(mockTestRunner).mockResolvedValue({ passed: true, output: 'ok', exitCode: 0 });

    const specResult = {
      summary: 'three pieces',
      pieces: [makePiece(0), makePiece(1), makePiece(2)],
      dependency_order: [[0, 1, 2]],
      constraints: [],
    };

    const result = await runParallelPieceTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {
        spec: { wave: 'spec', success: true, artifact: specResult, duration: 100, cost: 0.01, turns: 1 },
      },
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(true);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.pieceResults).toHaveLength(3);
    expect(result.pieceResults.every((p) => p.testsPassing)).toBe(true);
  });

  it('5 pieces — respects max 3 concurrent', async () => {
    for (let i = 0; i < 5; i++) {
      mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValueOnce(implWaveExecResult());
    }
    vi.mocked(mockTestRunner).mockResolvedValue({ passed: true, output: 'ok', exitCode: 0 });

    const specResult = {
      summary: 'five pieces',
      pieces: [makePiece(0), makePiece(1), makePiece(2), makePiece(3), makePiece(4)],
      dependency_order: [[0, 1, 2, 3, 4]],
      constraints: [],
    };

    const result = await runParallelPieceTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {
        spec: { wave: 'spec', success: true, artifact: specResult, duration: 100, cost: 0.01, turns: 1 },
      },
      testRunner: mockTestRunner,
      testCommand: 'npm test',
      maxConcurrent: 3,
    });

    expect(result.testsPassing).toBe(true);
    expect(result.pieceResults).toHaveLength(5);
  });

  it('error in one piece does not kill others', async () => {
    // Piece 0: test + impl succeed, tests pass
    mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValueOnce(implWaveExecResult());
    // Piece 1: test + impl succeed, tests FAIL all 3 retries
    mockExecute.mockResolvedValueOnce(testWaveExecResult());
    for (let i = 0; i < 3; i++) {
      mockExecute.mockResolvedValueOnce(implWaveExecResult());
    }
    // Piece 2: test + impl succeed, tests pass
    mockExecute.mockResolvedValueOnce(testWaveExecResult()).mockResolvedValueOnce(implWaveExecResult());

    vi.mocked(mockTestRunner).mockImplementation(async (_cmd: string, workDir: string) => {
      // Piece 1 always fails (workDir contains piece-1)
      if (workDir.includes('piece-1')) {
        return { passed: false, output: 'FAIL: broken', exitCode: 1 };
      }
      return { passed: true, output: 'ok', exitCode: 0 };
    });

    const specResult = {
      summary: 'three pieces, one fails',
      pieces: [makePiece(0), makePiece(1), makePiece(2)],
      dependency_order: [[0, 1, 2]],
      constraints: [],
    };

    const result = await runParallelPieceTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {
        spec: { wave: 'spec', success: true, artifact: specResult, duration: 100, cost: 0.01, turns: 1 },
      },
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    expect(result.testsPassing).toBe(false);
    // Piece 0 and 2 passed, piece 1 failed
    expect(result.pieceResults.filter((p) => p.testsPassing)).toHaveLength(2);
    expect(result.pieceResults.filter((p) => !p.testsPassing)).toHaveLength(1);
  });

  it('cost tracked per piece and aggregated', async () => {
    // Use mockImplementation to avoid ordering issues with parallel Promise.all
    mockExecute.mockImplementation(async (config: { wave: string }) => {
      if (config.wave === 'test') return testWaveExecResult();
      return implWaveExecResult();
    });
    vi.mocked(mockTestRunner).mockResolvedValue({ passed: true, output: 'ok', exitCode: 0 });

    const specResult = {
      summary: 'two pieces',
      pieces: [makePiece(0), makePiece(1)],
      dependency_order: [[0, 1]],
      constraints: [],
    };

    const result = await runParallelPieceTILoop({
      issue: makeIssue(),
      workDir: '/tmp/test',
      repoConfig: makeConfig(),
      waveResults: {
        spec: { wave: 'spec', success: true, artifact: specResult, duration: 100, cost: 0.01, turns: 1 },
      },
      testRunner: mockTestRunner,
      testCommand: 'npm test',
    });

    // Each piece has test cost (0.05) + impl cost (0.1) = 0.15 per piece
    expect(result.pieceResults[0]?.cost).toBeCloseTo(0.15, 2);
    expect(result.pieceResults[1]?.cost).toBeCloseTo(0.15, 2);
    expect(result.totalCost).toBeCloseTo(0.3, 2);
  });
});
