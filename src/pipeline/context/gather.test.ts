import { describe, expect, it } from 'vitest';
import { gatherContext } from './gather.js';
import { makeCtx } from './test-helpers.js';
import type { ContextProvider } from './types.js';

describe('gatherContext', () => {
  it('returns empty record when given no providers', async () => {
    const out = await gatherContext([], makeCtx());
    expect(out).toEqual({});
  });

  it("keys single-string results by the provider's name", async () => {
    const provider: ContextProvider = {
      name: 'foo',
      resolve: async () => 'foo-value',
    };
    const out = await gatherContext([provider], makeCtx());
    expect(out).toEqual({ foo: 'foo-value' });
  });

  it('flattens multi-key outputs into the merged record', async () => {
    const provider: ContextProvider = {
      name: 'episodic',
      resolve: async () => ({ episodicContext: 'a', failedEpisodicContext: 'b' }),
    };
    const out = await gatherContext([provider], makeCtx());
    expect(out).toEqual({ episodicContext: 'a', failedEpisodicContext: 'b' });
  });

  it('drops undefined and empty-string entries', async () => {
    const providers: ContextProvider[] = [
      { name: 'empty', resolve: async () => undefined },
      { name: 'blank', resolve: async () => '' },
      { name: 'multi', resolve: async () => ({ keep: 'x', drop: undefined, blank: '' }) },
    ];
    const out = await gatherContext(providers, makeCtx());
    expect(out).toEqual({ keep: 'x' });
  });

  it('swallows thrown provider errors and continues', async () => {
    const warnings: string[] = [];
    const ctx = makeCtx({ logger: { info: () => {}, warn: (m) => warnings.push(m) } });
    const providers: ContextProvider[] = [
      { name: 'good', resolve: async () => 'good-value' },
      {
        name: 'bad',
        resolve: async () => {
          throw new Error('boom');
        },
      },
    ];
    const out = await gatherContext(providers, ctx);
    expect(out).toEqual({ good: 'good-value' });
    expect(warnings.some((w) => w.includes('context:bad') && w.includes('boom'))).toBe(true);
  });

  it('runs providers in parallel', async () => {
    let resolved = 0;
    const provider = (name: string, delay: number): ContextProvider => ({
      name,
      resolve: () =>
        new Promise((r) =>
          setTimeout(() => {
            resolved += 1;
            r(name);
          }, delay),
        ),
    });
    const t0 = Date.now();
    const out = await gatherContext([provider('a', 25), provider('b', 25), provider('c', 25)], makeCtx());
    const elapsed = Date.now() - t0;
    expect(resolved).toBe(3);
    expect(out).toEqual({ a: 'a', b: 'b', c: 'c' });
    // Sequential would be ~75ms; parallel is ~25ms. Use a generous bound to
    // avoid CI flakiness while still proving parallelism.
    expect(elapsed).toBeLessThan(70);
  });
});
