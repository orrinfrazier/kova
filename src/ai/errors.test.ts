import { describe, expect, it } from 'vitest';
import { classifyError, isRetryable, isSpendingCapBehavior, KovaError } from './errors.js';

// Anthropic SDK error shape fixtures — mimic real SDK error objects without
// taking a direct dependency. Anthropic SDK errors carry `.status` (number)
// and `.error?.type` (string discriminator). `.message` wording is documented
// as may-change, so structured fields are the stable signal.
function anthropicError(
  status: number,
  errorClass: string,
  message: string,
): Error & {
  status: number;
  error: { type: string };
} {
  const err = new Error(message) as Error & { status: number; error: { type: string } };
  err.status = status;
  err.error = { type: errorClass };
  return err;
}

describe('isRetryable', () => {
  it('returns true for rate limit errors', () => {
    expect(isRetryable(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryable(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('returns true for billing/spending cap errors', () => {
    expect(isRetryable(new Error('billing issue detected'))).toBe(true);
    expect(isRetryable(new Error('spending cap reached'))).toBe(true);
  });

  it('returns true for server errors', () => {
    expect(isRetryable(new Error('500 Internal Server Error'))).toBe(true);
    expect(isRetryable(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns true for timeout errors', () => {
    expect(isRetryable(new Error('request timeout'))).toBe(true);
  });

  it('returns false for authentication errors', () => {
    expect(isRetryable(new Error('authentication failed'))).toBe(false);
    expect(isRetryable(new Error('invalid API key'))).toBe(false);
    expect(isRetryable(new Error('permission denied'))).toBe(false);
  });

  it('returns false for unknown errors', () => {
    expect(isRetryable(new Error('something went wrong'))).toBe(false);
    expect(isRetryable('string error')).toBe(false);
  });

  it('does NOT false-fire /5xx/ on embedded digits (#317)', () => {
    // Cost strings, durations, and token counts must not match the 5xx pattern.
    expect(isRetryable(new Error('Token usage cost $0.0512 exceeded budget'))).toBe(false);
    expect(isRetryable(new Error('wave duration 523ms'))).toBe(false);
    expect(isRetryable(new Error('523000 tokens consumed'))).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isRetryable('rate limit')).toBe(true);
    expect(isRetryable({ message: 'not an error' })).toBe(false);
  });

  it('returns true for context exhaustion errors', () => {
    expect(isRetryable(new Error('context length exceeded'))).toBe(true);
    expect(isRetryable(new Error('request exceeds context window'))).toBe(true);
    expect(isRetryable(new Error('max context length exceeded'))).toBe(true);
    expect(isRetryable(new Error('prompt is too long'))).toBe(true);
  });
});

describe('isSpendingCapBehavior', () => {
  it('detects spending cap when turns <= 2, cost = 0, and text matches', () => {
    expect(isSpendingCapBehavior(1, 0, 'spending cap reached')).toBe(true);
    expect(isSpendingCapBehavior(2, 0, 'spending limit exceeded')).toBe(true);
    expect(isSpendingCapBehavior(1, 0, 'budget exceeded')).toBe(true);
    expect(isSpendingCapBehavior(1, 0, 'credit balance insufficient')).toBe(true);
  });

  it('returns false when turns > 2', () => {
    expect(isSpendingCapBehavior(3, 0, 'spending cap reached')).toBe(false);
  });

  it('returns false when cost > 0', () => {
    expect(isSpendingCapBehavior(1, 0.01, 'spending cap reached')).toBe(false);
  });

  it('returns false when text does not match', () => {
    expect(isSpendingCapBehavior(1, 0, 'something else happened')).toBe(false);
  });
});

describe('classifyError', () => {
  it('classifies billing keywords', () => {
    const result = classifyError('billing issue: account suspended');
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies rate limit keywords', () => {
    const result = classifyError('rate limit exceeded, retry after 30s');
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies 429 status', () => {
    const result = classifyError('HTTP 429 Too Many Requests');
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies spending cap keywords', () => {
    const result = classifyError('spending cap reached for this workspace');
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies authentication keywords', () => {
    const result = classifyError('authentication failed: invalid token');
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies 401 status', () => {
    const result = classifyError('HTTP 401 Unauthorized');
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies invalid API key', () => {
    const result = classifyError('invalid api key provided');
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies permission denied', () => {
    const result = classifyError('permission denied for this resource');
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies server error codes', () => {
    const result = classifyError('HTTP 500 Internal Server Error');
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies unknown as non-retryable', () => {
    const result = classifyError('something unexpected happened');
    expect(result.type).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('classifies Error objects', () => {
    const result = classifyError(new Error('rate limit exceeded'));
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('preserves KovaError type', () => {
    const kova = new KovaError('git merge failed', 'git', false);
    const result = classifyError(kova);
    expect(result.type).toBe('git');
    expect(result.retryable).toBe(false);
  });

  it('classifies string values', () => {
    const result = classifyError('authentication error');
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies context length exceeded as context type', () => {
    const result = classifyError('context length exceeded: 210000 tokens > 200000 limit');
    expect(result.type).toBe('context');
    expect(result.retryable).toBe(true);
  });

  it('classifies context window errors as context type', () => {
    const result = classifyError('request exceeds context window');
    expect(result.type).toBe('context');
    expect(result.retryable).toBe(true);
  });

  it('classifies max context length errors as context type', () => {
    const result = classifyError('max context length exceeded for model claude-sonnet-4-6');
    expect(result.type).toBe('context');
    expect(result.retryable).toBe(true);
  });

  it('classifies prompt too long errors as context type', () => {
    const result = classifyError('prompt is too long: 250000 tokens');
    expect(result.type).toBe('context');
    expect(result.retryable).toBe(true);
  });

  it('classifies context exhaustion KovaError pass-through', () => {
    const kova = new KovaError('Context exhausted during impl', 'context', true);
    const result = classifyError(kova);
    expect(result.type).toBe('context');
    expect(result.retryable).toBe(true);
  });
});

// --- Issue #317: structured error adapter ---
describe('classifyError — structured Anthropic SDK errors', () => {
  it('classifies 429 rate_limit_error from status/errorClass first', () => {
    const err = anthropicError(429, 'rate_limit_error', 'Rate limit exceeded');
    const result = classifyError(err);
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies 529 overloaded_error as agent/retryable', () => {
    const err = anthropicError(529, 'overloaded_error', 'Overloaded');
    const result = classifyError(err);
    expect(result.type).toBe('agent');
    expect(result.retryable).toBe(true);
  });

  it('classifies 413 request_too_large as context/retryable', () => {
    const err = anthropicError(413, 'request_too_large', 'Request too large');
    const result = classifyError(err);
    expect(result.type).toBe('context');
    expect(result.retryable).toBe(true);
  });

  it('classifies 403 permission_error as config/non-retryable', () => {
    const err = anthropicError(403, 'permission_error', 'Forbidden');
    const result = classifyError(err);
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies 401 authentication_error as config/non-retryable', () => {
    const err = anthropicError(401, 'authentication_error', 'Unauthorized');
    const result = classifyError(err);
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies 500 status as billing/retryable (true 5xx)', () => {
    const err = anthropicError(500, 'api_error', 'Internal server error');
    const result = classifyError(err);
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies 503 status as billing/retryable', () => {
    const err = anthropicError(503, 'api_error', 'Service unavailable');
    const result = classifyError(err);
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies 404 status as config/non-retryable (other 4xx)', () => {
    const err = anthropicError(404, 'not_found_error', 'Not found');
    const result = classifyError(err);
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies 400 status as config/non-retryable', () => {
    const err = anthropicError(400, 'invalid_request_error', 'Bad request');
    const result = classifyError(err);
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('prefers structured fields over message wording', () => {
    // Message says "rate limit" but structured says 401 auth — structured wins.
    const err = anthropicError(401, 'authentication_error', 'rate limit error');
    const result = classifyError(err);
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });
});

describe('classifyError — Anthropic message wording fallback (#317)', () => {
  it('classifies "Your credit balance is too low" as billing', () => {
    const result = classifyError(new Error('Your credit balance is too low to access the Anthropic API.'));
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies "monthly spending limit" as billing', () => {
    const result = classifyError(new Error('You have reached your monthly spending limit.'));
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });

  it('classifies "request_too_large" string as context', () => {
    const result = classifyError(new Error('request_too_large: prompt exceeds 200k tokens'));
    expect(result.type).toBe('context');
    expect(result.retryable).toBe(true);
  });

  it('classifies "permission_error" string as config', () => {
    const result = classifyError(new Error('permission_error: you cannot access this resource'));
    expect(result.type).toBe('config');
    expect(result.retryable).toBe(false);
  });

  it('classifies "overloaded_error" string as agent/retryable', () => {
    const result = classifyError(new Error('overloaded_error: API capacity exceeded'));
    expect(result.type).toBe('agent');
    expect(result.retryable).toBe(true);
  });

  it('classifies "529" status string as agent/retryable', () => {
    const result = classifyError(new Error('HTTP 529 Overloaded'));
    expect(result.type).toBe('agent');
    expect(result.retryable).toBe(true);
  });
});

describe('classifyError — false-fire regression for /5xx/ (#317)', () => {
  it('does NOT classify cost-substring "0512" as billing', () => {
    const result = classifyError(new Error('Token usage cost $0.0512 exceeded budget'));
    expect(result.type).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('does NOT classify duration-substring "523ms" as billing', () => {
    const result = classifyError(new Error('wave duration 523ms'));
    expect(result.type).toBe('unknown');
    expect(result.retryable).toBe(false);
  });

  it('does NOT classify token-count "523000" as billing', () => {
    const result = classifyError(new Error('523000 tokens consumed'));
    expect(result.type).toBe('unknown');
    expect(result.retryable).toBe(false);
  });
});

describe('KovaError — structured fields (#317)', () => {
  it('supports legacy positional constructor (message, type, retryable)', () => {
    const err = new KovaError('legacy', 'agent', false);
    expect(err.message).toBe('legacy');
    expect(err.type).toBe('agent');
    expect(err.retryable).toBe(false);
    expect(err.status).toBeUndefined();
    expect(err.errorClass).toBeUndefined();
  });

  it('supports options bag with status + errorClass', () => {
    const err = new KovaError('rate limited', 'billing', true, {
      status: 429,
      errorClass: 'rate_limit_error',
    });
    expect(err.status).toBe(429);
    expect(err.errorClass).toBe('rate_limit_error');
  });

  it('supports options bag with context', () => {
    const err = new KovaError('ctx', 'context', true, { context: { wave: 'spec' } });
    expect(err.context).toEqual({ wave: 'spec' });
  });

  it('round-trips KovaError through classifyError preserving type', () => {
    const original = new KovaError('rate limited', 'billing', true, {
      status: 429,
      errorClass: 'rate_limit_error',
    });
    const result = classifyError(original);
    expect(result.type).toBe('billing');
    expect(result.retryable).toBe(true);
  });
});
