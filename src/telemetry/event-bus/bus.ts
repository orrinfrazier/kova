// EventBus — in-process pub/sub for KovaEvents with per-fix ring buffers.
//
// Inspired by tmux control-mode (control.c, control-notify.c): emit structured
// events that an external client can subscribe to live OR replay from a bounded
// buffer when attaching mid-run.
//
// Two subscriber policies (kova#295):
//   - 'sync'   (default, back-compat): synchronous fan-out — listener runs on
//              the publisher's stack. A slow synchronous listener WILL block
//              the publisher. Use for internal fast listeners (logging, in-
//              process bridging) where the listener is known to be O(1).
//   - 'queued': listener has a bounded outbound queue (drop-oldest). publish()
//              enqueues + schedules a microtask drain; never awaits, never
//              blocks. A stalled or slow listener cannot delay the publisher
//              or starve other subscribers. Use for external/network clients
//              (SSE writers, attached CLI clients).
//
// Per-fix ordering invariant: seq numbers are monotonically increasing per
// fixId, starting at 0. Cross-fix order is publish-order (FIFO) but does not
// constrain per-fix seq.

import { log } from '../../utils/logger.js';
import type { KovaEvent, KovaEventInput } from './schema.js';

export type EventListener = (event: KovaEvent) => void;
export type Unsubscribe = () => void;

export interface EventBusOptions {
  /** Per-fix ring buffer capacity. Default 1000. */
  bufferCapacity?: number;
  /**
   * Override for the clock used to stamp `timestamp`. Tests can inject a
   * deterministic clock. Defaults to `Date.now`.
   */
  now?: () => number;
}

/**
 * Per-subscriber options that govern how a listener is invoked during fan-out.
 * Default policy is 'sync' for back-compat with existing internal callers.
 */
export interface SubscribeOptions {
  /**
   * 'sync' (default) — synchronous fan-out on the publisher's stack.
   * 'queued'         — bounded outbound queue with drop-oldest, drained on a
   *                    microtask. Publisher returns immediately.
   */
  dropPolicy?: 'sync' | 'queued';
  /** Outbound queue capacity for 'queued' policy. Default 256. */
  queueCapacity?: number;
  /**
   * Called when an event is dropped from this subscriber's queue because the
   * backlog is at capacity. Receives the dropped event so callers can keep a
   * counter, log a warning, or surface a "scrollback gap" marker upstream.
   */
  onDrop?: (event: KovaEvent) => void;
}

interface PerFixState {
  /** Next seq to assign for this fixId. */
  nextSeq: number;
  /** Ring buffer of recent events for replay. */
  buffer: KovaEvent[];
}

interface QueuedSubscriber {
  listener: EventListener;
  capacity: number;
  queue: KovaEvent[];
  draining: boolean;
  /** undefined when caller did not supply onDrop; matches exactOptionalPropertyTypes shape. */
  onDrop: ((event: KovaEvent) => void) | undefined;
}

const DEFAULT_BUFFER_CAPACITY = 1000;
const DEFAULT_QUEUE_CAPACITY = 256;

export class EventBus {
  private readonly bufferCapacity: number;
  private readonly now: () => number;
  private readonly perFix = new Map<string, PerFixState>();
  private readonly globalListeners = new Set<EventListener>();
  private readonly fixListeners = new Map<string, Set<EventListener>>();
  // Queued (drop-oldest, async drain) subscribers — isolated from the sync
  // fan-out path. Each entry carries its own bounded outbound queue.
  private readonly queuedGlobal = new Set<QueuedSubscriber>();
  private readonly queuedPerFix = new Map<string, Set<QueuedSubscriber>>();

  constructor(options: EventBusOptions = {}) {
    this.bufferCapacity = options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY;
    this.now = options.now ?? Date.now;
  }

  /**
   * Publish an event. Bus stamps `seq` (monotonic per fixId) and `timestamp`.
   * Returns the stamped event so callers can use the assigned seq if needed.
   */
  publish(input: KovaEventInput): KovaEvent {
    const state = this.getOrCreateFixState(input.fixId);
    const seq = state.nextSeq;
    state.nextSeq += 1;
    const event = {
      ...input,
      seq,
      timestamp: new Date(this.now()).toISOString(),
    } as KovaEvent;

    // Append to ring buffer, evicting oldest if at capacity.
    state.buffer.push(event);
    if (state.buffer.length > this.bufferCapacity) {
      state.buffer.shift();
    }

    // Synchronous fan-out — fast, in-process listeners only.
    for (const listener of this.globalListeners) {
      this.safeDeliver(listener, event);
    }
    const fixSet = this.fixListeners.get(input.fixId);
    if (fixSet) {
      for (const listener of fixSet) {
        this.safeDeliver(listener, event);
      }
    }

    // Queued (isolated) fan-out — enqueue + schedule a drain. Publisher path
    // is O(subscribers) push, never awaits a slow listener.
    for (const sub of this.queuedGlobal) {
      this.enqueueForSubscriber(sub, event);
    }
    const queuedFix = this.queuedPerFix.get(input.fixId);
    if (queuedFix) {
      for (const sub of queuedFix) {
        this.enqueueForSubscriber(sub, event);
      }
    }
    return event;
  }

  /**
   * Subscribe to every event published to the bus. Live-only (no replay).
   * Returns an unsubscribe function.
   *
   * When `options.dropPolicy === 'queued'`, the subscriber gets a bounded
   * outbound queue with drop-oldest semantics so it CANNOT block the
   * publisher. Default policy is 'sync' for back-compat.
   */
  subscribe(listener: EventListener, options: SubscribeOptions = {}): Unsubscribe {
    if (options.dropPolicy !== 'queued') {
      this.globalListeners.add(listener);
      return () => {
        this.globalListeners.delete(listener);
      };
    }
    const sub: QueuedSubscriber = {
      listener,
      capacity: options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY,
      queue: [],
      draining: false,
      onDrop: options.onDrop,
    };
    this.queuedGlobal.add(sub);
    return () => {
      this.queuedGlobal.delete(sub);
    };
  }

