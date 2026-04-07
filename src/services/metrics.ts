// Metrics registry — defines all counters, gauges, and histograms.
// Central place for recording metric events.
// Serializes to Prometheus text exposition format.
// Also provides initMetrics / shutdownMetrics for lifecycle management + OTLP push.

import type { MetricsConfig, WaveName } from '../types/index.js';
import { createOtlpExporter, type OtlpExporter, stopOtlpExporter } from './metrics-otlp.js';

// ---------------------------------------------------------------------------
// Bucket definitions
// ---------------------------------------------------------------------------

const DURATION_BUCKETS = [100, 500, 1000, 5000, 10000, 30000, 60000, 120000, 300000];
const COST_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];

// ---------------------------------------------------------------------------
// Internal metric data structures
// ---------------------------------------------------------------------------

interface CounterData {
  value: number;
}

interface LabeledCounterData {
  values: Map<string, number>;
}

interface GaugeData {
  value: number;
}

interface HistogramData {
  sum: number;
  count: number;
  buckets: number[]; // parallel to bucket boundaries, counts observations <= bound
}

interface LabeledHistogramData {
  entries: Map<string, HistogramData>;
  bucketBounds: number[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface MetricsRegistryOptions {
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// MetricsRegistry class
// ---------------------------------------------------------------------------

export class MetricsRegistry {
  private readonly enabled: boolean;

  // Counters (no labels)
  private issuesFixed: CounterData;
  private issuesFailed: CounterData;
  private prsCreated: CounterData;

  // Counter with wave label
  private wavesCompleted: LabeledCounterData;

  // Gauges
  private currentCostUsd: GaugeData;
  private activeFixes: GaugeData;

  // Histograms (labeled by wave)
  private waveDurationMs: LabeledHistogramData;

  // Histograms (no labels)
  private fixDurationMs: HistogramData;
  private costPerFixUsd: HistogramData;

  constructor(options: MetricsRegistryOptions) {
    this.enabled = options.enabled;
    this.issuesFixed = { value: 0 };
    this.issuesFailed = { value: 0 };
    this.prsCreated = { value: 0 };
    this.wavesCompleted = { values: new Map() };
    this.currentCostUsd = { value: 0 };
    this.activeFixes = { value: 0 };
    this.waveDurationMs = { entries: new Map(), bucketBounds: DURATION_BUCKETS };
    this.fixDurationMs = createHistogram(DURATION_BUCKETS);
    this.costPerFixUsd = createHistogram(COST_BUCKETS);
  }

  recordIssueFixed(): void {
    if (!this.enabled) return;
    this.issuesFixed.value += 1;
  }

  recordIssueFailed(): void {
    if (!this.enabled) return;
    this.issuesFailed.value += 1;
  }

  recordWaveCompleted(wave: WaveName | string): void {
    if (!this.enabled) return;
    const current = this.wavesCompleted.values.get(wave) ?? 0;
    this.wavesCompleted.values.set(wave, current + 1);
  }

  recordPRCreated(): void {
    if (!this.enabled) return;
    this.prsCreated.value += 1;
  }

  setCurrentCostUsd(value: number): void {
    if (!this.enabled) return;
    this.currentCostUsd.value = value;
  }

  setActiveFixes(value: number): void {
    if (!this.enabled) return;
    this.activeFixes.value = value;
  }

  recordWaveDuration(wave: WaveName | string, ms: number): void {
    if (!this.enabled) return;
    let entry = this.waveDurationMs.entries.get(wave);
    if (!entry) {
      entry = createHistogram(DURATION_BUCKETS);
      this.waveDurationMs.entries.set(wave, entry);
    }
    observeHistogram(entry, DURATION_BUCKETS, ms);
  }

  recordFixDuration(ms: number): void {
    if (!this.enabled) return;
    observeHistogram(this.fixDurationMs, DURATION_BUCKETS, ms);
  }

  recordFixCost(usd: number): void {
    if (!this.enabled) return;
    observeHistogram(this.costPerFixUsd, COST_BUCKETS, usd);
  }

  reset(): void {
    this.issuesFixed = { value: 0 };
    this.issuesFailed = { value: 0 };
    this.prsCreated = { value: 0 };
    this.wavesCompleted = { values: new Map() };
    this.currentCostUsd = { value: 0 };
    this.activeFixes = { value: 0 };
    this.waveDurationMs = { entries: new Map(), bucketBounds: DURATION_BUCKETS };
    this.fixDurationMs = createHistogram(DURATION_BUCKETS);
    this.costPerFixUsd = createHistogram(COST_BUCKETS);
  }

  serialize(): string {
    if (!this.enabled) return '';

    const lines: string[] = [];

    // Counters
    serializeCounter(lines, 'kova_issues_fixed_total', 'Total issues successfully fixed', this.issuesFixed.value);
    serializeCounter(lines, 'kova_issues_failed_total', 'Total issues that failed to fix', this.issuesFailed.value);
    serializeLabeledCounter(
      lines,
      'kova_waves_completed_total',
      'Total waves completed by wave name',
      this.wavesCompleted.values,
      'wave',
    );
    serializeCounter(lines, 'kova_prs_created_total', 'Total pull requests created', this.prsCreated.value);

    // Gauges
    serializeGauge(lines, 'kova_current_cost_usd', 'Current cumulative cost in USD', this.currentCostUsd.value);
    serializeGauge(lines, 'kova_active_fixes', 'Number of active fixes in progress', this.activeFixes.value);

    // Histograms
    serializeLabeledHistogram(
      lines,
      'kova_wave_duration_ms',
      'Wave execution duration in milliseconds',
      this.waveDurationMs,
      DURATION_BUCKETS,
      'wave',
    );
    serializeHistogram(
      lines,
      'kova_fix_duration_ms',
      'Fix execution duration in milliseconds',
      this.fixDurationMs,
      DURATION_BUCKETS,
    );
    serializeHistogram(lines, 'kova_cost_per_fix_usd', 'Cost per fix in USD', this.costPerFixUsd, COST_BUCKETS);

    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function createHistogram(bounds: number[]): HistogramData {
  return {
    sum: 0,
    count: 0,
    buckets: new Array<number>(bounds.length).fill(0),
  };
}

function observeHistogram(hist: HistogramData, bounds: number[], value: number): void {
  hist.sum += value;
  hist.count += 1;
  for (let i = 0; i < bounds.length; i++) {
    const bound = bounds[i];
    if (bound !== undefined && value <= bound) {
      hist.buckets[i] = (hist.buckets[i] ?? 0) + 1;
    }
  }
}

function serializeCounter(lines: string[], name: string, help: string, value: number): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} counter`);
  lines.push(`${name} ${value}`);
}

/** Escape a label value per Prometheus text exposition format. */
function escapeLabelValue(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function serializeLabeledCounter(
  lines: string[],
  name: string,
  help: string,
  values: Map<string, number>,
  labelKey: string,
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} counter`);
  for (const [labelVal, count] of values.entries()) {
    lines.push(`${name}{${labelKey}="${escapeLabelValue(labelVal)}"} ${count}`);
  }
}

function serializeGauge(lines: string[], name: string, help: string, value: number): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  lines.push(`${name} ${value}`);
}

function serializeHistogram(lines: string[], name: string, help: string, hist: HistogramData, bounds: number[]): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);
  let cumulative = 0;
  for (let i = 0; i < bounds.length; i++) {
    cumulative += hist.buckets[i] ?? 0;
    lines.push(`${name}_bucket{le="${bounds[i]}"} ${cumulative}`);
  }
  // +Inf bucket
  lines.push(`${name}_bucket{le="+Inf"} ${hist.count}`);
  lines.push(`${name}_sum ${hist.sum}`);
  lines.push(`${name}_count ${hist.count}`);
}

