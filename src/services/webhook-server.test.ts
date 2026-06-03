import { createHmac } from 'node:crypto';
import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as metrics from './metrics.js';
import { createWebhookServer, type WebhookServer } from './webhook-server.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

const TEST_SECRET = 'test-webhook-secret';

function computeSignature(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/**
 * Make a raw HTTP request to the server and return the status + body.
 */
function request(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: options.path,
        method: options.method,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function postWebhook(
  port: number,
  payload: Record<string, unknown>,
  secret: string,
  eventType = 'issues',
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const body = JSON.stringify(payload);
  const sig = computeSignature(body, secret);
  return request(port, {
    method: 'POST',
    path: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': sig,
      'x-github-event': eventType,
    },
    body,
  });
}

function postWebhookBadSig(
  port: number,
  payload: Record<string, unknown>,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const body = JSON.stringify(payload);
  return request(port, {
    method: 'POST',
    path: '/webhook',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      'x-github-event': 'issues',
    },
    body,
  });
}

/* ------------------------------------------------------------------ */
/*  Mock factory helpers                                                */
/* ------------------------------------------------------------------ */

function makeEnqueueMock(returns = true) {
  return vi.fn<(issueNumber: number) => boolean>().mockReturnValue(returns);
}

/* ------------------------------------------------------------------ */
/*  Server lifecycle                                                    */
/* ------------------------------------------------------------------ */

describe('createWebhookServer', () => {
  let server: WebhookServer;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
  });

  it('returns a server object with start, stop, and port properties', () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });

    expect(typeof server.start).toBe('function');
    expect(typeof server.stop).toBe('function');
    expect(typeof server.port).toBe('number');
  });

  it('start() resolves and assigns a non-zero port when port 0 is given', async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });

    await server.start();
    expect(server.port).toBeGreaterThan(0);
  });

  it('stop() resolves without error after start()', async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });

    await server.start();
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it('stop() resolves without error when called before start()', async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });

    await expect(server.stop()).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/*  POST /webhook — valid signature → 200                              */
/* ------------------------------------------------------------------ */

describe('POST /webhook — valid signature', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 200 for a valid issues webhook with correct signature', async () => {
    const payload = {
      action: 'labeled',
      issue: {
        number: 1,
        title: 'Bug',
        body: 'broken',
        labels: [{ name: 'auto-fix' }],
        html_url: 'https://github.com/o/r/issues/1',
      },
      label: { name: 'auto-fix' },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'octocat' },
    };

    const res = await postWebhook(port, payload, TEST_SECRET, 'issues');
    expect(res.status).toBe(200);
  });

  it('returns a JSON body on success', async () => {
    const payload = {
      action: 'labeled',
      issue: {
        number: 2,
        title: 'Bug',
        body: 'broken',
        labels: [{ name: 'auto-fix' }],
        html_url: 'https://github.com/o/r/issues/2',
      },
      label: { name: 'auto-fix' },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'octocat' },
    };

    const res = await postWebhook(port, payload, TEST_SECRET, 'issues');
    expect(res.status).toBe(200);
    const parsed: unknown = JSON.parse(res.body);
    expect(parsed).toBeDefined();
  });

  it('calls enqueue when a valid issues labeled event arrives', async () => {
    const enqueue = makeEnqueueMock();
    const localServer = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue,
    });
    await localServer.start();

    try {
      const payload = {
        action: 'labeled',
        issue: {
          number: 42,
          title: 'Bug',
          body: 'broken',
          labels: [{ name: 'auto-fix' }],
          html_url: 'https://github.com/o/r/issues/42',
        },
        label: { name: 'auto-fix' },
        repository: { full_name: 'owner/repo' },
        sender: { login: 'octocat' },
      };

      await postWebhook(localServer.port, payload, TEST_SECRET, 'issues');
      expect(enqueue).toHaveBeenCalledWith(42);
    } finally {
      await localServer.stop();
    }
  });

  it('returns 200 for a ping event with valid signature', async () => {
    const payload = { zen: 'Design for failure.', hook_id: 1 };
    const res = await postWebhook(port, payload, TEST_SECRET, 'ping');
    expect(res.status).toBe(200);
  });

  it('returns 200 for an issue_comment event with valid signature', async () => {
    const payload = {
      action: 'created',
      issue: { number: 10, title: 'Test', body: 'body', labels: [], html_url: 'https://github.com/o/r/issues/10' },
      comment: { id: 1, body: '/kova fix', user: { login: 'dev' } },
      repository: { full_name: 'owner/repo' },
      sender: { login: 'dev' },
    };
    const res = await postWebhook(port, payload, TEST_SECRET, 'issue_comment');
    expect(res.status).toBe(200);
  });
});