  /**
   * Subscribe to events for a specific fixId. Replays any buffered events
   * synchronously before returning, then forwards subsequent live events for
   * that fix.
   *
   * Under `dropPolicy: 'queued'` the *replay* is still synchronous — it's a
   * snapshot, not a live event. Only the live-event path uses the bounded
   * outbound queue.
   */
  subscribeForFix(fixId: string, listener: EventListener, options: SubscribeOptions = {}): Unsubscribe {
    // Replay buffered events synchronously regardless of policy — the snapshot
    // is a finite known-size list; nothing to "drop" against.
    const state = this.perFix.get(fixId);
    if (state) {
      for (const ev of state.buffer.slice()) {
        this.safeDeliver(listener, ev);
      }
    }

    if (options.dropPolicy !== 'queued') {
      let set = this.fixListeners.get(fixId);
      if (!set) {
        set = new Set();
        this.fixListeners.set(fixId, set);
      }
      set.add(listener);
      return () => {
        const current = this.fixListeners.get(fixId);
        if (!current) return;
        current.delete(listener);
        if (current.size === 0) {
          this.fixListeners.delete(fixId);
        }
      };
    }

    const sub: QueuedSubscriber = {
      listener,
      capacity: options.queueCapacity ?? DEFAULT_QUEUE_CAPACITY,
      queue: [],
      draining: false,
      onDrop: options.onDrop,
    };
    let qset = this.queuedPerFix.get(fixId);
    if (!qset) {
      qset = new Set();
      this.queuedPerFix.set(fixId, qset);
    }
    qset.add(sub);
    return () => {
      const current = this.queuedPerFix.get(fixId);
      if (!current) return;
      current.delete(sub);
      if (current.size === 0) {
        this.queuedPerFix.delete(fixId);
      }
    };
  }

  /** Number of active subscribers (global + per-fix, sync + queued). */
  subscriberCount(): number {
    let total = this.globalListeners.size + this.queuedGlobal.size;
    for (const set of this.fixListeners.values()) {
      total += set.size;
    }
    for (const set of this.queuedPerFix.values()) {
      total += set.size;
    }
    return total;
  }

  /** Drop the ring buffer for one fixId (e.g. after the fix finishes and is reported). */
  clearFix(fixId: string): void {
    this.perFix.delete(fixId);
  }

  /** Drop every per-fix buffer. Intended for shutdown / tests. */
  clearAll(): void {
    this.perFix.clear();
  }

  /** Snapshot the current buffer for a fixId (used by SSE replay on attach). */
  snapshot(fixId: string): KovaEvent[] {
    const state = this.perFix.get(fixId);
    return state ? state.buffer.slice() : [];
  }

  private getOrCreateFixState(fixId: string): PerFixState {
    let state = this.perFix.get(fixId);
    if (!state) {
      state = { nextSeq: 0, buffer: [] };
      this.perFix.set(fixId, state);
    }
    return state;
  }

  private safeDeliver(listener: EventListener, event: KovaEvent): void {
    try {
      const result = listener(event) as unknown;
      // Listener may be async; surface a rejection but don't block the loop.
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[event-bus] async subscriber rejected: ${msg}`);
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[event-bus] subscriber threw: ${msg}`);
    }
  }

  /**
   * Append an event to a queued subscriber's outbound queue. If the queue is
   * at capacity, evict the oldest event (drop-oldest) and notify `onDrop` so
   * the caller can render a "scrollback gap" marker or count drops.
   */
  private enqueueForSubscriber(sub: QueuedSubscriber, event: KovaEvent): void {
    if (sub.queue.length >= sub.capacity) {
      const dropped = sub.queue.shift();
      if (dropped && sub.onDrop) {
        try {
          sub.onDrop(dropped);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[event-bus] onDrop callback threw: ${msg}`);
        }
      }
    }
    sub.queue.push(event);
    if (!sub.draining) {
      sub.draining = true;
      // Schedule async drain. queueMicrotask is unbounded by I/O; for slow
      // (potentially async) listeners we await each callback so a single
      // listener can't peg the event loop with re-entry, but the publisher
      // path NEVER waits on this drain.
      queueMicrotask(() => {
        this.drainSubscriber(sub).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[event-bus] subscriber drain rejected: ${msg}`);
          sub.draining = false;
        });
      });
    }
  }

  private async drainSubscriber(sub: QueuedSubscriber): Promise<void> {
    try {
      while (sub.queue.length > 0) {
        const event = sub.queue.shift();
        if (!event) break;
        try {
          const result = sub.listener(event) as unknown;
          if (result instanceof Promise) {
            await result;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`[event-bus] queued subscriber threw: ${msg}`);
        }
      }
    } finally {
      sub.draining = false;
    }
  }
}

/**
 * Process-singleton event bus. Wave-executor and loop.ts publish here so that
 * an external HTTP SSE client can attach without threading the bus through
 * every call site. Tests construct their own EventBus instances; production
 * code uses this default.
 */
let defaultInstance: EventBus | undefined;

export function getDefaultEventBus(): EventBus {
  if (!defaultInstance) {
    defaultInstance = new EventBus();
  }
  return defaultInstance;
}

/** Replace the default bus (used by tests that need isolation). */
export function setDefaultEventBus(bus: EventBus | undefined): void {
  defaultInstance = bus;
}
