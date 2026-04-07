import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// We'll import the logger after resetting modules per test
let logModule: typeof import('./logger.js');

describe('structured logger', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    // Clear env vars that affect logger behavior
    delete process.env.KOVA_LOG_LEVEL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function loadLogger() {
    logModule = await import('./logger.js');
    return logModule;
  }

  describe('console output (human-readable)', () => {
    it('logs info messages with timestamp and level prefix', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log } = await loadLogger();

      log.info('hello world');

      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0]?.[0] as string;
      // Format: HH:mm:ss.SSS [INF] message
      expect(output).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} \[INF\] hello world$/);

      spy.mockRestore();
    });

    it('logs warn messages to console.warn', async () => {
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { log } = await loadLogger();

      log.warn('something happened');

      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toMatch(/\[WRN\] something happened/);

      spy.mockRestore();
    });

    it('logs error messages to console.error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { log } = await loadLogger();

      log.error('bad stuff');

      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toMatch(/\[ERR\] bad stuff/);

      spy.mockRestore();
    });

    it('suppresses debug messages at default info level', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log } = await loadLogger();

      log.debug('hidden');

      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });

    it('shows debug messages when level is debug', async () => {
      process.env.KOVA_LOG_LEVEL = 'debug';
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log } = await loadLogger();

      log.debug('visible');

      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toMatch(/\[DBG\] visible/);

      spy.mockRestore();
    });

    it('includes context fields in console output for child loggers', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log } = await loadLogger();

      const child = log.child({ wave: 'assess', issue: 42 });
      child.info('starting assessment');

      expect(spy).toHaveBeenCalledOnce();
      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toContain('[assess]');
      expect(output).toContain('#42');
      expect(output).toContain('starting assessment');

      spy.mockRestore();
    });
  });

  describe('child logger context propagation', () => {
    it('creates child with wave, issue, repo context', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log } = await loadLogger();

      const child = log.child({ wave: 'impl', issue: 99, repo: 'kova' });
      child.info('implementing');

      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toContain('[impl]');
      expect(output).toContain('#99');
      expect(output).toContain('implementing');

      spy.mockRestore();
    });

    it('child inherits parent context and merges new fields', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log } = await loadLogger();

      const parent = log.child({ repo: 'kova', issue: 10 });
      const child = parent.child({ wave: 'test' });
      child.info('testing');

      const output = spy.mock.calls[0]?.[0] as string;
      expect(output).toContain('[test]');
      expect(output).toContain('#10');

      spy.mockRestore();
    });

    it('child supports all log levels', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      process.env.KOVA_LOG_LEVEL = 'debug';
      const { log } = await loadLogger();

      const child = log.child({ wave: 'quality' });
      child.debug('dbg');
      child.info('inf');
      child.warn('wrn');
      child.error('err');

      expect(logSpy).toHaveBeenCalledTimes(2); // debug + info
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledOnce();

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    });
  });

  describe('JSON file logging', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `kova-logger-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes JSON lines to .kova/logs/{run-id}.jsonl', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log, initFileLogger, closeFileLogger } = await loadLogger();

      const runId = 'test-run-123';
      initFileLogger(tmpDir, runId);

      log.info('file log test');

      closeFileLogger();

      const logPath = join(tmpDir, '.kova', 'logs', `${runId}.jsonl`);
      expect(existsSync(logPath)).toBe(true);

      const content = readFileSync(logPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry).toMatchObject({
        level: 'info',
        message: 'file log test',
      });
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      vi.restoreAllMocks();
    });

    it('includes context fields in JSON output', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log, initFileLogger, closeFileLogger } = await loadLogger();

      const runId = 'ctx-run';
      initFileLogger(tmpDir, runId);

      const child = log.child({ wave: 'spec', issue: 7, repo: 'myrepo' });
      child.info('with context');

      closeFileLogger();

      const logPath = join(tmpDir, '.kova', 'logs', `${runId}.jsonl`);
      const content = readFileSync(logPath, 'utf-8').trim();
      const entry = JSON.parse(content);

      expect(entry).toMatchObject({
        level: 'info',
        wave: 'spec',
        issue: 7,
        message: 'with context',
      });

      vi.restoreAllMocks();
    });

    it('writes multiple entries as separate JSON lines', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { log, initFileLogger, closeFileLogger } = await loadLogger();

      initFileLogger(tmpDir, 'multi');

      log.info('first');
      log.info('second');
      log.warn('third');

      closeFileLogger();

      const logPath = join(tmpDir, '.kova', 'logs', 'multi.jsonl');
      const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(3);

      const entries = lines.map((l) => JSON.parse(l));
      expect(entries[0]?.message).toBe('first');
      expect(entries[1]?.message).toBe('second');
      expect(entries[2]?.message).toBe('third');
      expect(entries[2]?.level).toBe('warn');

      vi.restoreAllMocks();
    });

    it('does not write to file when file logger is not initialized', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log } = await loadLogger();

      // Should not throw
      log.info('no file');

      vi.restoreAllMocks();
    });

    it('JSON entries conform to expected schema', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log, initFileLogger, closeFileLogger } = await loadLogger();

      initFileLogger(tmpDir, 'schema-check');

      const child = log.child({ wave: 'review', issue: 42, repo: 'kova' });
      child.info('reviewing code');

      closeFileLogger();

      const logPath = join(tmpDir, '.kova', 'logs', 'schema-check.jsonl');
      const entry = JSON.parse(readFileSync(logPath, 'utf-8').trim());

      // Required fields per AC: timestamp, level, wave, issue, message, context
      expect(entry).toHaveProperty('timestamp');
      expect(entry).toHaveProperty('level');
      expect(entry).toHaveProperty('wave');
      expect(entry).toHaveProperty('issue');
      expect(entry).toHaveProperty('message');
      expect(typeof entry.timestamp).toBe('string');
      expect(typeof entry.level).toBe('string');
      expect(typeof entry.message).toBe('string');

      vi.restoreAllMocks();
    });
  });

  describe('setLevel', () => {
    it('changes the effective log level at runtime', async () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const { log, setLevel } = await loadLogger();

      log.debug('hidden');
      expect(spy).not.toHaveBeenCalled();

      setLevel('debug');
      log.debug('now visible');
      expect(spy).toHaveBeenCalledOnce();

      spy.mockRestore();
    });
  });
});
