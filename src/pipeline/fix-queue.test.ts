import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFixQueue, type FixQueue, type FixRequest } from './fix-queue.js';

function makeRequest(issueNumber: number): FixRequest {
  return {
    issueNumber,
    repoPath: `/tmp/repo-${issueNumber}`,
    repoName: `test-repo-${issueNumber}`,
  };
}

describe('createFixQueue', () => {
  let queue: FixQueue;

  afterEach(() => {
    queue?.shutdown();
  });

  describe('basic enqueue and execution', () => {
    it('calls the handler when a request is enqueued', async () => {
      const handler = vi.fn<(request: FixRequest) => Promise<void>>().mockResolvedValue(undefined);
      queue = createFixQueue(handler);

      queue.enqueue(makeRequest(1));
      await queue.drain();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(makeRequest(1));
    });

    it('passes the full request object to the handler', async () => {
      let received: FixRequest | undefined;
      queue = createFixQueue(async (req) => {
        received = req;
      });

      const request = makeRequest(42);
      queue.enqueue(request);
      await queue.drain();

      expect(received).toEqual(request);
    });

    it('executes a single enqueued request', async () => {
      const executed: number[] = [];
      queue = createFixQueue(async (req) => {
        executed.push(req.issueNumber);
      });

      queue.enqueue(makeRequest(7));
      await queue.drain();

      expect(executed).toEqual([7]);
    });
  });

  describe('size and running status', () => {
    it('size() returns 0 when queue is empty and idle', () => {
      queue = createFixQueue(vi.fn().mockResolvedValue(undefined));
      expect(queue.size()).toBe(0);
    });

    it('isRunning() returns false when queue is idle', () => {
      queue = createFixQueue(vi.fn().mockResolvedValue(undefined));
      expect(queue.isRunning()).toBe(false);
    });

    it('isRunning() returns true while a request is being processed', async () => {
      let resolveHandler!: () => void;
      const handlerStarted = new Promise<void>((resolve) => {
        queue = createFixQueue(async (_req) => {
          resolve();
          await new Promise<void>((r) => {
            resolveHandler = r;
          });
        });
      });

      queue.enqueue(makeRequest(1));
      await handlerStarted;

      expect(queue.isRunning()).toBe(true);

      resolveHandler();
      await queue.drain();
    });

    it('size() reflects pending (not-yet-started) requests', async () => {
      let resolveFirst!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        queue = createFixQueue(async (_req) => {
          if (_req.issueNumber === 1) {
            resolve();
            await new Promise<void>((r) => {
              resolveFirst = r;
            });
          }
        });
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      queue.enqueue(makeRequest(3));

      await firstStarted;
      // #1 is running; #2 and #3 are pending
      expect(queue.size()).toBe(2);

      resolveFirst();
      await queue.drain();
    });

    it('isRunning() returns false after drain completes', async () => {
      queue = createFixQueue(vi.fn().mockResolvedValue(undefined));

      queue.enqueue(makeRequest(1));
      await queue.drain();

      expect(queue.isRunning()).toBe(false);
    });

    it('size() returns 0 after all items are processed', async () => {
      queue = createFixQueue(vi.fn().mockResolvedValue(undefined));

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      await queue.drain();

      expect(queue.size()).toBe(0);
    });
  });

  describe('sequential execution', () => {
    it('executes multiple requests one at a time (not concurrently)', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      queue = createFixQueue(async (_req) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((r) => setTimeout(r, 10));
        currentConcurrent--;
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      queue.enqueue(makeRequest(3));
      await queue.drain();

      expect(maxConcurrent).toBe(1);
    });

    it('preserves FIFO order across multiple requests', async () => {
      const order: number[] = [];

      queue = createFixQueue(async (req) => {
        order.push(req.issueNumber);
        await new Promise((r) => setTimeout(r, 5));
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      queue.enqueue(makeRequest(3));
      await queue.drain();

      expect(order).toEqual([1, 2, 3]);
    });

    it('does not start the next request until the current one finishes', async () => {
      const timeline: Array<{ issue: number; event: 'start' | 'end' }> = [];

      queue = createFixQueue(async (req) => {
        timeline.push({ issue: req.issueNumber, event: 'start' });
        await new Promise((r) => setTimeout(r, 10));
        timeline.push({ issue: req.issueNumber, event: 'end' });
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      await queue.drain();

      // #1 must end before #2 starts
      const end1Index = timeline.findIndex((e) => e.issue === 1 && e.event === 'end');
      const start2Index = timeline.findIndex((e) => e.issue === 2 && e.event === 'start');
      expect(end1Index).toBeGreaterThanOrEqual(0);
      expect(start2Index).toBeGreaterThan(end1Index);
    });

    it('handles requests enqueued while another is running', async () => {
      const order: number[] = [];
      let resolveFirst!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        queue = createFixQueue(async (req) => {
          if (req.issueNumber === 1) {
            resolve();
            await new Promise<void>((r) => {
              resolveFirst = r;
            });
          }
          order.push(req.issueNumber);
        });
      });

      queue.enqueue(makeRequest(1));
      await firstStarted;

      // Enqueue while #1 is running
      queue.enqueue(makeRequest(2));
      queue.enqueue(makeRequest(3));

      resolveFirst();
      await queue.drain();

      expect(order).toEqual([1, 2, 3]);
    });

    it('executes 5 requests sequentially in order', async () => {
      const order: number[] = [];

      queue = createFixQueue(async (req) => {
        order.push(req.issueNumber);
        await new Promise((r) => setTimeout(r, 2));
      });

      for (let i = 1; i <= 5; i++) {
        queue.enqueue(makeRequest(i));
      }
      await queue.drain();

      expect(order).toEqual([1, 2, 3, 4, 5]);
    });
  });

  describe('drain — waiting for queue to empty', () => {
    it('drain() resolves immediately when queue is empty', async () => {
      queue = createFixQueue(vi.fn().mockResolvedValue(undefined));
      // Should resolve without hanging
      await expect(queue.drain()).resolves.toBeUndefined();
    });

    it('drain() waits for in-flight request to complete', async () => {
      let completed = false;

      queue = createFixQueue(async (_req) => {
        await new Promise((r) => setTimeout(r, 20));
        completed = true;
      });

      queue.enqueue(makeRequest(1));
      await queue.drain();

      expect(completed).toBe(true);
    });

    it('drain() waits for all queued requests to complete', async () => {
      const completed: number[] = [];

      queue = createFixQueue(async (req) => {
        await new Promise((r) => setTimeout(r, 5));
        completed.push(req.issueNumber);
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      queue.enqueue(makeRequest(3));
      await queue.drain();

      expect(completed).toHaveLength(3);
      expect(completed).toEqual([1, 2, 3]);
    });

    it('multiple concurrent drain() callers all resolve when queue empties', async () => {
      queue = createFixQueue(async (_req) => {
        await new Promise((r) => setTimeout(r, 20));
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));

      const [r1, r2, r3] = await Promise.all([queue.drain(), queue.drain(), queue.drain()]);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
      expect(r3).toBeUndefined();
    });

    it('drain() resolves correctly when requests are added before calling drain', async () => {
      const completed: number[] = [];

      queue = createFixQueue(async (req) => {
        await new Promise((r) => setTimeout(r, 5));
        completed.push(req.issueNumber);
      });

      // Enqueue before calling drain
      queue.enqueue(makeRequest(10));
      queue.enqueue(makeRequest(20));

      await queue.drain();

      expect(completed).toEqual([10, 20]);
    });
  });

  describe('error handling', () => {
    it('continues processing after handler throws', async () => {
      const completed: number[] = [];

      queue = createFixQueue(async (req) => {
        if (req.issueNumber === 2) {
          throw new Error('handler error for issue 2');
        }
        completed.push(req.issueNumber);
      });

      queue.enqueue(makeRequest(1));
      queue.enqueue(makeRequest(2));
      queue.enqueue(makeRequest(3));
      await queue.drain();

      // #1 and #3 succeed despite #2 throwing
      expect(completed).toEqual([1, 3]);
    });

    it('size() and isRunning() remain consistent after a handler error', async () => {
      queue = createFixQueue(async () => {
        throw new Error('always fails');
      });

      queue.enqueue(makeRequest(1));
      await queue.drain();

      expect(queue.size()).toBe(0);
      expect(queue.isRunning()).toBe(false);
    });
  });

  describe('shutdown', () => {
    it('shutdown() can be called when queue is idle without error', () => {
      queue = createFixQueue(vi.fn().mockResolvedValue(undefined));
      expect(() => queue.shutdown()).not.toThrow();
    });

    it('after shutdown(), newly enqueued requests are not processed', async () => {
      const handler = vi.fn<(request: FixRequest) => Promise<void>>().mockResolvedValue(undefined);
      queue = createFixQueue(handler);

      queue.shutdown();
      queue.enqueue(makeRequest(1));

      // Give any async processing time to (not) happen
      await new Promise((r) => setTimeout(r, 20));

      expect(handler).not.toHaveBeenCalled();
    });

    it('drain() resolves after shutdown even with pending requests', async () => {
      queue = createFixQueue(vi.fn().mockResolvedValue(undefined));
      queue.shutdown();
      await expect(queue.drain()).resolves.toBeUndefined();
    });
  });
});
