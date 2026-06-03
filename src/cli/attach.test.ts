// kova attach <run-id> — integration tests for the SSE client.
//
// Strategy: spin up a real EventBus + webhook-server-with-bus and connect
// the attach() client to it over loopback. Verify:
//   1. SSE replay → events are rendered.
//   2. Live events after attach also stream.
//   3. AbortController cancels cleanly without erroring.
//   4. parseSseFrames handles partial chunks (the framing parser is exposed
//      because raw http parsing is what tmux's control-mode does first).

import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWebhookServer, type WebhookServer } from '../core/webhook-server.js';
import { EventBus } from '../telemetry/event-bus/bus.js';
import type { KovaEvent } from '../telemetry/event-bus/schema.js';
import { registerRun } from '../telemetry/run-registry.js';
import { type AttachOptions, attach, formatEventLine, parseSseFrames } from './attach.js';

const root = resolve(import.meta.dirname, '../..');

function getCliSource(): string {
  return readFileSync(resolve(root, 'src/cli/index.ts'), 'utf-8');
}

describe('kova attach command — CLI surface', () => {
  it('CLI source registers an attach command', () => {
    const src = getCliSource();
    expect(src).toContain(".command('attach");
  });

  it('CLI source imports from ./attach.js', () => {
    const src = getCliSource();
    expect(src).toContain('./attach.js');
  });
});

describe('parseSseFrames — SSE frame parser', () => {
  it('parses a single complete frame', () => {
    const buf = 'event: kova\ndata: {"type":"fix-started","fixId":"x"}\n\n';
    const { events, remainder } = parseSseFrames(buf);
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ type: 'fix-started', fixId: 'x' });
    expect(remainder).toBe('');
  });

  it('parses multiple frames in one chunk', () => {
    const buf =
      'event: kova\ndata: {"a":1}\n\n' + //
      'event: kova\ndata: {"b":2}\n\n';
    const { events, remainder } = parseSseFrames(buf);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    expect(remainder).toBe('');
  });

  it('returns the unconsumed tail as remainder when a frame is incomplete', () => {
    const buf = 'event: kova\ndata: {"a":1}\n\nevent: kova\ndata: {"par';
    const { events, remainder } = parseSseFrames(buf);
    expect(events).toEqual([{ a: 1 }]);
    expect(remainder).toBe('event: kova\ndata: {"par');
  });

  it('skips heartbeat comments (": heartbeat ..." and ": connected")', () => {
    const buf =
      ': connected\n\n' + //
      ': heartbeat 12345\n\n' +
      'event: kova\ndata: {"a":1}\n\n';
    const { events } = parseSseFrames(buf);
    expect(events).toEqual([{ a: 1 }]);
  });

  it('skips frames whose data is not valid JSON instead of throwing', () => {
    const buf =
      'event: kova\ndata: not-json\n\n' + //
      'event: kova\ndata: {"a":1}\n\n';
    const { events } = parseSseFrames(buf);
    expect(events).toEqual([{ a: 1 }]);
  });
});

