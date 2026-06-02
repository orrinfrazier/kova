// Unit tests for waveFallbackModel — fallback-disable behavior (issue #242).
// Verifies that `model.fallback: false` short-circuits all fallback logic
// (configured or local-tier default), while `undefined` / string values
// preserve the original behavior.

import { describe, expect, it } from 'vitest';
import { waveFallbackModel } from './fix.js';

const LOCAL_MODEL = 'ollama:qwen2.5-coder:32b';
const API_MODEL = 'claude-opus-4-6';

describe('waveFallbackModel — fallback disable (issue #242)', () => {
  it('returns undefined when configFallback is false, even for local models', () => {
    // Local model + fallback explicitly disabled → no API fallback
    expect(waveFallbackModel('large', LOCAL_MODEL, false)).toBeUndefined();
    expect(waveFallbackModel('medium', LOCAL_MODEL, false)).toBeUndefined();
    expect(waveFallbackModel('small', LOCAL_MODEL, false)).toBeUndefined();
  });

  it('returns undefined when configFallback is false with object wave config', () => {
    const objConfig = { provider: 'ollama', model: 'qwen2.5-coder:32b' };
    expect(waveFallbackModel(objConfig, LOCAL_MODEL, false)).toBeUndefined();
  });

  it('returns undefined when configFallback is false with bare local model string', () => {
    expect(waveFallbackModel(LOCAL_MODEL, LOCAL_MODEL, false)).toBeUndefined();
  });

  it('returns configured fallback when configFallback is a non-empty string', () => {
    expect(waveFallbackModel('large', LOCAL_MODEL, 'claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
  });

  it('returns undefined when configFallback equals primary model (avoid self-fallback)', () => {
    // The function's existing contract: only use configured fallback when different from primary
    // Without explicit override, an API primary with no configured fallback → undefined
    expect(waveFallbackModel('large', API_MODEL, API_MODEL)).toBeUndefined();
  });

  it('falls back to API tier default for local models when configFallback is undefined', () => {
    // Preserves original behavior: local model with no explicit config → API fallback
    const result = waveFallbackModel('large', LOCAL_MODEL, undefined);
    expect(result).toBeDefined();
    expect(typeof result).toBe('string');
  });

  it('returns undefined for API models when configFallback is undefined', () => {
    // API model without explicit fallback config → no fallback needed
    expect(waveFallbackModel('large', API_MODEL, undefined)).toBeUndefined();
  });
});
