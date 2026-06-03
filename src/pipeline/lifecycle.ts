// Lifecycle helpers — event-bus + run-registry plumbing extracted from fix.ts (issue #435).
//
// Encapsulates the registerRun / updateRun safe wrappers, the wave-enter
// subscriber that mirrors currentWave into the registry, and the publishFixDone
// helper that emits the terminal event + mirrors status into the registry.
// fix.ts threads the result of `setupFixLifecycle()` through its waves.

import type { EventBus } from '../services/event-bus/index.js';
import { registerRun, updateRun } from '../services/run-registry.js';
import type { Logger } from '../utils/logger.js';

export interface SetupFixLifecycleInput {
  eventBus: EventBus;
  repoPath: string;
  repoName: string;
  runId: string;
  fixId: string;
  issueNumber: number;
  logger: Logger;
}

export interface FixLifecycle {
  /** Publish the fix-done event + mirror terminal status into the registry. Idempotent. */
  publishFixDone(
    outcome: 'done' | 'failed' | 'done_with_known_issues',
    extras: { totalCostUsd: number; prNumber?: number; reason?: string },
  ): Promise<void>;
  /** Whether `publishFixDone` has already fired. The orchestrator checks this in the finally block. */
  hasPublishedFixDone(): boolean;
}

/**
 * Wire up the lifecycle events + run-registry for one fix run. Publishes
 * `fix-started`, registers the run, subscribes to `wave-enter` to write
 * `currentWave` as the pipeline advances, and returns a `FixLifecycle` whose
 * `publishFixDone` is safe to call once (subsequent calls are no-ops).
 */
export async function setupFixLifecycle(input: SetupFixLifecycleInput): Promise<FixLifecycle> {
  const { eventBus, repoPath, repoName, runId, fixId, issueNumber, logger } = input;

  const registerRunSafe = (run: Parameters<typeof registerRun>[1]): Promise<void> =>
    registerRun(repoPath, run).catch((err) => {
      logger.warn(`[run-registry] registerRun failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  const updateRunSafe = (patch: Parameters<typeof updateRun>[2]): Promise<void> =>
    updateRun(repoPath, runId, patch).catch((err) => {
      logger.warn(`[run-registry] updateRun failed: ${err instanceof Error ? err.message : String(err)}`);
    });

  const unsubscribeWaveEnter = eventBus.subscribeForFix(fixId, (event) => {
    if (event.type === 'wave-enter') {
      void updateRunSafe({ currentWave: event.wave });
    }
  });

  try {
    eventBus.publish({ type: 'fix-started', runId, repoId: repoName, fixId, issueNumber });
  } catch (err) {
    logger.warn(`[event-bus] fix-started publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  await registerRunSafe({
    runId,
    fixId,
    repoId: repoName,
    issueNumber,
    startedAt: new Date().toISOString(),
    status: 'running',
  });

  let publishedFixDone = false;

  return {
    hasPublishedFixDone: () => publishedFixDone,
    async publishFixDone(outcome, extras) {
      if (publishedFixDone) return;
      publishedFixDone = true;
      try {
        eventBus.publish({
          type: 'fix-done',
          runId,
          repoId: repoName,
          fixId,
          outcome,
          totalCostUsd: extras.totalCostUsd,
          ...(extras.prNumber != null ? { prNumber: extras.prNumber } : {}),
          ...(extras.reason != null ? { reason: extras.reason } : {}),
        });
      } catch (err) {
        logger.warn(`[event-bus] fix-done publish failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Issue #293: mirror terminal status into the on-disk registry. We map
      // 'done_with_known_issues' to 'done' — the registry's `status` field is
      // the binary "still active?" signal that `kova ls` needs; outcome detail
      // lives in the event stream.
      const registryStatus = outcome === 'failed' ? 'failed' : 'done';
      await updateRunSafe({
        status: registryStatus,
        completedAt: new Date().toISOString(),
        ...(extras.prNumber != null ? { prNumber: extras.prNumber } : {}),
      });
      unsubscribeWaveEnter();
    },
  };
}
