// Priority fix queue — concurrent, dependency-aware, with backpressure and poison pill.

import { log } from '../utils/logger.js';

export interface PriorityFixRequest {
  issueNumber: number;
  repoPath: string;
  repoName: string;
  score: number;
  blockedBy: number[];
}

export type QueueEntryStatus = 'waiting' | 'blocked' | 'running' | 'completed' | 'failed' | 'skipped';

export interface QueueEntry {
  request: PriorityFixRequest;
  status: QueueEntryStatus;
  consecutiveFailures: number;
  startedAt?: string | undefined;
  completedAt?: string | undefined;
  error?: string | undefined;
}

export interface QueueStatus {
  entries: QueueEntry[];
  activeSlots: number;
  maxSlots: number;
  completedCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface PriorityFixQueue {
  enqueue(request: PriorityFixRequest): void;
  start(): Promise<void>;
  getStatus(): QueueStatus;
  drain(): Promise<void>;
  shutdown(): void;
}

export interface PriorityFixQueueOptions {
  handler: (request: PriorityFixRequest) => Promise<void>;
  maxConcurrency?: number | undefined;
  maxConsecutiveFailures?: number | undefined;
}

export function createPriorityFixQueue(options: PriorityFixQueueOptions): PriorityFixQueue {
  const { handler, maxConcurrency = 1, maxConsecutiveFailures = 3 } = options;

  const entries: QueueEntry[] = [];
  let activeCount = 0;
  let stopped = false;
  let started = false;
  let drainResolvers: Array<() => void> = [];

  function notifyDrain(): void {
    if (activeCount > 0 || getReadyEntries().length > 0) return;
    for (const resolve of drainResolvers) {
      resolve();
    }
    drainResolvers = [];
  }

  /** Returns the set of issue numbers that are present in the queue. */
  function queuedIssueNumbers(): Set<number> {
    return new Set(entries.map((e) => e.request.issueNumber));
  }

  /** Returns the set of completed issue numbers. */
  function completedIssueNumbers(): Set<number> {
    return new Set(
      entries.filter((e) => e.status === 'completed' || e.status === 'skipped').map((e) => e.request.issueNumber),
    );
  }

  /** Check if an entry's dependencies are satisfied. */
  function isUnblocked(entry: QueueEntry): boolean {
    if (entry.request.blockedBy.length === 0) return true;
    const queued = queuedIssueNumbers();
    const completed = completedIssueNumbers();
    // Only consider blockers that are actually in the queue
    for (const dep of entry.request.blockedBy) {
      if (queued.has(dep) && !completed.has(dep)) {
        return false;
      }
    }
    return true;
  }

  /** Refresh blocked/waiting status for all pending entries. */
  function refreshStatuses(): void {
    for (const entry of entries) {
      if (entry.status === 'waiting' || entry.status === 'blocked') {
        entry.status = isUnblocked(entry) ? 'waiting' : 'blocked';
      }
    }
  }

  /** Get entries ready to run: waiting, unblocked, sorted by score desc then issue number asc. */
  function getReadyEntries(): QueueEntry[] {
    return entries
      .filter((e) => e.status === 'waiting')
      .sort((a, b) => {
        const scoreDiff = b.request.score - a.request.score;
        if (scoreDiff !== 0) return scoreDiff;
        return a.request.issueNumber - b.request.issueNumber;
      });
  }

  async function processEntry(entry: QueueEntry): Promise<void> {
    entry.status = 'running';
    entry.startedAt = new Date().toISOString();
    activeCount++;

    try {
      await handler(entry.request);
      entry.status = 'completed';
      entry.completedAt = new Date().toISOString();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      entry.consecutiveFailures++;
      entry.error = message;
      log.error(
        `Priority queue: handler failed for #${entry.request.issueNumber} (attempt ${entry.consecutiveFailures}/${maxConsecutiveFailures}): ${message}`,
      );

      if (entry.consecutiveFailures >= maxConsecutiveFailures) {
        entry.status = 'skipped';
        entry.completedAt = new Date().toISOString();
        log.warn(
          `Priority queue: skipping #${entry.request.issueNumber} after ${maxConsecutiveFailures} consecutive failures (poison pill)`,
        );
      } else {
        // Re-enqueue for retry
        entry.status = 'waiting';
        entry.startedAt = undefined;
      }
    }

    activeCount--;
    refreshStatuses();
    scheduleNext();
  }

  function scheduleNext(): void {
    if (stopped) {
      notifyDrain();
      return;
    }

    refreshStatuses();
    const ready = getReadyEntries();
    const slotsAvailable = maxConcurrency - activeCount;

    if (slotsAvailable <= 0 || ready.length === 0) {
      notifyDrain();
      return;
    }

    const toRun = ready.slice(0, slotsAvailable);
    for (const entry of toRun) {
      void processEntry(entry);
    }
  }

  return {
    enqueue(request: PriorityFixRequest): void {
      if (stopped) return;

      const entry: QueueEntry = {
        request,
        status: 'waiting',
        consecutiveFailures: 0,
      };

      entries.push(entry);
      refreshStatuses();

      if (started) {
        scheduleNext();
      }
    },

    async start(): Promise<void> {
      if (stopped) return;
      started = true;
      scheduleNext();
    },

    getStatus(): QueueStatus {
      const completedCount = entries.filter((e) => e.status === 'completed').length;
      const failedCount = entries.filter((e) => e.status === 'failed').length;
      const skippedCount = entries.filter((e) => e.status === 'skipped').length;

      return {
        entries: entries.map((e) => ({ ...e, request: { ...e.request } })),
        activeSlots: activeCount,
        maxSlots: maxConcurrency,
        completedCount,
        failedCount,
        skippedCount,
      };
    },

    drain(): Promise<void> {
      if (stopped || (activeCount === 0 && getReadyEntries().length === 0)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
      });
    },

    shutdown(): void {
      stopped = true;
      notifyDrain();
    },
  };
}