describe('formatEventLine — renders an event as one line', () => {
  it('renders fix-started', () => {
    const line = formatEventLine({
      type: 'fix-started',
      runId: 'r',
      repoId: 'o/r',
      fixId: 'F',
      issueNumber: 42,
      seq: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
    } as KovaEvent);
    expect(line).toMatch(/fix-started/);
    expect(line).toMatch(/#42/);
  });

  it('renders wave-enter with wave name', () => {
    const line = formatEventLine({
      type: 'wave-enter',
      runId: 'r',
      repoId: 'o/r',
      fixId: 'F',
      wave: 'impl',
      seq: 1,
      timestamp: '2026-01-01T00:00:01.000Z',
    } as KovaEvent);
    expect(line).toMatch(/wave-enter/);
    expect(line).toMatch(/impl/);
  });

  it('renders fix-done with outcome', () => {
    const line = formatEventLine({
      type: 'fix-done',
      runId: 'r',
      repoId: 'o/r',
      fixId: 'F',
      outcome: 'done',
      totalCostUsd: 1.23,
      seq: 99,
      timestamp: '2026-01-01T00:01:00.000Z',
    } as KovaEvent);
    expect(line).toMatch(/fix-done/);
    expect(line).toMatch(/done/);
  });
});

describe('attach() connects to a live server and tails events', () => {
  let repoPath: string;
  let bus: EventBus;
  let server: WebhookServer;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'kova-attach-'));
    bus = new EventBus();
    // The webhook server already exposes /events when eventBus is provided.
    server = createWebhookServer({
      secret: 'unused',
      port: 0, // random port
      enqueue: () => false,
      eventBus: bus,
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(repoPath, { recursive: true, force: true });
  });

  it('replays per-fix ring buffer then forwards live events', async () => {
    // Pre-publish 2 events so the bus has them in its ring buffer.
    bus.publish({ type: 'fix-started', runId: 'r1', repoId: 'o/r', fixId: 'F1', issueNumber: 1 });
    bus.publish({ type: 'wave-enter', runId: 'r1', repoId: 'o/r', fixId: 'F1', wave: 'assess' });
    // Register the run so attach can look it up.
    await registerRun(repoPath, {
      runId: 'r1',
      fixId: 'F1',
      repoId: 'o/r',
      issueNumber: 1,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
    });

    const seen: KovaEvent[] = [];
    const controller = new AbortController();
    const opts: AttachOptions = {
      runId: 'r1',
      repoPath,
      host: '127.0.0.1',
      port: server.port,
      onEvent: (e) => {
        seen.push(e);
        if (seen.length === 3) controller.abort();
      },
      signal: controller.signal,
    };

    const attachPromise = attach(opts);

    // Drive a live event after attach is in flight. Wait for the SSE handler
    // to be ready to fan out by polling subscriber count.
    await new Promise<void>((res) => {
      const t = setInterval(() => {
        if (bus.subscriberCount() > 0) {
          clearInterval(t);
          res();
        }
      }, 10);
    });
    bus.publish({ type: 'wave-enter', runId: 'r1', repoId: 'o/r', fixId: 'F1', wave: 'spec' });

    await attachPromise.catch(() => {
      // attach() exits via AbortError once we've seen 3 events; treat as success.
    });

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.map((e) => e.type)).toEqual(['fix-started', 'wave-enter', 'wave-enter']);
  });

  it('rejects when the run id is not in the registry', async () => {
    await expect(
      attach({
        runId: 'nonexistent',
        repoPath,
        host: '127.0.0.1',
        port: server.port,
        onEvent: () => undefined,
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('multiple clients can attach to the same run simultaneously', async () => {
    bus.publish({ type: 'fix-started', runId: 'r2', repoId: 'o/r', fixId: 'F2', issueNumber: 2 });
    await registerRun(repoPath, {
      runId: 'r2',
      fixId: 'F2',
      repoId: 'o/r',
      issueNumber: 2,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
    });

    const seenA: KovaEvent[] = [];
    const seenB: KovaEvent[] = [];
    const cA = new AbortController();
    const cB = new AbortController();

    const pA = attach({
      runId: 'r2',
      repoPath,
      host: '127.0.0.1',
      port: server.port,
      onEvent: (e) => {
        seenA.push(e);
        if (seenA.length === 2) cA.abort();
      },
      signal: cA.signal,
    });
    const pB = attach({
      runId: 'r2',
      repoPath,
      host: '127.0.0.1',
      port: server.port,
      onEvent: (e) => {
        seenB.push(e);
        if (seenB.length === 2) cB.abort();
      },
      signal: cB.signal,
    });

    // Wait for both clients to be subscribed (one global + one per-fix per client = 2 subs)
    await new Promise<void>((res) => {
      const t = setInterval(() => {
        if (bus.subscriberCount() >= 2) {
          clearInterval(t);
          res();
        }
      }, 10);
    });
    bus.publish({ type: 'wave-enter', runId: 'r2', repoId: 'o/r', fixId: 'F2', wave: 'impl' });

    await Promise.allSettled([pA, pB]);

    expect(seenA.length).toBeGreaterThanOrEqual(2);
    expect(seenB.length).toBeGreaterThanOrEqual(2);
  });

  it('AbortController signal cleanly terminates the connection', async () => {
    bus.publish({ type: 'fix-started', runId: 'r3', repoId: 'o/r', fixId: 'F3', issueNumber: 3 });
    await registerRun(repoPath, {
      runId: 'r3',
      fixId: 'F3',
      repoId: 'o/r',
      issueNumber: 3,
      startedAt: '2026-01-01T00:00:00.000Z',
      status: 'running',
    });

    const controller = new AbortController();
    const p = attach({
      runId: 'r3',
      repoPath,
      host: '127.0.0.1',
      port: server.port,
      onEvent: () => undefined,
      signal: controller.signal,
    });
    // Abort immediately
    controller.abort();
    // Should resolve / reject promptly without hanging
    await Promise.race([
      p.catch(() => undefined),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('attach() did not exit after abort')), 3000)),
    ]);
  });
});
