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

  // -----------------------------------------------------------------------
  // Slow-consumer isolation (kova#295)
  //
  // Default `sync` dropPolicy preserves existing behavior — a slow synchronous
  // subscriber DOES block the publisher (back-compat). The new `queued`
  // policy gives a subscriber a bounded outbound queue with drop-oldest:
  // publish returns immediately, the subscriber drains async, and a slow
  // subscriber CANNOT slow down publish throughput or starve other
  // subscribers.
  // -----------------------------------------------------------------------

  it('queued subscriber receives events asynchronously', async () => {
    const bus = new EventBus();
    const seen: KovaEvent[] = [];
    bus.subscribe(
      (ev) => {
        seen.push(ev);
      },
      { dropPolicy: 'queued' },
    );
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'A' }));
    // Sync fan-out is bypassed under 'queued' — nothing delivered yet.
    expect(seen).toHaveLength(0);
    // Flush microtasks: queued subscribers drain on the next tick.
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('queued subscriber does not block publish throughput when it is slow', async () => {
    const bus = new EventBus();
    let slowCalls = 0;
    let fastCalls = 0;
    // Synchronous slow subscriber simulated by busy-loop. Without isolation,
    // 100 publishes × 5ms = 500ms+ on the publisher. With queued isolation,
    // publishers should return in <50ms.
    bus.subscribe(
      () => {
        slowCalls++;
        const until = performance.now() + 5;
        while (performance.now() < until) {
          /* deliberate spin to simulate slow handler */
        }
      },
      { dropPolicy: 'queued', queueCapacity: 1024 },
    );
    bus.subscribe(() => {
      fastCalls++;
    });
    const before = performance.now();
    for (let i = 0; i < 100; i++) {
      bus.publish(baseInput({ fixId: 'A' }));
    }
    const elapsed = performance.now() - before;
    // Fast (sync) subscriber must have seen all 100 immediately.
    expect(fastCalls).toBe(100);
    // Publisher must NOT have waited on the slow subscriber.
    expect(elapsed).toBeLessThan(50);
    // Drain the slow subscriber so the bus isn't left with pending work.
    while (slowCalls < 100) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(slowCalls).toBe(100);
  });

  it('queued subscriber drops oldest when its outbound queue overflows', async () => {
    const bus = new EventBus();
    const delivered: number[] = [];
    let dropped = 0;
    // Hold the subscriber so the queue fills.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    bus.subscribe(
      async (ev) => {
        if (delivered.length === 0) {
          await gate; // first call holds until we release
        }
        delivered.push(ev.seq);
      },
      {
        dropPolicy: 'queued',
        queueCapacity: 3,
        onDrop: () => {
          dropped++;
        },
      },
    );
    // Publish 6 events while the subscriber is stalled (queue holds 3).
    for (let i = 0; i < 6; i++) {
      bus.publish(baseInput({ fixId: 'A' }));
    }
    // Give the runtime a tick to dequeue the first event into the handler.
    await new Promise((resolve) => setImmediate(resolve));
    releaseGate();
    // Drain
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // Oldest were dropped — we should see fewer than 6 deliveries.
    expect(delivered.length).toBeLessThan(6);
    expect(dropped).toBeGreaterThan(0);
    // Ring-buffer state on the bus itself remains complete (the drop is per
    // subscriber, not on the global ring buffer).
    expect(bus.snapshot('A').map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('queued slow subscriber does not delay an unrelated synchronous subscriber', async () => {
    const bus = new EventBus();
    const fastSeen: number[] = [];
    bus.subscribe(
      () => {
        // Slow subscriber holds for a long time.
        const until = performance.now() + 20;
        while (performance.now() < until) {
          /* deliberate spin to simulate slow handler */
        }
      },
      { dropPolicy: 'queued', queueCapacity: 64 },
    );
    bus.subscribe((ev) => fastSeen.push(ev.seq));
    const before = performance.now();
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'A' }));
    const elapsed = performance.now() - before;
    expect(fastSeen).toEqual([0, 1, 2]);
    // Three publishes through three queued enqueues should complete in ms,
    // not in the ~60ms that 3 × 20ms slow handlers would take if we waited.
    expect(elapsed).toBeLessThan(20);
    // Cleanup — let the slow handler finish so vitest doesn't see lingering
    // unhandled microtasks.
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

  it('queued per-fix subscriber replays buffered events synchronously then queues live ones', async () => {
    const bus = new EventBus();
    bus.publish(baseInput({ fixId: 'A' }));
    bus.publish(baseInput({ fixId: 'A' }));
    const seen: number[] = [];
    bus.subscribeForFix(
      'A',
      (ev) => {
        seen.push(ev.seq);
      },
      { dropPolicy: 'queued' },
    );
    // Replay still synchronous (it's a snapshot, not a live event).
    expect(seen).toEqual([0, 1]);
    bus.publish(baseInput({ fixId: 'A' }));
    // Live event under 'queued' policy is deferred.
    expect(seen).toEqual([0, 1]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([0, 1, 2]);
  });

  it('default subscribe policy is sync (back-compat with existing callers)', () => {
    const bus = new EventBus();
    const seen: number[] = [];
    bus.subscribe((ev) => seen.push(ev.seq));
    bus.publish(baseInput({ fixId: 'A' }));
    // No await: sync fan-out delivers immediately.
    expect(seen).toEqual([0]);
  });
});
