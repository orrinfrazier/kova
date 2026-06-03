/**
 * Structured runtime-error shape consumed by {@link classifyError} and the
 * per-runtime {@link RuntimeErrorAdapter} implementations.
 *
 * Issue #317: the prior `errors.ts` classifier ran regex over `error.message`
 * strings. That coupled kova to one vendor's wording, masked real bugs (the
 * unanchored `/5\d{2}/` pattern false-fired on cost substrings like
 * "$0.0512" and durations like "523ms"), and missed Anthropic-specific
 * classes entirely (`request_too_large`, `permission_error`, the credit
 * balance / monthly spending limit families).
 *
 * The structured shape decouples classification from wording. Anthropic SDK
 * errors carry stable `.status` (HTTP) and `.error?.type` discriminators;
 * pi-coding-agent emits `"STATUS errorClass: msg"`; claude-cli emits
 * stream-json `result.subtype: 'error_*'` events. Each runtime can adapt
 * its native shape into this normalized form, and {@link classifyError}
 * keys off the structured fields first, falling back to regex only when no
 * structured signal is available.
 */
export interface RuntimeError {
  /** HTTP status code if the error originated from a transport response. */
  status?: number;
  /**
   * Stable error-class discriminator, e.g. `'rate_limit_error'`,
   * `'overloaded_error'`, `'authentication_error'`, `'request_too_large'`,
   * `'permission_error'`. SDK-defined identifiers — wording-independent.
   */
  errorClass?: string;
  /** Human-readable message. May still be matched by regex as a last resort. */
  message: string;
  /** Optional underlying cause for chaining / instrumentation. */
  cause?: unknown;
}

/**
 * Adapter interface that runtime implementations (pi-coding-agent,
 * claude-cli, anthropic-sdk-direct, etc.) provide to lift their native
 * error shape into the normalized {@link RuntimeError}.
 *
 * Adapters MUST be total — every input produces some `RuntimeError`. When
 * status / errorClass are unknown, leave them unset and let downstream
 * fall back to message-regex classification.
 */
export interface RuntimeErrorAdapter {
  adapt(raw: unknown): RuntimeError;
}
