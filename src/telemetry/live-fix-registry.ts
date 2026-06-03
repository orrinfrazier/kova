// LiveFixRegistry — in-memory map of fixId → live agent handle (issue #294).
//
// Borrowed from tmux: a single registry of running "panes" (here: running
// fixes) keyed by stable id, with `send` (steer) and `kill` (abort) routed
// through that id to the per-pane handle.
//
// The registry is process-local. The daemon (services/daemon.ts) owns one
// when it dispatches `submit` work; the standalone `kova fix` path uses the
// `defaultLiveFixRegistry` singleton exported below. Both share the same
// shape so daemon and CLI flows stay symmetric.
//
// Lifecycle:
//   - wave-executor invokes its `liveHandleSink` once per wave with a fresh
//     handle that wraps `agent.steer` / `agent.abort`.
//   - fix.ts (or the caller) `register(fixId, handle)` before the wave's
//     `agent.prompt()` resolves and `clear(fixId)` when the wave finishes.
//   - `kova send <fixId> <hint>` and `kova kill <fixId>` route through the
//     daemon's `steer` / `abort` RPC commands, which call into this registry.
//
// Errors are intentionally simple — a missing fixId throws a clear message so
// the CLI can surface it verbatim. The daemon RPC layer catches these and
// converts them to `{ok:false, error}` replies.

export interface LiveFixHandle {
  /** Inject a user-role steering message into the running wave's agent. */
  steer(hint: string): void;
  /** Abort the running wave's agent (cooperative — may not fire instantly). */
  abort(): void;
}

export interface LiveFixRegistry {
  /** Register (or replace) the handle for a fixId. */
  register(fixId: string, handle: LiveFixHandle): void;
  /** Remove the handle so subsequent lookups return undefined. Idempotent. */
  clear(fixId: string): void;
  /** Return the live handle for a fixId, or undefined if none registered. */
  get(fixId: string): LiveFixHandle | undefined;
  /** Iterate every currently-registered fixId. */
  list(): IterableIterator<string>;
  /**
   * Steer the running wave for `fixId`. Throws if no handle is registered.
   * The "not running" error string is part of the public contract — the
   * daemon RPC layer matches on it to produce a clean ok:false reply, and
   * `kova send` surfaces it verbatim.
   */
  steer(fixId: string, hint: string): void;
  /** Abort the running wave for `fixId`. Same "not running" contract as steer. */
  abort(fixId: string): void;
}

const NOT_RUNNING = (fixId: string): Error => new Error(`fix '${fixId}' is not running`);

/** Construct a fresh, empty registry. */
export function createLiveFixRegistry(): LiveFixRegistry {
  const handles = new Map<string, LiveFixHandle>();
  return {
    register(fixId, handle) {
      handles.set(fixId, handle);
    },
    clear(fixId) {
      handles.delete(fixId);
    },
    get(fixId) {
      return handles.get(fixId);
    },
    list() {
      return handles.keys();
    },
    steer(fixId, hint) {
      const h = handles.get(fixId);
      if (!h) throw NOT_RUNNING(fixId);
      h.steer(hint);
    },
    abort(fixId) {
      const h = handles.get(fixId);
      if (!h) throw NOT_RUNNING(fixId);
      h.abort();
    },
  };
}

/**
 * Process-singleton registry shared across waves of a single `kova fix` run.
 *
 * Standalone `kova fix` and the daemon dispatch loop both register live
 * handles here. Concurrent fixes use different `fixId`s and so coexist
 * without collision.
 */
export const defaultLiveFixRegistry: LiveFixRegistry = createLiveFixRegistry();

/**
 * Build a `liveHandleSink` for `spawnWaveAgent` that:
 *   1. wraps the runtime handle so steer/abort calls also publish bus events
 *      with `reason: 'manual_*'` — distinguishing send-keys actions from
 *      automatic Tier-1/Tier-3 degradation;
 *   2. registers the wrapped handle in `registry` keyed by `fixId` for the
 *      duration of the wave.
 *
 * Returns `undefined` when any of the inputs needed for registration are
 * missing — the caller passes `undefined` straight into `spawnWaveAgent` and
 * the wave runs unchanged (backward-compat).
 *
 * `eventBus` is optional — when omitted, the wrap still routes steer/abort
 * to the runtime; event-bus emission is skipped.
 */
export interface BuildLiveHandleSinkOptions {
  registry: LiveFixRegistry | undefined;
  fixId: string | undefined;
  /** When set, skip registration — sandbox runs the agent in a remote container. */
  sandboxActive: boolean;
  eventBus?: {
    publish: (
      event:
        | {
            type: 'steered';
            runId: string;
            repoId: string;
            fixId: string;
            wave: EventBusWaveName;
            tier: 'steer' | 'trim' | 'abort';
            usageRatio: number;
          }
        | {
            type: 'aborted';
            runId: string;
            repoId: string;
            fixId: string;
            wave: EventBusWaveName;
            reason: string;
          },
    ) => void;
  };
  eventContext?: { runId: string; repoId: string };
  wave: EventBusWaveName;
}

/**
 * Subset of `EventWaveName` from `event-bus/schema.ts` — kept inline so this
 * primitive does not depend on the event-bus module directly. Adapters pass
 * their own narrowed value (`fix.ts` and engines already operate on
 * `FixAIWaveName` which is a superset).
 */
export type EventBusWaveName = 'brainstorm' | 'spec' | 'assess' | 'test' | 'impl' | 'quality' | 'review' | 'ship';

export function buildLiveHandleSink(opts: BuildLiveHandleSinkOptions): ((handle: LiveFixHandle) => void) | undefined {
  const { registry, fixId, sandboxActive, eventBus, eventContext, wave } = opts;
  if (registry == null || fixId == null || sandboxActive) return undefined;
  return (handle: LiveFixHandle): void => {
    const wrapped: LiveFixHandle = {
      steer(hint: string): void {
        if (eventBus != null && eventContext != null) {
          try {
            eventBus.publish({
              type: 'steered',
              runId: eventContext.runId,
              repoId: eventContext.repoId,
              fixId,
              wave,
              tier: 'steer',
              usageRatio: 0,
            });
          } catch {
            /* event-bus failures must never alter wave outcomes */
          }
        }
        handle.steer(hint);
      },
      abort(): void {
        if (eventBus != null && eventContext != null) {
          try {
            eventBus.publish({
              type: 'aborted',
              runId: eventContext.runId,
              repoId: eventContext.repoId,
              fixId,
              wave,
              reason: 'manual_abort',
            });
          } catch {
            /* event-bus failures must never alter wave outcomes */
          }
        }
        handle.abort();
      },
    };
    registry.register(fixId, wrapped);
  };
}
