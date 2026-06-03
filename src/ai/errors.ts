import type { RuntimeError } from './runtime-error.js';

/**
 * Optional structured-error fields for the {@link KovaError} constructor.
 *
 * Backward-compat note (#317): the prior signature was
 * `(message, type, retryable, context?)`. Keeping `context` here as a named
 * field preserves that contract while adding `status` and `errorClass` for
 * structured classification. The positional-4th-arg form
 * `new KovaError(msg, type, retryable, ctxOrOptions)` still type-checks; if
 * the caller passed a plain `Record<string, unknown>` (legacy context), we
 * accept it shape-compatibly.
 */
export interface KovaErrorOptions {
  /** HTTP status from upstream SDK / transport. Used by classifier. */
  status?: number;
  /**
   * Stable SDK-defined discriminator, e.g. `'rate_limit_error'`,
   * `'authentication_error'`. Used by classifier.
   */
  errorClass?: string;
  /** Arbitrary structured context for instrumentation. */
  context?: Record<string, unknown>;
}

export class KovaError extends Error {
  readonly type: 'billing' | 'config' | 'agent' | 'git' | 'validation' | 'context' | 'unknown';
  readonly retryable: boolean;
  readonly status?: number;
  readonly errorClass?: string;
  readonly context?: Record<string, unknown>;