/* ------------------------------------------------------------------ */
/*  POST /webhook — invalid signature → 401                            */
/* ------------------------------------------------------------------ */

describe('POST /webhook — invalid signature', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 401 when x-hub-signature-256 header is missing', async () => {
    const body = JSON.stringify({ action: 'labeled' });
    const res = await request(port, {
      method: 'POST',
      path: '/webhook',
      headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature is incorrect', async () => {
    const payload = { action: 'labeled', issue: { number: 1 } };
    const res = await postWebhookBadSig(port, payload);
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature uses the wrong secret', async () => {
    const payload = { action: 'labeled', issue: { number: 1 } };
    const res = await postWebhook(port, payload, 'wrong-secret', 'issues');
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature header is an empty string', async () => {
    const body = JSON.stringify({ action: 'labeled' });
    const res = await request(port, {
      method: 'POST',
      path: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': '',
        'x-github-event': 'issues',
      },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('does not call enqueue when signature is invalid', async () => {
    const enqueue = makeEnqueueMock();
    const localServer = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue,
    });
    await localServer.start();

    try {
      const payload = { action: 'labeled', issue: { number: 99 } };
      await postWebhookBadSig(localServer.port, payload);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      await localServer.stop();
    }
  });

  it('returns a JSON error body on 401', async () => {
    const payload = { action: 'labeled', issue: { number: 1 } };
    const res = await postWebhookBadSig(port, payload);
    expect(res.status).toBe(401);
    const parsed: unknown = JSON.parse(res.body);
    expect(parsed).toBeDefined();
    expect(parsed).toHaveProperty('error');
  });
});

/* ------------------------------------------------------------------ */
/*  GET /health → 200 with status JSON                                 */
/* ------------------------------------------------------------------ */

describe('GET /health', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 200', async () => {
    const res = await request(port, { method: 'GET', path: '/health' });
    expect(res.status).toBe(200);
  });

  it('returns a JSON body', async () => {
    const res = await request(port, { method: 'GET', path: '/health' });
    expect(() => JSON.parse(res.body)).not.toThrow();
  });

  it('response body includes a status field', async () => {
    const res = await request(port, { method: 'GET', path: '/health' });
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty('status');
  });

  it('response body includes a queueSize field', async () => {
    const res = await request(port, { method: 'GET', path: '/health' });
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty('queueSize');
    expect(typeof parsed.queueSize).toBe('number');
  });

  it('response body includes a running field', async () => {
    const res = await request(port, { method: 'GET', path: '/health' });
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty('running');
    expect(typeof parsed.running).toBe('boolean');
  });

  it('queueSize reflects the queue state injected', async () => {
    const enqueue = makeEnqueueMock();
    const queueStub = { size: () => 3, isRunning: () => false };
    const localServer = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue,
      queue: queueStub,
    });
    await localServer.start();

    try {
      const res = await request(localServer.port, { method: 'GET', path: '/health' });
      const parsed = JSON.parse(res.body) as Record<string, unknown>;
      expect(parsed.queueSize).toBe(3);
    } finally {
      await localServer.stop();
    }
  });

  it('running field reflects queue isRunning state', async () => {
    const enqueue = makeEnqueueMock();
    const queueStub = { size: () => 0, isRunning: () => true };
    const localServer = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue,
      queue: queueStub,
    });
    await localServer.start();

    try {
      const res = await request(localServer.port, { method: 'GET', path: '/health' });
      const parsed = JSON.parse(res.body) as Record<string, unknown>;
      expect(parsed.running).toBe(true);
    } finally {
      await localServer.stop();
    }
  });

  it('content-type header is application/json', async () => {
    const res = await request(port, { method: 'GET', path: '/health' });
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

/* ------------------------------------------------------------------ */
/*  Non-POST to /webhook → 405                                          */
/* ------------------------------------------------------------------ */

describe('Non-POST to /webhook', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 405 for GET /webhook', async () => {
    const res = await request(port, { method: 'GET', path: '/webhook' });
    expect(res.status).toBe(405);
  });

  it('returns 405 for PUT /webhook', async () => {
    const res = await request(port, { method: 'PUT', path: '/webhook' });
    expect(res.status).toBe(405);
  });

  it('returns 405 for PATCH /webhook', async () => {
    const res = await request(port, { method: 'PATCH', path: '/webhook' });
    expect(res.status).toBe(405);
  });

  it('returns 405 for DELETE /webhook', async () => {
    const res = await request(port, { method: 'DELETE', path: '/webhook' });
    expect(res.status).toBe(405);
  });

  it('includes Allow header with POST on a 405 response', async () => {
    const res = await request(port, { method: 'GET', path: '/webhook' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toMatch(/POST/);
  });

  it('returns a JSON body on 405', async () => {
    const res = await request(port, { method: 'GET', path: '/webhook' });
    expect(() => JSON.parse(res.body)).not.toThrow();
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed).toHaveProperty('error');
  });
});

