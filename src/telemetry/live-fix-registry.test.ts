// LiveFixRegistry — in-memory map of fixId → live agent handle (issue #294).
//
// The registry is a process-singleton owned by fix.ts (or whoever drives a
// wave-executor). It holds ONLY the bits of an agent we need to expose to
// `kova send` / `kova kill`:
//   - steer(hint)  → routes to agent.steer({ role: 'user', content: hint })
//   - abort()      → routes to agent.abort()
// Each handle is keyed by fixId. Handles are unregistered when the wave ends,
// so steering/killing a completed fix returns a clear "not running" error.

import { describe, expect, it, vi } from 'vitest';
import { buildLiveHandleSink, createLiveFixRegistry, type LiveFixHandle } from './live-fix-registry.js';

function makeHandle(): LiveFixHandle & { steer: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn> } {
  return {
    steer: vi.fn(),
    abort: vi.fn(),
  };
}

describe('LiveFixRegistry', () => {
  it('register + get round-trips a handle by fixId', () => {
    const reg = createLiveFixRegistry();
    const h = makeHandle();
    reg.register('fix-42', h);
    expect(reg.get('fix-42')).toBe(h);
  });

  it('get returns undefined for an unknown fixId', () => {
    const reg = createLiveFixRegistry();
    expect(reg.get('nope')).toBeUndefined();
  });

  it('clear removes the handle so subsequent get returns undefined', () => {
    const reg = createLiveFixRegistry();
    reg.register('fix-1', makeHandle());
    reg.clear('fix-1');
    expect(reg.get('fix-1')).toBeUndefined();
  });

  it('register replaces the previous handle for the same fixId', () => {
    const reg = createLiveFixRegistry();
    const a = makeHandle();
    const b = makeHandle();
    reg.register('fix-1', a);
    reg.register('fix-1', b);
    expect(reg.get('fix-1')).toBe(b);
  });

  it('steer routes to the registered handle.steer', () => {
    const reg = createLiveFixRegistry();
    const h = makeHandle();
    reg.register('fix-1', h);
    reg.steer('fix-1', 'focus on the failing test');
    expect(h.steer).toHaveBeenCalledTimes(1);
    expect(h.steer).toHaveBeenCalledWith('focus on the failing test');
  });

  it('abort routes to the registered handle.abort', () => {
    const reg = createLiveFixRegistry();
    const h = makeHandle();
    reg.register('fix-1', h);
    reg.abort('fix-1');
    expect(h.abort).toHaveBeenCalledTimes(1);
  });

  it('steer throws a clear "not running" error for an unknown fixId', () => {
    const reg = createLiveFixRegistry();
    expect(() => reg.steer('nope', 'hi')).toThrowError(/not running/i);
  });

  it('abort throws a clear "not running" error for an unknown fixId', () => {
    const reg = createLiveFixRegistry();
    expect(() => reg.abort('nope')).toThrowError(/not running/i);
  });

  it('list returns all currently-registered fixIds', () => {
    const reg = createLiveFixRegistry();
    reg.register('fix-1', makeHandle());
    reg.register('fix-2', makeHandle());
    expect([...reg.list()].sort()).toEqual(['fix-1', 'fix-2']);
  });

  it('default registry is a shared module-level singleton', async () => {
    const { defaultLiveFixRegistry: a } = await import('./live-fix-registry.js');
    const { defaultLiveFixRegistry: b } = await import('./live-fix-registry.js');
    expect(a).toBe(b);
  });
});

describe('buildLiveHandleSink', () => {
  it('returns undefined when registry is missing', () => {
    const sink = buildLiveHandleSink({
      registry: undefined,
      fixId: 'x',
      sandboxActive: false,
      wave: 'impl',
    });
    expect(sink).toBeUndefined();
  });

  it('returns undefined when fixId is missing', () => {
    const reg = createLiveFixRegistry();
    const sink = buildLiveHandleSink({
      registry: reg,
      fixId: undefined,
      sandboxActive: false,
      wave: 'impl',
    });
    expect(sink).toBeUndefined();
  });

  it('returns undefined when sandbox is active', () => {
    const reg = createLiveFixRegistry();
    const sink = buildLiveHandleSink({
      registry: reg,
      fixId: 'fix-1',
      sandboxActive: true,
      wave: 'impl',
    });
    expect(sink).toBeUndefined();
  });

  it('registers the wrapped handle in the registry when invoked', () => {
    const reg = createLiveFixRegistry();
    const sink = buildLiveHandleSink({
      registry: reg,
      fixId: 'fix-1',
      sandboxActive: false,
      wave: 'impl',
    });
    expect(sink).toBeDefined();
    const handle: LiveFixHandle = { steer: vi.fn(), abort: vi.fn() };
    sink?.(handle);
    expect(reg.get('fix-1')).toBeDefined();
  });

  it('wrapped handle.steer routes to underlying steer + publishes a steered event with reason "manual_steer"', () => {
    const reg = createLiveFixRegistry();
    const publish = vi.fn();
    const sink = buildLiveHandleSink({
      registry: reg,
      fixId: 'fix-1',
      sandboxActive: false,
      eventBus: { publish },
      eventContext: { runId: 'r1', repoId: 'owner/repo' },
      wave: 'impl',
    });
    const inner: LiveFixHandle = { steer: vi.fn(), abort: vi.fn() };
    sink?.(inner);

    const wrapped = reg.get('fix-1');
    wrapped?.steer('go faster');

    expect(inner.steer).toHaveBeenCalledWith('go faster');
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]?.[0] as { type: string; fixId: string; wave: string; tier: string };
    expect(event.type).toBe('steered');
    expect(event.fixId).toBe('fix-1');
    expect(event.wave).toBe('impl');
    expect(event.tier).toBe('steer');
  });

  it('wrapped handle.abort routes to underlying abort + publishes aborted with reason "manual_abort"', () => {
    const reg = createLiveFixRegistry();
    const publish = vi.fn();
    const sink = buildLiveHandleSink({
      registry: reg,
      fixId: 'fix-1',
      sandboxActive: false,
      eventBus: { publish },
      eventContext: { runId: 'r1', repoId: 'owner/repo' },
      wave: 'impl',
    });
    const inner: LiveFixHandle = { steer: vi.fn(), abort: vi.fn() };
    sink?.(inner);

    const wrapped = reg.get('fix-1');
    wrapped?.abort();

    expect(inner.abort).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    const event = publish.mock.calls[0]?.[0] as { type: string; reason: string };
    expect(event.type).toBe('aborted');
    expect(event.reason).toBe('manual_abort');
  });

  it('eventBus publish failures do not break the wrap', () => {
    const reg = createLiveFixRegistry();
    const publish = vi.fn().mockImplementation(() => {
      throw new Error('bus down');
    });
    const sink = buildLiveHandleSink({
      registry: reg,
      fixId: 'fix-1',
      sandboxActive: false,
      eventBus: { publish },
      eventContext: { runId: 'r1', repoId: 'owner/repo' },
      wave: 'impl',
    });
    const inner: LiveFixHandle = { steer: vi.fn(), abort: vi.fn() };
    sink?.(inner);

    const wrapped = reg.get('fix-1');
    // Should not throw even though publish does
    expect(() => wrapped?.steer('x')).not.toThrow();
    expect(() => wrapped?.abort()).not.toThrow();
    expect(inner.steer).toHaveBeenCalledTimes(1);
    expect(inner.abort).toHaveBeenCalledTimes(1);
  });
});
