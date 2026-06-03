// Zod discriminated-union schema for live-run observability events.
//
// Background: progress today is fire-and-forget log.info() to stdout, and the
// per-event stream inside each wave (agent.subscribe in wave-executor.ts) is
// consumed only locally. We borrow the tmux control-mode pattern (control.c,
// control-notify.c) — emit structured %events tagged with run/repo/fix/piece
// ids so external dashboards can drive + render every run live.
//
// Every event carries:
//   - runId   : top-level run (one /epic invocation, or one CLI invocation)
//   - repoId  : owner/repo
//   - fixId   : per-fix identifier (one per issue being fixed)
//   - pieceId : optional sub-piece (parallel piece work inside one fix)
//   - timestamp / seq : assigned by the bus on publish (monotonic per fixId)
//
// Event variants:
//   - fix-started  : a new fix has begun
//   - wave-enter   : a wave is starting
//   - wave-output  : per-turn output from a wave (cost delta, optional text)
//   - cost         : aggregate cost report (e.g. end of wave or end of fix)
//   - steered      : context-window steering tier crossed (steer/trim/abort)
//   - aborted      : a wave or fix aborted with a reason code
//   - fix-done     : the fix completed (done | failed | done_with_known_issues)

import { z } from 'zod';

/** Wave names exactly mirror src/types WaveName so tooling stays in sync. */
export const WaveNameSchema = z.enum(['assess', 'spec', 'test', 'impl', 'quality', 'review', 'brainstorm', 'ship']);
export type EventWaveName = z.infer<typeof WaveNameSchema>;

const idTag = {
  runId: z.string().min(1),
  repoId: z.string().min(1),
  fixId: z.string().min(1),
  pieceId: z.string().optional(),
  timestamp: z.string(),
  seq: z.number().int().nonnegative(),
};

export const FixStartedEventSchema = z.object({
  ...idTag,
  type: z.literal('fix-started'),
  issueNumber: z.number().int().optional(),
});
export type FixStartedEvent = z.infer<typeof FixStartedEventSchema>;

export const WaveEnterEventSchema = z.object({
  ...idTag,
  type: z.literal('wave-enter'),
  wave: WaveNameSchema,
});
export type WaveEnterEvent = z.infer<typeof WaveEnterEventSchema>;

export const WaveOutputEventSchema = z.object({
  ...idTag,
  type: z.literal('wave-output'),
  wave: WaveNameSchema,
  turn: z.number().int().nonnegative(),
  /** Free-form per-turn text — short summary, not full content. */
  text: z.string().optional(),
  /** Cost delta on this turn. */
  costDelta: z.number().optional(),
});
export type WaveOutputEvent = z.infer<typeof WaveOutputEventSchema>;

export const CostEventSchema = z.object({
  ...idTag,
  type: z.literal('cost'),
  wave: WaveNameSchema,
  costUsd: z.number(),
});
export type CostEvent = z.infer<typeof CostEventSchema>;

export const SteeredEventSchema = z.object({
  ...idTag,
  type: z.literal('steered'),
  wave: WaveNameSchema,
  tier: z.enum(['steer', 'trim', 'abort']),
  usageRatio: z.number(),
});
export type SteeredEvent = z.infer<typeof SteeredEventSchema>;

export const AbortedEventSchema = z.object({
  ...idTag,
  type: z.literal('aborted'),
  wave: WaveNameSchema,
  reason: z.string(),
});
export type AbortedEvent = z.infer<typeof AbortedEventSchema>;

export const FixDoneEventSchema = z.object({
  ...idTag,
  type: z.literal('fix-done'),
  outcome: z.enum(['done', 'failed', 'done_with_known_issues']),
  totalCostUsd: z.number(),
  prNumber: z.number().int().optional(),
  reason: z.string().optional(),
});
export type FixDoneEvent = z.infer<typeof FixDoneEventSchema>;

export const KovaEventSchema = z.discriminatedUnion('type', [
  FixStartedEventSchema,
  WaveEnterEventSchema,
  WaveOutputEventSchema,
  CostEventSchema,
  SteeredEventSchema,
  AbortedEventSchema,
  FixDoneEventSchema,
]);
export type KovaEvent = z.infer<typeof KovaEventSchema>;

/**
 * Input to `EventBus.publish` — everything except the bus-assigned `seq` and
 * `timestamp` fields. The caller provides the event payload; the bus stamps
 * the rest. This keeps publish-call-sites compact and prevents racy seq
 * generation outside the bus.
 *
 * We hand-roll the discriminated union for the input shape (rather than
 * `Omit<KovaEvent, 'seq' | 'timestamp'>`) so TypeScript narrows correctly on
 * the `type` literal at call sites. `Omit` over a union flattens variant
 * fields together, which trips `exactOptionalPropertyTypes` and breaks
 * object-literal narrowing.
 */
type IdTagInput = {
  runId: string;
  repoId: string;
  fixId: string;
  pieceId?: string;
};

export type KovaEventInput =
  | (IdTagInput & { type: 'fix-started'; issueNumber?: number })
  | (IdTagInput & { type: 'wave-enter'; wave: EventWaveName })
  | (IdTagInput & {
      type: 'wave-output';
      wave: EventWaveName;
      turn: number;
      text?: string;
      costDelta?: number;
    })
  | (IdTagInput & { type: 'cost'; wave: EventWaveName; costUsd: number })
  | (IdTagInput & { type: 'steered'; wave: EventWaveName; tier: 'steer' | 'trim' | 'abort'; usageRatio: number })
  | (IdTagInput & { type: 'aborted'; wave: EventWaveName; reason: string })
  | (IdTagInput & {
      type: 'fix-done';
      outcome: 'done' | 'failed' | 'done_with_known_issues';
      totalCostUsd: number;
      prNumber?: number;
      reason?: string;
    });
