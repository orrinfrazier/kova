export class KovaError extends Error {
  constructor(
    message: string,
    readonly type: 'billing' | 'config' | 'agent' | 'git' | 'validation' | 'context' | 'unknown',
    readonly retryable: boolean,
    readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KovaError';
  }
}

const CONTEXT_PATTERNS = [
  /context.?length.?exceeded/i,
  /context.?window/i,
  /max.?context.?length/i,
  /prompt.?(?:is\s+)?too\s+long/i,
];

const RETRYABLE_PATTERNS = [/rate.?limit/i, /timeout/i, /429/, /5\d{2}/, /billing/i, /spending.?cap/i];

const NON_RETRYABLE_PATTERNS = [/authentication/i, /permission.?denied/i, /invalid.?api/i, /401/];

export interface ErrorClassification {
  type: KovaError['type'];
  retryable: boolean;
}

/**
 * Classify an error into a KovaError type and retryability.
 * Handles: KovaError (pass-through), Error, string, or pi-mono errorMessage strings.
 */
export function classifyError(error: unknown): ErrorClassification {
  if (error instanceof KovaError) {
    return { type: error.type, retryable: error.retryable };
  }

  const message = error instanceof Error ? error.message : String(error);

  for (const pattern of CONTEXT_PATTERNS) {
    if (pattern.test(message)) return { type: 'context', retryable: true };
  }

  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(message)) return { type: 'config', retryable: false };
  }

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(message)) return { type: 'billing', retryable: true };
  }

  return { type: 'unknown', retryable: false };
}

export function isRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);

  for (const pattern of CONTEXT_PATTERNS) {
    if (pattern.test(message)) return true;
  }

  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(message)) return false;
  }

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(message)) return true;
  }

  return false;
}

export function isSpendingCapBehavior(turns: number, cost: number, resultText: string): boolean {
  if (turns > 2 || cost !== 0) return false;

  const patterns = [/spending.?cap/i, /spending.?limit/i, /budget.?exceeded/i, /credit.?balance/i];
  return patterns.some((p) => p.test(resultText));
}
