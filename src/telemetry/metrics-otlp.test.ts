import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetricsRegistry } from './metrics.js';
import { createOtlpExporter, type OtlpExporter, stopOtlpExporter } from './metrics-otlp.js';

/* ------------------------------------------------------------------ */
/*  Test HTTP server to capture OTLP push requests                      */
/* ------------------------------------------------------------------ */

interface CapturedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function createTestServer(): {
  server: http.Server;
  port: () => number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
  respondWith: (status: number) => void;
} {
  const requests: CapturedRequest[] = [];
  let responseStatus = 200;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.writeHead(responseStatus);
      res.end();
    });
  });

  return {
    server,
    port: () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') return addr.port;
      throw new Error('Server not listening');
    },
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    respondWith: (status: number) => {
      responseStatus = status;
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe('OTLP exporter', () => {
  let testServer: ReturnType<typeof createTestServer>;
  let exporter: OtlpExporter | undefined;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        testServer = createTestServer();
        testServer.server.listen(0, '127.0.0.1', () => resolve());
      }),
  );

  afterEach(async () => {
    if (exporter) {
      stopOtlpExporter(exporter);
      exporter = undefined;
    }
    await testServer.close();
  });

  it('POSTs JSON to configured endpoint with Content-Type application/json', async () => {
    const registry = new MetricsRegistry({ enabled: true });
    registry.recordIssueFixed();

    exporter = createOtlpExporter({
      endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
      intervalMs: 50,
      registry,
    });

    // Wait for at least one push
    await vi.waitFor(
      () => {
        expect(testServer.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );

    const req = testServer.requests[0];
    expect(req).toBeDefined();
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe('/v1/metrics');
    expect(req?.headers['content-type']).toBe('application/json');
  });

  it('sends valid OTLP JSON with resourceMetrics structure', async () => {
    const registry = new MetricsRegistry({ enabled: true });
    registry.recordIssueFixed();
    registry.recordWaveCompleted('assess');

    exporter = createOtlpExporter({
      endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
      intervalMs: 50,
      registry,
    });

    await vi.waitFor(
      () => {
        expect(testServer.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );

    const body = JSON.parse(testServer.requests[0]?.body ?? '') as {
      resourceMetrics: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
        scopeMetrics: Array<{
          scope: { name: string };
          metrics: unknown[];
        }>;
      }>;
    };

    expect(body.resourceMetrics).toHaveLength(1);
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const rm = body.resourceMetrics[0]!;
    expect(rm.resource.attributes).toContainEqual({
      key: 'service.name',
      value: { stringValue: 'kova' },
    });
    expect(rm.scopeMetrics).toHaveLength(1);
    expect(rm.scopeMetrics[0]?.scope.name).toBe('kova');
    expect(rm.scopeMetrics[0]?.metrics.length).toBeGreaterThan(0);
  });

  it('push failure is logged as warning but does not crash', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new MetricsRegistry({ enabled: true });

    testServer.respondWith(500);

    exporter = createOtlpExporter({
      endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
      intervalMs: 50,
      registry,
    });

    await vi.waitFor(
      () => {
        expect(testServer.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );

    // Wait a bit more for the warning to be logged after the response comes back
    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalled();
      },
      { timeout: 2000 },
    );

    // Process should still be alive — no crash
    expect(true).toBe(true);
    warnSpy.mockRestore();
  });

  it('push failure on connection refused is logged as warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = new MetricsRegistry({ enabled: true });

    // Close the server so connection is refused
    await testServer.close();

    exporter = createOtlpExporter({
      endpoint: 'http://127.0.0.1:19999/v1/metrics',
      intervalMs: 50,
      registry,
    });

    await vi.waitFor(
      () => {
        expect(warnSpy).toHaveBeenCalled();
      },
      { timeout: 3000 },
    );

    expect(true).toBe(true);
    warnSpy.mockRestore();
  });

  it('stopOtlpExporter stops the interval', async () => {
    const registry = new MetricsRegistry({ enabled: true });

    exporter = createOtlpExporter({
      endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
      intervalMs: 50,
      registry,
    });

    await vi.waitFor(
      () => {
        expect(testServer.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );

    stopOtlpExporter(exporter);
    exporter = undefined;

    // Wait for the final flush to land, then snapshot
    await new Promise((r) => setTimeout(r, 100));
    const countAfterStop = testServer.requests.length;

    // Wait more and verify no new requests arrive (interval is cleared)
    await new Promise((r) => setTimeout(r, 200));
    expect(testServer.requests.length).toBe(countAfterStop);
  });

  it('flushes on stop (sends one final push)', async () => {
    const registry = new MetricsRegistry({ enabled: true });
    registry.recordIssueFixed();

    exporter = createOtlpExporter({
      endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
      intervalMs: 60000, // very long interval — won't fire during test
      registry,
    });

    // No requests yet (interval hasn't fired)
    expect(testServer.requests.length).toBe(0);

    // Stop triggers a flush
    stopOtlpExporter(exporter);
    exporter = undefined;

    await vi.waitFor(
      () => {
        expect(testServer.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );
  });

  it('respects interval_ms configuration', async () => {
    const registry = new MetricsRegistry({ enabled: true });

    exporter = createOtlpExporter({
      endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
      intervalMs: 100,
      registry,
    });

    // After ~300ms with 100ms interval, we should have ~3 pushes
    await new Promise((r) => setTimeout(r, 350));
    expect(testServer.requests.length).toBeGreaterThanOrEqual(2);
    expect(testServer.requests.length).toBeLessThanOrEqual(5);
  });
});
