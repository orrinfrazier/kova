import { describe, expect, it } from 'vitest';
import { classifyError, isRetryable, isSpendingCapBehavior, KovaError } from './errors.js';

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

  it('handles non-Error values', () => {
    expect(isRetryable('rate limit')).toBe(true);
    expect(isRetryable({ message: 'not an error' })).toBe(false);
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
});
