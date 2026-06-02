// EventBus — in-process pub/sub for KovaEvents with per-fix ring buffers.
//
// Inspired by tmux control-mode (control.c, control-notify.c): emit structured
// events that an external client can subscribe to live OR replay from a bounded
// buffer when attaching mid-run. Fan-out is synchronous so publishers never
// block on slow subscribers (subscribers are expected to be fast — the HTTP
// SSE handler in sse.ts queues writes through Node's stream backpressure).
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

interface PerFixState {
  /** Next seq to assign for this fixId. */
  nextSeq: number;
  /** Ring buffer of recent events for replay. */
  buffer: KovaEvent[];
}

const DEFAULT_BUFFER_CAPACITY = 1000;

export class EventBus {
  private readonly bufferCapacity: number;
  private readonly now: () => number;
  private readonly perFix = new Map<string, PerFixState>();
  private readonly globalListeners = new Set<EventListener>();
  private readonly fixListeners = new Map<string, Set<EventListener>>();

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

    // Synchronous fan-out. Subscriber errors are caught and logged so one bad
    // subscriber cannot break the bus.
    for (const listener of this.globalListeners) {
      this.safeDeliver(listener, event);
    }
    const fixSet = this.fixListeners.get(input.fixId);
    if (fixSet) {
      for (const listener of fixSet) {
        this.safeDeliver(listener, event);
      }
    }
    return event;
  }

  /**
   * Subscribe to every event published to the bus. Live-only (no replay).
   * Returns an unsubscribe function.
   */
  subscribe(listener: EventListener): Unsubscribe {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  /**
   * Subscribe to events for a specific fixId. Replays any buffered events
   * synchronously before returning, then forwards subsequent live events for
   * that fix.
   */
  subscribeForFix(fixId: string, listener: EventListener): Unsubscribe {
    let set = this.fixListeners.get(fixId);
    if (!set) {
      set = new Set();
      this.fixListeners.set(fixId, set);
    }
    set.add(listener);

    // Replay buffered events for this fixId synchronously.
    const state = this.perFix.get(fixId);
    if (state) {
      // Iterate a copy so a misbehaving listener that publishes during replay
      // does not mutate the buffer mid-iteration.
      for (const ev of state.buffer.slice()) {
        this.safeDeliver(listener, ev);
      }
    }

    return () => {
      const current = this.fixListeners.get(fixId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.fixListeners.delete(fixId);
      }
    };
  }

  /** Number of active subscribers (global + per-fix). Useful for tests + diagnostics. */
  subscriberCount(): number {
    let total = this.globalListeners.size;
    for (const set of this.fixListeners.values()) {
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
      listener(event);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`[event-bus] subscriber threw: ${msg}`);
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
