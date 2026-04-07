// OTLP HTTP JSON push exporter for metrics.
// Zero external dependencies — uses node:http / node:https only.

import http from 'node:http';
import https from 'node:https';
import { log } from '../utils/logger.js';
import type { MetricsRegistry } from './metrics.js';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export interface OtlpExporterOptions {
  endpoint: string;
  intervalMs: number;
  registry: MetricsRegistry;
}

export interface OtlpExporter {
  /** Stops the push interval. Sends one final flush. */
  readonly _interval: ReturnType<typeof setInterval>;
  readonly _registry: MetricsRegistry;
  readonly _endpoint: string;
}

/* ------------------------------------------------------------------ */
/*  OTLP JSON payload builders                                          */
/* ------------------------------------------------------------------ */

interface OtlpAttribute {
  key: string;
  value: { stringValue: string };
}

interface OtlpNumberDataPoint {
  asDouble: number;
  timeUnixNano: string;
}

interface OtlpMetric {
  name: string;
  description: string;
  unit: string;
  sum?: {
    dataPoints: OtlpNumberDataPoint[];
    aggregationTemporality: number;
    isMonotonic: boolean;
  };
  gauge?: {
    dataPoints: OtlpNumberDataPoint[];
  };
}

interface OtlpPayload {
  resourceMetrics: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeMetrics: Array<{
      scope: { name: string };
      metrics: OtlpMetric[];
    }>;
  }>;
}

/**
 * Build OTLP JSON payload from the Prometheus text output of a MetricsRegistry.
 * We parse the text serialization to extract metric values, then wrap them
 * in the OTLP resourceMetrics structure.
 */
function buildOtlpPayload(registry: MetricsRegistry): OtlpPayload {
  const text = registry.serialize();
  const metrics: OtlpMetric[] = [];
  const nowNano = `${Date.now()}000000`;

  const lines = text.split('\n');
  let currentHelp = '';
  let currentType = '';

  for (const line of lines) {
    if (line.startsWith('# HELP ')) {
      const rest = line.slice(7);
      const spaceIdx = rest.indexOf(' ');
      currentHelp = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : '';
      continue;
    }

    if (line.startsWith('# TYPE ')) {
      const rest = line.slice(7);
      const spaceIdx = rest.indexOf(' ');
      currentType = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : '';
      continue;
    }

    if (line === '' || line.startsWith('#')) continue;

    // Skip histogram bucket/sum/count sub-lines — we treat histogram as a special case
    if (
      line.includes('_bucket{') ||
      line.endsWith('_sum') ||
      line.includes('_sum ') ||
      line.endsWith('_count') ||
      line.includes('_count ')
    ) {
      continue;
    }

    // Parse metric line: "name{labels} value" or "name value"
    const braceIdx = line.indexOf('{');
    let name: string;
    let valueStr: string;

    if (braceIdx >= 0) {
      // Labeled metric
      const closeBrace = line.indexOf('}');
      name = line.slice(0, braceIdx);
      valueStr = line.slice(closeBrace + 2);
    } else {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx < 0) continue;
      name = line.slice(0, spaceIdx);
      valueStr = line.slice(spaceIdx + 1);
    }

    const value = Number.parseFloat(valueStr);
    if (Number.isNaN(value)) continue;

    const dataPoint: OtlpNumberDataPoint = {
      asDouble: value,
      timeUnixNano: nowNano,
    };

    if (currentType === 'counter') {
      metrics.push({
        name,
        description: currentHelp,
        unit: '',
        sum: {
          dataPoints: [dataPoint],
          aggregationTemporality: 2, // CUMULATIVE
          isMonotonic: true,
        },
      });
    } else if (currentType === 'gauge') {
      metrics.push({
        name,
        description: currentHelp,
        unit: '',
        gauge: { dataPoints: [dataPoint] },
      });
    }
    // Histograms are skipped for now — the text serialization handles bucket lines
  }

  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [{ key: 'service.name', value: { stringValue: 'kova' } }],
        },
        scopeMetrics: [
          {
            scope: { name: 'kova' },
            metrics,
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  HTTP push                                                           */
/* ------------------------------------------------------------------ */

function pushMetrics(endpoint: string, registry: MetricsRegistry): void {
  const payload = JSON.stringify(buildOtlpPayload(registry));
  const url = new URL(endpoint);

  const transport = url.protocol === 'https:' ? https : http;
  const options: http.RequestOptions = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    },
  };

  const req = transport.request(options, (res) => {
    // Drain the response body to avoid memory leaks
    res.resume();
    if (res.statusCode !== undefined && res.statusCode >= 400) {
      log.warn(`OTLP push failed: HTTP ${res.statusCode}`);
    }
  });

  req.on('error', (err) => {
    log.warn(`OTLP push error: ${err.message}`);
  });

  req.write(payload);
  req.end();
}

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

export function createOtlpExporter(options: OtlpExporterOptions): OtlpExporter {
  const { endpoint, intervalMs, registry } = options;

  const interval = setInterval(() => {
    pushMetrics(endpoint, registry);
  }, intervalMs);

  // Unref so the interval doesn't prevent Node from exiting
  interval.unref();

  return {
    _interval: interval,
    _registry: registry,
    _endpoint: endpoint,
  };
}

export function stopOtlpExporter(exporter: OtlpExporter): void {
  clearInterval(exporter._interval);
  // Fire one final flush
  pushMetrics(exporter._endpoint, exporter._registry);
}
