import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './bus.js';
import { handleSseRequest } from './sse.js';

interface TestServer {
  url: string;
  bus: EventBus;
  close: () => Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const bus = new EventBus();
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/events')) {
      handleSseRequest(req, res, bus);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    bus,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface SseClient {
  events: Array<Record<string, unknown>>;
  ready: Promise<void>;
  close: () => void;
}

function openSseClient(url: string, opts: { onEvent?: (ev: Record<string, unknown>) => void } = {}): SseClient {
  const events: Array<Record<string, unknown>> = [];
  let req: http.ClientRequest;
  let buffer = '';
  let readyResolve!: () => void;
  const ready = new Promise<void>((r) => {
    readyResolve = r;
  });

  req = http.get(url, (res) => {
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    readyResolve();
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf('\n\n');
        if (idx === -1) break;
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (dataLine) {
          try {
            const parsed = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
            events.push(parsed);
            opts.onEvent?.(parsed);
          } catch {
            // ignore non-JSON frames (e.g. heartbeats)
          }
        }
      }
    });
  });
  req.on('error', () => {
    /* expected on close */
  });

  return {
    events,
    ready,
    close: () => {
      req.destroy();
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('handleSseRequest', () => {
  let server: TestServer;

  beforeEach(async () => {
    server = await startTestServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('streams live events to a subscriber', async () => {
    const client = openSseClient(`${server.url}/events`);
    await client.ready;

    server.bus.publish({
      runId: 'r',
      repoId: 'o/r',
      fixId: 'F1',
      type: 'wave-enter',
      wave: 'assess',
    });
    server.bus.publish({
      runId: 'r',
      repoId: 'o/r',
      fixId: 'F1',
      type: 'fix-done',
      outcome: 'done',
      totalCostUsd: 0,
    });

    await delay(80);
    client.close();

    expect(client.events.length).toBeGreaterThanOrEqual(2);
    expect(client.events[0]?.type).toBe('wave-enter');
    expect(client.events[1]?.type).toBe('fix-done');
  });

  it('replays buffered events for fixId then streams live (attach-mid-run)', async () => {
    // Publish K events BEFORE the subscriber attaches
    for (let i = 0; i < 3; i++) {
      server.bus.publish({
        runId: 'r',
        repoId: 'o/r',
        fixId: 'F1',
        type: 'wave-output',
        wave: 'impl',
        turn: i,
        text: `pre-${i}`,
      });
    }

    const client = openSseClient(`${server.url}/events?fixId=F1`);
    await client.ready;
    await delay(60); // let replay flush

    // Should have seen all 3 buffered events
    const replayed = client.events.filter((e) => e.fixId === 'F1');
    expect(replayed.map((e) => e.seq)).toEqual([0, 1, 2]);

    // Now publish a live event for F1
    server.bus.publish({
      runId: 'r',
      repoId: 'o/r',
      fixId: 'F1',
      type: 'fix-done',
      outcome: 'done',
      totalCostUsd: 0,
    });

    await delay(80);
    client.close();

    const finalSeqs = client.events.filter((e) => e.fixId === 'F1').map((e) => e.seq);
    expect(finalSeqs).toEqual([0, 1, 2, 3]);
  });

  it('interleaves events from N concurrent fixes preserving per-fix ordering', async () => {
    const client = openSseClient(`${server.url}/events`);
    await client.ready;

    // Interleave 2 fixes
    server.bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'A', type: 'wave-enter', wave: 'assess' });
    server.bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'B', type: 'wave-enter', wave: 'assess' });
    server.bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'A', type: 'wave-enter', wave: 'spec' });
    server.bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'B', type: 'wave-enter', wave: 'spec' });

    await delay(80);
    client.close();

    const aSeqs = client.events.filter((e) => e.fixId === 'A').map((e) => e.seq);
    const bSeqs = client.events.filter((e) => e.fixId === 'B').map((e) => e.seq);
    expect(aSeqs).toEqual([0, 1]);
    expect(bSeqs).toEqual([0, 1]);
  });

  it('filter via ?fixId only delivers matching events', async () => {
    server.bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'A', type: 'wave-enter', wave: 'assess' });
    server.bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'B', type: 'wave-enter', wave: 'assess' });

    const client = openSseClient(`${server.url}/events?fixId=A`);
    await client.ready;
    await delay(60);

    // live event for B should be filtered
    server.bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'B', type: 'fix-done', outcome: 'done', totalCostUsd: 0 });
    server.bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'A', type: 'fix-done', outcome: 'done', totalCostUsd: 0 });

    await delay(80);
    client.close();

    const ids = new Set(client.events.map((e) => e.fixId));
    expect(ids).toEqual(new Set(['A']));
  });

  it('cleans up subscription on client disconnect', async () => {
    const client = openSseClient(`${server.url}/events`);
    await client.ready;
    expect(server.bus.subscriberCount()).toBeGreaterThan(0);
    client.close();
    await delay(80);
    expect(server.bus.subscriberCount()).toBe(0);
  });
});
