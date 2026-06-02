import { describe, expect, it } from 'vitest';
import { EventBus } from './bus.js';
import type { KovaEvent, KovaEventInput } from './schema.js';

function baseInput(overrides: { fixId?: string } = {}): KovaEventInput {
  return {
    runId: 'run-1',
    repoId: 'orrinfrazier/kova',
    fixId: overrides.fixId ?? 'fix-292',
    type: 'wave-enter',
    wave: 'assess',
  };
}

describe('EventBus', () => {
  it('assigns monotonic seq per fixId on publish', () => {
    const bus = new EventBus();
    const a = bus.publish(baseInput({ fixId: 'A' }));
    const b = bus.publish(baseInput({ fixId: 'A' }));
    const c = bus.publish(baseInput({ fixId: 'B' }));
    const d = bus.publish(baseInput({ fixId: 'A' }));
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(c.seq).toBe(0); // separate stream
    expect(d.seq).toBe(2);
  });

  it('stamps timestamp on publish', () => {
    const bus = new EventBus();
    const e = bus.publish(baseInput());
    expect(typeof e.timestamp).toBe('string');
    expect(Number.isNaN(Date.parse(e.timestamp))).toBe(false);
  });

  it('delivers live events FIFO to subscribers', () => {
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe((ev) => seen.push(ev));
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'B' }));
    expect(seen.map((e) => `${e.fixId}:${e.seq}`)).toEqual(['A:0', 'A:1', 'B:0']);
  });

  it('unsubscribe stops delivery', () => {
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    const unsub = bus.subscribe((ev) => seen.push(ev));
    bus.publish(baseInput());
    unsub();
    bus.publish(baseInput());
    expect(seen).toHaveLength(1);
  });

  it('subscribeForFix replays buffered events then live', () => {
    const bus = new EventBus({ bufferCapacity: 1000 });
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'B' })); // unrelated
    bus.publish(baseInput({ fixId: 'A' }));

    const seen: KovaEvent[] = [];
    const unsub = bus.subscribeForFix('A', (ev) => seen.push(ev));

    // Replay should fire synchronously before subscribe returns
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);

    // Now live event for A
    bus.publish(baseInput({ fixId: 'A' }));
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2]);

    // Unrelated fix not delivered
    bus.publish(baseInput({ fixId: 'B' }));
    expect(seen.map((e) => e.seq)).toEqual([0, 1, 2]);

    unsub();
  });

  it('subscribeForFix preserves per-fix ordering when fixes interleave', () => {
    const bus = new EventBus();
    const a: KovaEvent[] = [];
    const b: KovaEvent[] = [];
    bus.subscribeForFix('A', (ev) => a.push(ev));
    bus.subscribeForFix('B', (ev) => b.push(ev));

    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'B' }));
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'B' }));
    bus.publish(baseInput({ fixId: 'A' }));

    expect(a.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(b.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('ring buffer evicts oldest events past capacity', () => {
    const bus = new EventBus({ bufferCapacity: 3 });
    for (let i = 0; i < 5; i++) {
      bus.publish(baseInput({ fixId: 'A' }));
    }

    const seen: KovaEvent[] = [];
    bus.subscribeForFix('A', (ev) => seen.push(ev));

    // Only the last 3 events (seq 2, 3, 4) should be in the buffer
    expect(seen.map((e) => e.seq)).toEqual([2, 3, 4]);
  });

  it('does not block publishers on slow subscribers (sync fan-out)', () => {
    const bus = new EventBus();
    let calls = 0;
    bus.subscribe(() => {
      calls++;
    });
    const before = performance.now();
    for (let i = 0; i < 100; i++) {
      bus.publish(baseInput());
    }
    const elapsed = performance.now() - before;
    expect(calls).toBe(100);
    expect(elapsed).toBeLessThan(100); // sanity bound
  });

  it('subscriber errors do not break other subscribers or publishers', () => {
    const bus = new EventBus();
    const good: KovaEvent[] = [];
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe((ev) => good.push(ev));
    // Should not throw
    expect(() => bus.publish(baseInput())).not.toThrow();
    expect(good).toHaveLength(1);
  });

  it('global subscribe sees events from all fixes in FIFO publish order', () => {
    const bus = new EventBus();
    const all: string[] = [];
    bus.subscribe((ev) => all.push(`${ev.fixId}:${ev.seq}`));
    bus.publish(baseInput({ fixId: 'X' }));
    bus.publish(baseInput({ fixId: 'Y' }));
    bus.publish(baseInput({ fixId: 'X' }));
    bus.publish(baseInput({ fixId: 'Y' }));
    expect(all).toEqual(['X:0', 'Y:0', 'X:1', 'Y:1']);
  });

  it('emits Zod-valid events (round-trip through schema)', async () => {
    const { KovaEventSchema } = await import('./schema.js');
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe((ev) => seen.push(ev));
    bus.publish({
      runId: 'r',
      repoId: 'o/r',
      fixId: 'F',
      type: 'wave-enter',
      wave: 'impl',
    });
    expect(() => KovaEventSchema.parse(seen[0])).not.toThrow();
  });

  it('clearFix drops the ring buffer for a single fixId', () => {
    const bus = new EventBus();
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'A' }));
    bus.clearFix('A');
    const seen: KovaEvent[] = [];
    bus.subscribeForFix('A', (ev) => seen.push(ev));
    expect(seen).toEqual([]);
  });
});
