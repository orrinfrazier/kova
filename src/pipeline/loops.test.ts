import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Issue, RepoConfig, WaveName, WaveResult } from '../types/index.js';

// Mock the AI layer — no real Agent SDK calls in tests
vi.mock('../ai/index.js', () => ({
  executeWaveWithRetry: vi.fn(),
}));

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

const { runTILoop, resolveTestCommand } = await import('./loops.js');
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
    model: { assess: 'large', spec: 'large', test: 'medium', impl: 'medium', quality: 'small', review: 'large' },
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
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: 'error-1', exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: 'error-2', exitCode: 1 })
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

    // Third impl should only have the LAST failure, not accumulated history
    const thirdImplMsg = implCalls.at(2)?.[0].userMessage;
    expect(thirdImplMsg).toContain('error-2');
    // Should not contain the first error (fresh context, only most recent failure)
    expect(thirdImplMsg).not.toContain('error-1');
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

  it('returns SPEC_WRONG diagnosis when all failures have similar output', async () => {
    const sameError = 'FAIL: expected true, got false\n  at token.test.ts:10';
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({ passed: false, output: sameError, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: sameError, exitCode: 1 })
      .mockResolvedValueOnce({ passed: false, output: sameError, exitCode: 1 });

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

  it('returns APPROACH_WRONG diagnosis when failures differ across attempts', async () => {
    vi.mocked(mockTestRunner)
      .mockResolvedValueOnce({
        passed: false,
        output: 'FAIL: TypeError: cannot read undefined\n  at auth.ts:5',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        passed: false,
        output: 'FAIL: RangeError: maximum call stack exceeded\n  at parser.ts:99',
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        passed: false,
        output: 'FAIL: SyntaxError: unexpected token\n  at config.ts:1',
        exitCode: 1,
      });

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