/* ------------------------------------------------------------------ */
/*  Unknown routes → 404                                               */
/* ------------------------------------------------------------------ */

describe('Unknown routes', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 404 for GET /unknown', async () => {
    const res = await request(port, { method: 'GET', path: '/unknown' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for POST /unknown', async () => {
    const res = await request(port, { method: 'POST', path: '/unknown' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for GET /', async () => {
    const res = await request(port, { method: 'GET', path: '/' });
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/*  Body size limit → 413                                              */
/* ------------------------------------------------------------------ */

describe('POST /webhook — body size limit', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 413 when request body exceeds size limit', async () => {
    const oversizedBody = 'x'.repeat(2 * 1024 * 1024);
    const res = await request(port, {
      method: 'POST',
      path: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=ignored',
        'x-github-event': 'issues',
      },
      body: oversizedBody,
    });
    expect(res.status).toBe(413);
  });
});

/* ------------------------------------------------------------------ */
/*  Malformed JSON body → 400                                          */
/* ------------------------------------------------------------------ */

describe('POST /webhook — malformed JSON body', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 400 when body is valid signature but invalid JSON', async () => {
    const body = 'this is not json{{{';
    const sig = computeSignature(body, TEST_SECRET);
    const res = await request(port, {
      method: 'POST',
      path: '/webhook',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': sig,
        'x-github-event': 'issues',
      },
      body,
    });
    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /metrics — enabled                                             */
/* ------------------------------------------------------------------ */

describe('GET /metrics — enabled', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    metrics.reset();
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
      metricsEnabled: true,
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 200 with Prometheus content type', async () => {
    const res = await request(port, { method: 'GET', path: '/metrics' });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; version=0.0.4; charset=utf-8');
  });

  it('returns body from metrics.serialize()', async () => {
    // Record some metrics so serialize returns non-empty output
    metrics.recordIssueFixed();
    const res = await request(port, { method: 'GET', path: '/metrics' });
    expect(res.status).toBe(200);
    expect(res.body).toContain('kova_issues_fixed_total');
  });
});

/* ------------------------------------------------------------------ */
/*  GET /metrics — disabled                                            */
/* ------------------------------------------------------------------ */

