import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricsConfig } from '../types/config.js';
import { initMetrics, recordIssueFixed, serialize, shutdownMetrics } from './metrics.js';

/* ------------------------------------------------------------------ */
/*  Test HTTP server to capture OTLP push requests                      */
/* ------------------------------------------------------------------ */

interface CapturedRequest {
  body: string;
  headers: http.IncomingHttpHeaders;
}

function createTestServer(): {
  server: http.Server;
  port: () => number;
  requests: CapturedRequest[];
  close: () => Promise<void>;
} {
  const requests: CapturedRequest[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        body: Buffer.concat(chunks).toString('utf8'),
        headers: req.headers,
      });
      res.writeHead(200);
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
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

describe('initMetrics / shutdownMetrics', () => {
  let testServer: ReturnType<typeof createTestServer>;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        testServer = createTestServer();
        testServer.server.listen(0, '127.0.0.1', () => resolve());
      }),
  );

  afterEach(async () => {
    shutdownMetrics();
    await testServer.close();
  });

  it('enables the metrics singleton when config.enabled is true', () => {
    const config: MetricsConfig = { enabled: true };
    initMetrics(config);

    recordIssueFixed();
    const output = serialize();
    expect(output).toContain('kova_issues_fixed_total 1');
  });

  it('keeps metrics disabled when config is undefined', () => {
    initMetrics(undefined);

    recordIssueFixed();
    const output = serialize();
    expect(output).toBe('');
  });

  it('keeps metrics disabled when enabled is false', () => {
    const config: MetricsConfig = { enabled: false };
    initMetrics(config);

    recordIssueFixed();
    const output = serialize();
    expect(output).toBe('');
  });

  it('starts OTLP push when otlp.enabled is true', async () => {
    const config: MetricsConfig = {
      enabled: true,
      otlp: {
        enabled: true,
        endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
        interval_ms: 50,
      },
    };

    initMetrics(config);
    recordIssueFixed();

    await vi.waitFor(
      () => {
        expect(testServer.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );
  });

  it('does not start OTLP push when otlp.enabled is false', async () => {
    const config: MetricsConfig = {
      enabled: true,
      otlp: {
        enabled: false,
        interval_ms: 50,
      },
    };

    initMetrics(config);

    await new Promise((r) => setTimeout(r, 200));
    expect(testServer.requests.length).toBe(0);
  });

  it('does not start OTLP push when otlp is undefined', async () => {
    const config: MetricsConfig = { enabled: true };
    initMetrics(config);

    await new Promise((r) => setTimeout(r, 200));
    expect(testServer.requests.length).toBe(0);
  });

  it('shutdownMetrics stops OTLP push interval and flushes', async () => {
    const config: MetricsConfig = {
      enabled: true,
      otlp: {
        enabled: true,
        endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
        interval_ms: 60000, // very long — won't fire during test
      },
    };

    initMetrics(config);
    recordIssueFixed();

    // No pushes yet
    expect(testServer.requests.length).toBe(0);

    shutdownMetrics();

    // Flush should have sent a push
    await vi.waitFor(
      () => {
        expect(testServer.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );
  });

  it('shutdownMetrics when not initialized is a no-op', () => {
    // Should not throw
    expect(() => shutdownMetrics()).not.toThrow();
  });

  it('calling initMetrics multiple times reinitializes cleanly', async () => {
    const config1: MetricsConfig = {
      enabled: true,
      otlp: {
        enabled: true,
        endpoint: `http://127.0.0.1:${testServer.port()}/v1/metrics`,
        interval_ms: 50,
      },
    };

    initMetrics(config1);

    await vi.waitFor(
      () => {
        expect(testServer.requests.length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000 },
    );

    // Reinitialize with OTLP disabled
    const config2: MetricsConfig = {
      enabled: true,
      otlp: { enabled: false, interval_ms: 50 },
    };

    initMetrics(config2);

    // Wait and ensure no new requests (old exporter was stopped)
    await new Promise((r) => setTimeout(r, 200));

    // There may be one flush from shutting down the old exporter, but no ongoing pushes
    const countAfterReinit = testServer.requests.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(testServer.requests.length).toBe(countAfterReinit);
  });

  it('reinitializing resets the registry state', () => {
    initMetrics({ enabled: true });
    recordIssueFixed();
    recordIssueFixed();
    expect(serialize()).toContain('kova_issues_fixed_total 2');

    // Reinitialize — should reset
    initMetrics({ enabled: true });
    expect(serialize()).toContain('kova_issues_fixed_total 0');
  });
});