function serializeLabeledHistogram(
  lines: string[],
  name: string,
  help: string,
  labeled: LabeledHistogramData,
  bounds: number[],
  labelKey: string,
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);
  for (const [labelVal, hist] of labeled.entries.entries()) {
    const escaped = escapeLabelValue(labelVal);
    let cumulative = 0;
    for (let i = 0; i < bounds.length; i++) {
      cumulative += hist.buckets[i] ?? 0;
      lines.push(`${name}_bucket{${labelKey}="${escaped}",le="${bounds[i]}"} ${cumulative}`);
    }
    lines.push(`${name}_bucket{${labelKey}="${escaped}",le="+Inf"} ${hist.count}`);
    lines.push(`${name}_sum{${labelKey}="${escaped}"} ${hist.sum}`);
    lines.push(`${name}_count{${labelKey}="${escaped}"} ${hist.count}`);
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _defaultRegistry = new MetricsRegistry({ enabled: true });
let _otlpExporter: OtlpExporter | undefined;

export function reset(): void {
  _defaultRegistry = new MetricsRegistry({ enabled: true });
}

// ---------------------------------------------------------------------------
// Lifecycle: initMetrics / shutdownMetrics
// ---------------------------------------------------------------------------

/**
 * Initialize the metrics subsystem from config.
 * - undefined or enabled:false → metrics disabled (serialize returns '')
 * - enabled:true → metrics enabled
 * - otlp.enabled:true → starts periodic OTLP HTTP push
 *
 * Calling multiple times reinitializes cleanly (stops previous OTLP exporter).
 */
export function initMetrics(config: MetricsConfig | undefined): void {
  // Tear down any existing OTLP exporter
  if (_otlpExporter) {
    stopOtlpExporter(_otlpExporter);
    _otlpExporter = undefined;
  }

  const enabled = config?.enabled ?? false;
  _defaultRegistry = new MetricsRegistry({ enabled });

  if (enabled && config?.otlp?.enabled && config.otlp.endpoint) {
    _otlpExporter = createOtlpExporter({
      endpoint: config.otlp.endpoint,
      intervalMs: config.otlp.interval_ms ?? 15000,
      registry: _defaultRegistry,
    });
  }
}

/**
 * Shut down the metrics subsystem.
 * Stops OTLP push interval and flushes one final push.
 * No-op if not initialized.
 */
export function shutdownMetrics(): void {
  if (_otlpExporter) {
    stopOtlpExporter(_otlpExporter);
    _otlpExporter = undefined;
  }
}

export function serialize(): string {
  return _defaultRegistry.serialize();
}

export function recordIssueFixed(): void {
  _defaultRegistry.recordIssueFixed();
}

export function recordIssueFailed(): void {
  _defaultRegistry.recordIssueFailed();
}

export function recordWaveCompleted(wave: WaveName): void {
  _defaultRegistry.recordWaveCompleted(wave);
}

export function recordPRCreated(): void {
  _defaultRegistry.recordPRCreated();
}

export function setCurrentCostUsd(value: number): void {
  _defaultRegistry.setCurrentCostUsd(value);
}

export function setActiveFixes(value: number): void {
  _defaultRegistry.setActiveFixes(value);
}

export function recordWaveDuration(wave: WaveName, ms: number): void {
  _defaultRegistry.recordWaveDuration(wave, ms);
}

export function recordFixDuration(ms: number): void {
  _defaultRegistry.recordFixDuration(ms);
}

export function recordFixCost(usd: number): void {
  _defaultRegistry.recordFixCost(usd);
}