describe('GET /metrics — disabled', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
      metricsEnabled: false,
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 404 when metrics are disabled', async () => {
    const res = await request(port, { method: 'GET', path: '/metrics' });
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /metrics — default (no metricsEnabled option)                  */
/* ------------------------------------------------------------------ */

describe('GET /metrics — default (no metricsEnabled option)', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 404 when metricsEnabled is not set (defaults to disabled)', async () => {
    const res = await request(port, { method: 'GET', path: '/metrics' });
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /events — SSE stream (kova#292)                                */
/* ------------------------------------------------------------------ */

describe('GET /events — event bus disabled', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 404 when eventBus is not configured', async () => {
    const res = await request(port, { method: 'GET', path: '/events' });
    expect(res.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ */
/*  GET /capture — per-fix scrollback ring buffer (kova#295)            */
/* ------------------------------------------------------------------ */

describe('GET /capture — event bus disabled', () => {
  let server: WebhookServer;
  let port: number;

  beforeEach(async () => {
    server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
    });
    await server.start();
    port = server.port;
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 404 when eventBus is not configured', async () => {
    const res = await request(port, { method: 'GET', path: '/capture?fixId=A' });
    expect(res.status).toBe(404);
  });
});

describe('GET /capture — event bus enabled', () => {
  it('returns the JSON snapshot for the given fixId', async () => {
    const { EventBus } = await import('./event-bus/bus.js');
    const bus = new EventBus();
    // Seed a few events.
    bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'A', type: 'fix-started', issueNumber: 295 });
    bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'A', type: 'wave-enter', wave: 'assess' });
    bus.publish({
      runId: 'r',
      repoId: 'o/r',
      fixId: 'A',
      type: 'wave-output',
      wave: 'impl',
      turn: 0,
      text: 'x',
    });
    const server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
      eventBus: bus,
    });
    await server.start();
    try {
      const res = await request(server.port, { method: 'GET', path: '/capture?fixId=A' });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/json');
      const parsed = JSON.parse(res.body) as Array<Record<string, unknown>>;
      expect(parsed.length).toBe(3);
      expect(parsed.map((e) => e.type)).toEqual(['fix-started', 'wave-enter', 'wave-output']);
    } finally {
      await server.stop();
    }
  });

  it('supports ?wave= filter and ?lines= limit', async () => {
    const { EventBus } = await import('./event-bus/bus.js');
    const bus = new EventBus();
    for (let i = 0; i < 5; i++) {
      bus.publish({
        runId: 'r',
        repoId: 'o/r',
        fixId: 'A',
        type: 'wave-output',
        wave: 'impl',
        turn: i,
      });
    }
    bus.publish({ runId: 'r', repoId: 'o/r', fixId: 'A', type: 'wave-enter', wave: 'spec' });
    const server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
      eventBus: bus,
    });
    await server.start();
    try {
      const filteredRes = await request(server.port, { method: 'GET', path: '/capture?fixId=A&wave=impl' });
      const filtered = JSON.parse(filteredRes.body) as Array<Record<string, unknown>>;
      expect(filtered.length).toBe(5);
      expect(filtered.every((e) => e.wave === 'impl')).toBe(true);

      const limitedRes = await request(server.port, { method: 'GET', path: '/capture?fixId=A&wave=impl&lines=2' });
      const limited = JSON.parse(limitedRes.body) as Array<Record<string, unknown>>;
      expect(limited.length).toBe(2);
      expect(limited.map((e) => e.turn)).toEqual([3, 4]);
    } finally {
      await server.stop();
    }
  });

  it('returns 400 when fixId is missing', async () => {
    const { EventBus } = await import('./event-bus/bus.js');
    const bus = new EventBus();
    const server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
      eventBus: bus,
    });
    await server.start();
    try {
      const res = await request(server.port, { method: 'GET', path: '/capture' });
      expect(res.status).toBe(400);
    } finally {
      await server.stop();
    }
  });

  it('returns empty array when no events buffered for fixId', async () => {
    const { EventBus } = await import('./event-bus/bus.js');
    const bus = new EventBus();
    const server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
      eventBus: bus,
    });
    await server.start();
    try {
      const res = await request(server.port, { method: 'GET', path: '/capture?fixId=missing' });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    } finally {
      await server.stop();
    }
  });
});

describe('GET /events — event bus enabled', () => {
  it('returns 200 with text/event-stream content-type', async () => {
    const { EventBus } = await import('./event-bus/bus.js');
    const bus = new EventBus();
    const server = createWebhookServer({
      secret: TEST_SECRET,
      port: 0,
      enqueue: makeEnqueueMock(),
      eventBus: bus,
    });
    await server.start();
    try {
      // Use a streaming request — we just need to check headers then close.
      const result = await new Promise<{ status: number; contentType: string }>((resolve, reject) => {
        const req = http.request(
          { hostname: '127.0.0.1', port: server.port, path: '/events', method: 'GET' },
          (res) => {
            resolve({
              status: res.statusCode ?? 0,
              contentType: String(res.headers['content-type'] ?? ''),
            });
            res.destroy();
          },
        );
        req.on('error', reject);
        req.end();
      });
      expect(result.status).toBe(200);
      expect(result.contentType).toContain('text/event-stream');
    } finally {
      await server.stop();
    }
  });
});
