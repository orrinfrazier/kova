type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function getLevel(): LogLevel {
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

export const log = {
  debug(msg: string): void {
    if (shouldLog('debug')) console.log(`${timestamp()} [DBG] ${msg}`);
  },
  info(msg: string): void {
    if (shouldLog('info')) console.log(`${timestamp()} [INF] ${msg}`);
  },
  warn(msg: string): void {
    if (shouldLog('warn')) console.warn(`${timestamp()} [WRN] ${msg}`);
  },
  error(msg: string): void {
    if (shouldLog('error')) console.error(`${timestamp()} [ERR] ${msg}`);
  },
};
