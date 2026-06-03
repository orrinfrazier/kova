// Issue #317: shouldRetryWaveError must respect classified.retryable.
//
// Today executeWaveWithRetry bubbles every thrown KovaError immediately (skipping
// retries entirely — even for retryable ones like 429 rate limits) and retries
// every `success: false` return for maxRetries × backoff (even when permanent).
//
// The fix extracts the retry decision into a pure `shouldRetryWaveError(error)`
// helper. We unit-test the helper; the loop that calls it is trivial.

import { describe, expect, it } from 'vitest';
import { KovaError } from './errors.js';
import { shouldRetryWaveError } from './wave-executor.js';

describe('shouldRetryWaveError (#317)', () => {
  it('returns false for non-retryable KovaError (config/auth)', () => {
    const err = new KovaError('Auth failed', 'config', false, {
      status: 401,
      errorClass: 'authentication_error',
    });
    expect(shouldRetryWaveError(err)).toBe(false);
  });

  it('returns false for non-retryable KovaError (permanent billing)', () => {
    const err = new KovaError('Permanent billing failure', 'billing', false);
    expect(shouldRetryWaveError(err)).toBe(false);
  });

  it('returns true for retryable KovaError (rate limit)', () => {
    const err = new KovaError('Rate limited', 'billing', true, {
      status: 429,
      errorClass: 'rate_limit_error',
    });
    expect(shouldRetryWaveError(err)).toBe(true);
  });

  it('returns true for retryable KovaError (context/413)', () => {
    const err = new KovaError('Context too large', 'context', true, {
      status: 413,
      errorClass: 'request_too_large',
    });
    expect(shouldRetryWaveError(err)).toBe(true);
  });

  it('returns true for retryable KovaError (overloaded)', () => {
    const err = new KovaError('Overloaded', 'agent', true, {
      status: 529,
      errorClass: 'overloaded_error',
    });
    expect(shouldRetryWaveError(err)).toBe(true);
  });

  it('classifies raw Error and returns true for retryable patterns', () => {
    expect(shouldRetryWaveError(new Error('rate limit exceeded'))).toBe(true);
    expect(shouldRetryWaveError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('classifies raw Error and returns false for non-retryable patterns', () => {
    expect(shouldRetryWaveError(new Error('authentication failed'))).toBe(false);
    expect(shouldRetryWaveError(new Error('invalid api key'))).toBe(false);
  });

  it('returns false for unknown errors', () => {
    expect(shouldRetryWaveError(new Error('something went wrong'))).toBe(false);
    expect(shouldRetryWaveError('string error')).toBe(false);
  });

  it('classifies structured Anthropic-shape errors', () => {
    const err: Error & { status: number; error: { type: string } } = Object.assign(new Error('rate limited'), {
      status: 429,
      error: { type: 'rate_limit_error' },
    });
    expect(shouldRetryWaveError(err)).toBe(true);

    const authErr: Error & { status: number; error: { type: string } } = Object.assign(new Error('unauthorized'), {
      status: 401,
      error: { type: 'authentication_error' },
    });
    expect(shouldRetryWaveError(authErr)).toBe(false);
  });
});
