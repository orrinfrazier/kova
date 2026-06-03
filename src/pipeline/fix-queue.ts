// Sequential fix queue — enqueues fix requests and runs them one at a time.

import { log } from '../utils/logger.js';

export interface FixRequest {
  issueNumber: number;
  repoPath: string;
  repoName: string;
}

export interface FixQueue {
  enqueue(request: FixRequest): void;
  size(): number;
  isRunning(): boolean;
  drain(): Promise<void>;
  shutdown(): void;
}

export function createFixQueue(handler: (request: FixRequest) => Promise<void>): FixQueue {
  const pending: FixRequest[] = [];
  let running = false;
  let stopped = false;
  let drainResolvers: Array<() => void> = [];

  function notifyDrain(): void {
    for (const resolve of drainResolvers) {
      resolve();
    }
    drainResolvers = [];
  }

  async function processNext(): Promise<void> {
    if (stopped || pending.length === 0) {
      running = false;
      notifyDrain();
      return;
    }

    running = true;
    const request = pending.shift();
    if (request === undefined) {
      running = false;
      notifyDrain();
      return;
    }

    try {
      await handler(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Fix queue: handler failed for #${request.issueNumber}: ${message}`);
    }

    await processNext();
  }

  return {
    enqueue(request: FixRequest): void {
      if (stopped) return;
      pending.push(request);
      if (!running) {
        void processNext();
      }
    },

    size(): number {
      return pending.length;
    },

    isRunning(): boolean {
      return running;
    },

    drain(): Promise<void> {
      if (!running && pending.length === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        drainResolvers.push(resolve);
      });
    },

    shutdown(): void {
      stopped = true;
      if (!running) {
        notifyDrain();
      }
    },
  };
}
