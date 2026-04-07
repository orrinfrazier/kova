import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_PREFIX: Record<LogLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

let currentLevel: LogLevel | undefined;

function getLevel(): LogLevel {
  if (currentLevel) return currentLevel;
  const env = process.env.KOVA_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_ORDER) return env as LogLevel;
  return 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getLevel()];
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function isoTimestamp(): string {
  return new Date().toISOString();
}

/** Set the effective log level at runtime. */
export function setLevel(level: LogLevel): void {
  currentLevel = level;
}

// --- File logger state ---
let fileLogPath: string | undefined;

/** Initialize file logging — writes JSON lines to .kova/logs/{runId}.jsonl */
export function initFileLogger(baseDir: string, runId: string): void {
  const logsDir = join(baseDir, '.kova', 'logs');
  mkdirSync(logsDir, { recursive: true });
  fileLogPath = join(logsDir, `${runId}.jsonl`);
}

/** Close file logger. */
export function closeFileLogger(): void {
  fileLogPath = undefined;
}

function writeFileEntry(level: LogLevel, message: string, context?: LogContext): void {
  if (!fileLogPath) return;
  const entry: Record<string, unknown> = {
    timestamp: isoTimestamp(),
    level,
    message,
  };
  if (context?.wave) entry.wave = context.wave;
  if (context?.issue) entry.issue = context.issue;
  if (context?.repo) entry.repo = context.repo;
  appendFileSync(fileLogPath, `${JSON.stringify(entry)}\n`);
}

// --- Context ---

export interface LogContext {
  wave?: string;
  issue?: number;
  repo?: string;
}

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  child(context: LogContext): Logger;
}

function formatConsolePrefix(context?: LogContext): string {
  const parts: string[] = [];
  if (context?.wave) parts.push(`[${context.wave}]`);
  if (context?.issue) parts.push(`#${context.issue}`);
  return parts.length > 0 ? `${parts.join(' ')} ` : '';
}

function createLogger(context?: LogContext): Logger {
  const prefix = formatConsolePrefix(context);

  return {
    debug(msg: string): void {
      if (shouldLog('debug')) console.log(`${timestamp()} [${LEVEL_PREFIX.debug}] ${prefix}${msg}`);
      writeFileEntry('debug', msg, context);
    },
    info(msg: string): void {
      if (shouldLog('info')) console.log(`${timestamp()} [${LEVEL_PREFIX.info}] ${prefix}${msg}`);
      writeFileEntry('info', msg, context);
    },
    warn(msg: string): void {
      if (shouldLog('warn')) console.warn(`${timestamp()} [${LEVEL_PREFIX.warn}] ${prefix}${msg}`);
      writeFileEntry('warn', msg, context);
    },
    error(msg: string): void {
      if (shouldLog('error')) console.error(`${timestamp()} [${LEVEL_PREFIX.error}] ${prefix}${msg}`);
      writeFileEntry('error', msg, context);
    },
    child(childContext: LogContext): Logger {
      return createLogger({ ...context, ...childContext });
    },
  };
}

export const log: Logger = createLogger();