  constructor(
    message: string,
    type: 'billing' | 'config' | 'agent' | 'git' | 'validation' | 'context' | 'unknown',
    retryable: boolean,
    optionsOrContext?: KovaErrorOptions | Record<string, unknown>,
  ) {
    super(message);
    this.name = 'KovaError';
    this.type = type;
    this.retryable = retryable;

    if (optionsOrContext != null) {
      // Discriminate: a {@link KovaErrorOptions} bag has at least one of the
      // known keys (`status`, `errorClass`, `context`). Anything else is
      // treated as a legacy positional `context` value for BC.
      if ('status' in optionsOrContext || 'errorClass' in optionsOrContext || 'context' in optionsOrContext) {
        const opts = optionsOrContext as KovaErrorOptions;
        if (opts.status !== undefined) this.status = opts.status;
        if (opts.errorClass !== undefined) this.errorClass = opts.errorClass;
        if (opts.context !== undefined) this.context = opts.context;
      } else {
        this.context = optionsOrContext as Record<string, unknown>;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Message-pattern fallback (only consulted when structured fields are absent)
// ---------------------------------------------------------------------------

const CONTEXT_PATTERNS = [
  /context.?length.?exceeded/i,
  /context.?window/i,
  /max.?context.?length/i,
  /prompt.?(?:is\s+)?too\s+long/i,
  // Issue #317: Anthropic SDK error_class wording
  /request[_\s-]?too[_\s-]?large/i,
];

/**
 * Retryable-and-billing-like patterns. The `/5\d{2}/` pattern from earlier
 * versions was UNANCHORED, which false-fired on cost substrings ("0512"),
 * durations ("523ms"), and token counts ("523000"). Now anchored with `\b`
 * word boundaries so only actual 5xx HTTP status codes match. Structured
 * `.status` checks still take precedence in {@link classifyError}.
 */
const RETRYABLE_PATTERNS = [
  /rate.?limit/i,
  /timeout/i,
  /\b429\b/,
  /\b5\d{2}\b/,
  /\bbilling\b/i,
  /spending.?cap/i,
  // Issue #317: Anthropic message families
  /credit\s+balance/i,
  /monthly\s+spending\s+limit/i,
];

const OVERLOAD_PATTERNS = [/overloaded[_\s-]?error/i, /\b529\b/];

const NON_RETRYABLE_PATTERNS = [
  /authentication/i,
  /permission.?denied/i,
  /permission[_\s-]?error/i,
  /invalid.?api/i,
  /\b401\b/,
  /\b403\b/,
];

export interface ErrorClassification {
  type: KovaError['type'];
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Structured classification (#317)
// ---------------------------------------------------------------------------

/**
 * Lift any caught error into a {@link RuntimeError}-like view. Reads
 * `.status` (Anthropic SDK convention) and `.error?.type` / `.errorClass`
 * fields when present.
 */
function toRuntimeView(error: unknown): RuntimeError {
  if (error == null || typeof error !== 'object') {
    return { message: String(error) };
  }

  const view: RuntimeError = {
    message: error instanceof Error ? error.message : String(error),
  };

  const obj = error as Record<string, unknown>;

  if (typeof obj.status === 'number') {
    view.status = obj.status;
  }

  if (typeof obj.errorClass === 'string') {
    view.errorClass = obj.errorClass;
  } else if (typeof obj.error === 'object' && obj.error != null) {
    const inner = obj.error as Record<string, unknown>;
    if (typeof inner.type === 'string') {
      view.errorClass = inner.type;
    }
  }

  return view;
}

/**
 * Classify from structured fields. Returns `undefined` when no structured
 * signal is present — caller falls through to message-pattern matching.
 */
function classifyStructured(view: RuntimeError): ErrorClassification | undefined {
  const { status, errorClass } = view;

  // Error-class discriminator first (stable SDK identifier).
  if (errorClass != null) {
    switch (errorClass) {
      case 'rate_limit_error':
        return { type: 'billing', retryable: true };
      case 'overloaded_error':
        return { type: 'agent', retryable: true };
      case 'request_too_large':
        return { type: 'context', retryable: true };
      case 'permission_error':
      case 'authentication_error':
        return { type: 'config', retryable: false };
      // Other named errors fall through to status-based classification.
    }
  }

  if (status != null) {
    if (status === 429) return { type: 'billing', retryable: true };
    if (status === 529) return { type: 'agent', retryable: true };
    if (status === 413) return { type: 'context', retryable: true };
    if (status === 401 || status === 403) return { type: 'config', retryable: false };
    if (status >= 500 && status < 600) return { type: 'billing', retryable: true };
    if (status >= 400 && status < 500) return { type: 'config', retryable: false };
  }

  return undefined;
}

/**
 * Classify an error into a KovaError type and retryability.
 *
 * Order of precedence (#317):
 *   1. KovaError pass-through (already classified)
 *   2. Structured fields (`.status`, `.error?.type`) — stable across wording
 *      changes; immune to /5xx/ false-fires
 *   3. Message-pattern regex fallback for plain Error / string inputs
 */
export function classifyError(error: unknown): ErrorClassification {
  if (error instanceof KovaError) {
    return { type: error.type, retryable: error.retryable };
  }

  const view = toRuntimeView(error);

  const structured = classifyStructured(view);
  if (structured != null) return structured;

  return classifyMessage(view.message);
}

function classifyMessage(message: string): ErrorClassification {
  for (const pattern of CONTEXT_PATTERNS) {
    if (pattern.test(message)) return { type: 'context', retryable: true };
  }

  for (const pattern of NON_RETRYABLE_PATTERNS) {
    if (pattern.test(message)) return { type: 'config', retryable: false };
  }

  for (const pattern of OVERLOAD_PATTERNS) {
    if (pattern.test(message)) return { type: 'agent', retryable: true };
  }

  for (const pattern of RETRYABLE_PATTERNS) {
    if (pattern.test(message)) return { type: 'billing', retryable: true };
  }

  return { type: 'unknown', retryable: false };
}

export function isRetryable(error: unknown): boolean {
  return classifyError(error).retryable;
}

export function isSpendingCapBehavior(turns: number, cost: number, resultText: string): boolean {
  if (turns > 2 || cost !== 0) return false;

  const patterns = [/spending.?cap/i, /spending.?limit/i, /budget.?exceeded/i, /credit.?balance/i];
  return patterns.some((p) => p.test(resultText));
}
