// Tests for structured output parse success rate metrics (issue #247).
//
// Covers:
//   - parseStructuredOutputWithMethod returns the parse method label
//   - Each parse path produces the correct label:
//       'json-tag' | 'json-tag-repaired'
//       'markdown-fence' | 'markdown-fence-repaired'
//       'direct-parse' | 'direct-parse-repaired'
//   - Failure returns method=undefined

import { describe, expect, it } from 'vitest';

describe('parseStructuredOutputWithMethod', () => {
  it('returns json-tag method for <json>...</json>', async () => {
    const { parseStructuredOutputWithMethod } = await import('./wave-executor.js');
    const result = parseStructuredOutputWithMethod('<json>{"grade": "A"}</json>');
    expect(result.value).toEqual({ grade: 'A' });
    expect(result.method).toBe('json-tag');
  });

  it('returns json-tag-repaired when <json> tags contain malformed JSON repaired successfully', async () => {
    const { parseStructuredOutputWithMethod } = await import('./wave-executor.js');
    const result = parseStructuredOutputWithMethod('<json>{"grade": "A",}</json>'); // trailing comma
    expect(result.value).toEqual({ grade: 'A' });
    expect(result.method).toBe('json-tag-repaired');
  });

  it('returns markdown-fence method for ```json ... ```', async () => {
    const { parseStructuredOutputWithMethod } = await import('./wave-executor.js');
    const result = parseStructuredOutputWithMethod('```json\n{"grade": "B"}\n```');
    expect(result.value).toEqual({ grade: 'B' });
    expect(result.method).toBe('markdown-fence');
  });

  it('returns markdown-fence-repaired when fence content is repaired', async () => {
    const { parseStructuredOutputWithMethod } = await import('./wave-executor.js');
    const result = parseStructuredOutputWithMethod("```json\n{'grade': 'B'}\n```"); // single quotes
    expect(result.value).toEqual({ grade: 'B' });
    expect(result.method).toBe('markdown-fence-repaired');
  });

  it('returns direct-parse method for bare JSON', async () => {
    const { parseStructuredOutputWithMethod } = await import('./wave-executor.js');
    const result = parseStructuredOutputWithMethod('{"grade": "C"}');
    expect(result.value).toEqual({ grade: 'C' });
    expect(result.method).toBe('direct-parse');
  });

  it('returns direct-parse-repaired when direct text needed repair', async () => {
    const { parseStructuredOutputWithMethod } = await import('./wave-executor.js');
    const result = parseStructuredOutputWithMethod('{grade: "C"}'); // unquoted key
    expect(result.value).toEqual({ grade: 'C' });
    expect(result.method).toBe('direct-parse-repaired');
  });

  it('returns method=undefined when no parse strategy succeeds', async () => {
    const { parseStructuredOutputWithMethod } = await import('./wave-executor.js');
    const result = parseStructuredOutputWithMethod('not json at all 🤖');
    expect(result.value).toBeUndefined();
    expect(result.method).toBeUndefined();
  });

  it('returns method=undefined for empty string', async () => {
    const { parseStructuredOutputWithMethod } = await import('./wave-executor.js');
    const result = parseStructuredOutputWithMethod('');
    expect(result.value).toBeUndefined();
    expect(result.method).toBeUndefined();
  });
});

describe('parseStructuredOutput backward compatibility', () => {
  it('still returns the parsed value (not a wrapped object)', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    expect(parseStructuredOutput('<json>{"grade": "A"}</json>')).toEqual({ grade: 'A' });
  });

  it('still returns undefined on failure', async () => {
    const { parseStructuredOutput } = await import('./wave-executor.js');
    expect(parseStructuredOutput('not json')).toBeUndefined();
  });
});
