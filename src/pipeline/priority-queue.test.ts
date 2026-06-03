import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPriorityFixQueue, type PriorityFixQueue, type PriorityFixRequest } from './priority-queue.js';

function makeRequest(issueNumber: number, overrides?: Partial<PriorityFixRequest>): PriorityFixRequest {
  return {
    issueNumber,
    repoPath: `/tmp/repo`,
    repoName: 'test-repo',
    score: 40,
    blockedBy: [],
    ...overrides,
  };
}

describe('createPriorityFixQueue', () => {
  let queue: PriorityFixQueue;

  afterEach(() => {
    queue?.shutdown();
  });

  describe('priority ordering', () => {
    it('processes higher-score issues before lower-score issues', async () => {
      const order: number[] = [];
      queue = createPriorityFixQueue({
        handler: async (req) => {
          order.push(req.issueNumber);
        },
        maxConcurrency: 1,
      });

      queue.enqueue(makeRequest(1, { score: 20 }));
      queue.enqueue(makeRequest(2, { score: 80 }));
      queue.enqueue(makeRequest(3, { score: 60 }));

      await queue.start();
      await queue.drain();

      expect(order).toEqual([2, 3, 1]);
    });

    it('breaks score ties by issue number (lower first)', async () => {
      const order: number[] = [];
      queue = createPriorityFixQueue({
        handler: async (req) => {
          order.push(req.issueNumber);
        },
        maxConcurrency: 1,
      });

      queue.enqueue(makeRequest(5, { score: 50 }));
      queue.enqueue(makeRequest(2, { score: 50 }));
      queue.enqueue(makeRequest(8, { score: 50 }));

      await queue.start();
      await queue.drain();

      expect(order).toEqual([2, 5, 8]);
    });
  });

  describe('dependency awareness', () => {
    it('holds a blocked issue until its blocker completes', async () => {
      const order: number[] = [];
      queue = createPriorityFixQueue({
        handler: async (req) => {
          order.push(req.issueNumber);
        },
        maxConcurrency: 1,
      });

      // #10 has higher score but is blocked by #5
      queue.enqueue(makeRequest(10, { score: 80, blockedBy: [5] }));
      queue.enqueue(makeRequest(5, { score: 40 }));

      await queue.start();
      await queue.drain();

      expect(order).toEqual([5, 10]);
    });

    it('handles dependency chains: A blocks B blocks C', async () => {
      const order: number[] = [];
      queue = createPriorityFixQueue({
        handler: async (req) => {
          order.push(req.issueNumber);
        },
        maxConcurrency: 1,
      });

      queue.enqueue(makeRequest(3, { score: 90, blockedBy: [2] }));
      queue.enqueue(makeRequest(2, { score: 60, blockedBy: [1] }));
      queue.enqueue(makeRequest(1, { score: 30 }));

      await queue.start();
      await queue.drain();

      expect(order).toEqual([1, 2, 3]);
    });

    it('unblocks multiple dependents when a blocker completes', async () => {
      const order: number[] = [];
      queue = createPriorityFixQueue({
        handler: async (req) => {
          order.push(req.issueNumber);
        },
        maxConcurrency: 1,
      });

      // #1 blocks both #2 and #3
      queue.enqueue(makeRequest(2, { score: 60, blockedBy: [1] }));
      queue.enqueue(makeRequest(3, { score: 50, blockedBy: [1] }));
      queue.enqueue(makeRequest(1, { score: 40 }));

      await queue.start();
      await queue.drain();

      // #1 first, then #2 (higher score), then #3
      expect(order).toEqual([1, 2, 3]);
    });

    it('ignores dependencies on issues not in the queue', async () => {
      const order: number[] = [];
      queue = createPriorityFixQueue({
        handler: async (req) => {
          order.push(req.issueNumber);
        },
        maxConcurrency: 1,
      });

      // #5 depends on #999 which is not in the queue — treat as unblocked
      queue.enqueue(makeRequest(5, { score: 40, blockedBy: [999] }));
      queue.enqueue(makeRequest(3, { score: 60 }));

      await queue.start();
      await queue.drain();

      expect(order).toEqual([3, 5]);
    });
  });

  describe('concurrency and backpressure', () => {
    it('runs up to maxConcurrency handlers in parallel', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      queue = createPriorityFixQueue({
        handler: async (_req) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((r) => setTimeout(r, 20));
          currentConcurrent--;
        },
        maxConcurrency: 3,
      });

      for (let i = 1; i <= 6; i++) {
        queue.enqueue(makeRequest(i, { score: 100 - i }));
      }

      await queue.start();
      await queue.drain();

      expect(maxConcurrent).toBe(3);
    });

    it('does not exceed maxConcurrency even with many enqueued items', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      queue = createPriorityFixQueue({
        handler: async (_req) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((r) => setTimeout(r, 10));
          currentConcurrent--;
        },
        maxConcurrency: 2,
      });

      for (let i = 1; i <= 10; i++) {
        queue.enqueue(makeRequest(i));
      }

      await queue.start();
      await queue.drain();

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it('defaults maxConcurrency to 1 when not specified', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      queue = createPriorityFixQueue({
        handler: async (_req) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((r) => setTimeout(r, 10));
          currentConcurrent--;
        },
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      queue.enqueue(makeRequest(3));

      await queue.start();
      await queue.drain();

      expect(maxConcurrent).toBe(1);
    });

    it('starts new items as slots open up (backpressure release)', async () => {
      const timeline: Array<{ issue: number; event: 'start' | 'end' }> = [];

      queue = createPriorityFixQueue({
        handler: async (req) => {
          timeline.push({ issue: req.issueNumber, event: 'start' });
          await new Promise((r) => setTimeout(r, 20));
          timeline.push({ issue: req.issueNumber, event: 'end' });
        },
        maxConcurrency: 2,
      });

      queue.enqueue(makeRequest(1, { score: 90 }));
      queue.enqueue(makeRequest(2, { score: 80 }));
      queue.enqueue(makeRequest(3, { score: 70 }));

      await queue.start();
      await queue.drain();

      // #1 and #2 start concurrently, #3 starts after one finishes
      const start3 = timeline.findIndex((e) => e.issue === 3 && e.event === 'start');
      const anyEnd = timeline.findIndex((e) => e.event === 'end');
      expect(start3).toBeGreaterThanOrEqual(anyEnd);
    });
  });

  describe('poison pill — skip after N consecutive failures', () => {
    it('skips an issue after maxConsecutiveFailures', async () => {
      let attempts = 0;
      queue = createPriorityFixQueue({
        handler: async (req) => {
          if (req.issueNumber === 1) {
            attempts++;
            throw new Error('always fails');
          }
        },
        maxConcurrency: 1,
        maxConsecutiveFailures: 3,
      });

      queue.enqueue(makeRequest(1));

      await queue.start();
      await queue.drain();

      expect(attempts).toBe(3);
      const status = queue.getStatus();
      const entry = status.entries.find((e) => e.request.issueNumber === 1);
      expect(entry?.status).toBe('skipped');
      expect(entry?.consecutiveFailures).toBe(3);
    });

    it('defaults maxConsecutiveFailures to 3', async () => {
      let attempts = 0;
      queue = createPriorityFixQueue({
        handler: async (_req) => {
          attempts++;
          throw new Error('fails');
        },
      });

      queue.enqueue(makeRequest(1));

      await queue.start();
      await queue.drain();

      expect(attempts).toBe(3);
    });

    it('does not re-enqueue on success', async () => {
      let callCount = 0;
      queue = createPriorityFixQueue({
        handler: async (_req) => {
          callCount++;
        },
        maxConcurrency: 1,
      });

      queue.enqueue(makeRequest(1));

      await queue.start();
      await queue.drain();

      expect(callCount).toBe(1);
    });

    it('continues processing other issues after skipping a poison pill', async () => {
      const completed: number[] = [];
      queue = createPriorityFixQueue({
        handler: async (req) => {
          if (req.issueNumber === 1) {
            throw new Error('poison');
          }
          completed.push(req.issueNumber);
        },
        maxConcurrency: 1,
        maxConsecutiveFailures: 2,
      });

      queue.enqueue(makeRequest(1, { score: 80 }));
      queue.enqueue(makeRequest(2, { score: 40 }));

      await queue.start();
      await queue.drain();

      expect(completed).toEqual([2]);
    });
  });

  describe('getStatus', () => {
    it('returns empty status for a new queue', () => {
      queue = createPriorityFixQueue({
        handler: vi.fn().mockResolvedValue(undefined),
        maxConcurrency: 2,
      });

      const status = queue.getStatus();

      expect(status.entries).toEqual([]);
      expect(status.activeSlots).toBe(0);
      expect(status.maxSlots).toBe(2);
      expect(status.completedCount).toBe(0);
      expect(status.failedCount).toBe(0);
      expect(status.skippedCount).toBe(0);
    });

    it('shows waiting entries before start', () => {
      queue = createPriorityFixQueue({
        handler: vi.fn().mockResolvedValue(undefined),
        maxConcurrency: 1,
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));

      const status = queue.getStatus();

      expect(status.entries).toHaveLength(2);
      expect(status.entries.every((e) => e.status === 'waiting')).toBe(true);
    });

    it('shows blocked entries for issues with unresolved dependencies', () => {
      queue = createPriorityFixQueue({
        handler: vi.fn().mockResolvedValue(undefined),
        maxConcurrency: 1,
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2, { blockedBy: [1] }));

      const status = queue.getStatus();

      const entry2 = status.entries.find((e) => e.request.issueNumber === 2);
      expect(entry2?.status).toBe('blocked');
    });

    it('shows running entries during processing', async () => {
      let resolveHandler!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        queue = createPriorityFixQueue({
          handler: async (_req) => {
            resolve();
            await new Promise<void>((r) => {
              resolveHandler = r;
            });
          },
          maxConcurrency: 1,
        });
      });

      queue.enqueue(makeRequest(1));
      await queue.start();
      await handlerStarted;

      const status = queue.getStatus();
      expect(status.activeSlots).toBe(1);
      const entry = status.entries.find((e) => e.request.issueNumber === 1);
      expect(entry?.status).toBe('running');

      resolveHandler();
      await queue.drain();
    });

    it('shows completed entries after processing', async () => {
      queue = createPriorityFixQueue({
        handler: vi.fn().mockResolvedValue(undefined),
        maxConcurrency: 1,
      });

      queue.enqueue(makeRequest(1));

      await queue.start();
      await queue.drain();

      const status = queue.getStatus();
      expect(status.completedCount).toBe(1);
      const entry = status.entries.find((e) => e.request.issueNumber === 1);
      expect(entry?.status).toBe('completed');
    });

    it('tracks counts correctly across mixed outcomes', async () => {
      queue = createPriorityFixQueue({
        handler: async (req) => {
          if (req.issueNumber === 2) {
            throw new Error('fails');
          }
        },
        maxConcurrency: 1,
        maxConsecutiveFailures: 1,
      });

      queue.enqueue(makeRequest(1, { score: 90 }));
      queue.enqueue(makeRequest(2, { score: 80 }));
      queue.enqueue(makeRequest(3, { score: 70 }));

      await queue.start();
      await queue.drain();

      const status = queue.getStatus();
      expect(status.completedCount).toBe(2);
      expect(status.skippedCount).toBe(1);
    });
  });

  describe('drain', () => {
    it('resolves immediately when queue is empty', async () => {
      queue = createPriorityFixQueue({
        handler: vi.fn().mockResolvedValue(undefined),
      });

      await queue.start();
      await expect(queue.drain()).resolves.toBeUndefined();
    });

    it('waits for all in-flight and pending items to complete', async () => {
      const completed: number[] = [];
      queue = createPriorityFixQueue({
        handler: async (req) => {
          await new Promise((r) => setTimeout(r, 10));
          completed.push(req.issueNumber);
        },
        maxConcurrency: 2,
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      queue.enqueue(makeRequest(3));

      await queue.start();
      await queue.drain();

      expect(completed).toHaveLength(3);
    });
  });

  describe('shutdown', () => {
    it('stops processing new items after shutdown', async () => {
      const handler = vi.fn<(request: PriorityFixRequest) => Promise<void>>().mockResolvedValue(undefined);
      queue = createPriorityFixQueue({ handler, maxConcurrency: 1 });

      queue.shutdown();
      queue.enqueue(makeRequest(1));

      // Give async processing time to (not) happen
      await new Promise((r) => setTimeout(r, 30));

      expect(handler).not.toHaveBeenCalled();
    });

    it('drain resolves after shutdown', async () => {
      queue = createPriorityFixQueue({
        handler: vi.fn().mockResolvedValue(undefined),
      });

      queue.shutdown();
      await expect(queue.drain()).resolves.toBeUndefined();
    });
  });
});
