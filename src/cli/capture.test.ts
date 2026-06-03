// Tests for the `kova capture` command. We test the pure formatting/filter
// layer directly (no real HTTP) and exercise the HTTP path via a small
// in-process server + EventBus in src/services/webhook-server.test.ts.
//
// Issue: kova#295.

import { describe, expect, it } from 'vitest';
import { EventBus } from '../services/event-bus/bus.js';
import type { KovaEvent, KovaEventInput } from '../services/event-bus/schema.js';
import { filterCaptureEvents, formatCaptureLine, runCaptureFromSnapshot } from './capture.js';

function publishWave(bus: EventBus, fixId: string, wave: 'assess' | 'spec' | 'impl', turn = 0): KovaEvent {
  const input: KovaEventInput = {
    runId: 'run-1',
    repoId: 'orrinfrazier/kova',
    fixId,
    type: 'wave-output',
    wave,
    turn,
    text: `output:${wave}:${turn}`,
  };
  return bus.publish(input);
}

function publishWaveEnter(bus: EventBus, fixId: string, wave: 'assess' | 'spec' | 'impl'): KovaEvent {
  return bus.publish({
    runId: 'run-1',
    repoId: 'orrinfrazier/kova',
    fixId,
    type: 'wave-enter',
    wave,
  });
}

function publishFixStarted(bus: EventBus, fixId: string): KovaEvent {
  return bus.publish({
    runId: 'run-1',
    repoId: 'orrinfrazier/kova',
    fixId,
    type: 'fix-started',
    issueNumber: 295,
  });
}

describe('filterCaptureEvents', () => {
  it('returns the whole snapshot when no filter is set', () => {
    const bus = new EventBus();
    publishFixStarted(bus, 'A');
    publishWaveEnter(bus, 'A', 'assess');
    publishWave(bus, 'A', 'assess', 0);
    publishWave(bus, 'A', 'impl', 1);
    const snap = bus.snapshot('A');
    expect(filterCaptureEvents(snap, {}).length).toBe(4);
  });

  it('--wave filters by wave name (keeps lifecycle events without a wave field)', () => {
    const bus = new EventBus();
    publishFixStarted(bus, 'A'); // no wave field
    publishWaveEnter(bus, 'A', 'assess');
    publishWave(bus, 'A', 'assess', 0);
    publishWave(bus, 'A', 'impl', 1);
    const snap = bus.snapshot('A');
    const filtered = filterCaptureEvents(snap, { wave: 'impl' });
    // fix-started is lifecycle (no wave field) — kept as anchor context.
    // wave-enter/wave-output for 'assess' are filtered out; 'impl' kept.
    const types = filtered.map((e) => `${e.type}:${'wave' in e ? e.wave : '-'}`);
    expect(types).toEqual(['fix-started:-', 'wave-output:impl']);
  });

  it('--lines N keeps only the last N events after filter', () => {
    const bus = new EventBus();
    for (let i = 0; i < 10; i++) {
      publishWave(bus, 'A', 'impl', i);
    }
    const snap = bus.snapshot('A');
    const filtered = filterCaptureEvents(snap, { lines: 3 });
    expect(filtered.length).toBe(3);
    expect(filtered.map((e) => ('turn' in e ? e.turn : -1))).toEqual([7, 8, 9]);
  });

  it('--wave + --lines compose: lines applied after wave filter', () => {
    const bus = new EventBus();
    publishWave(bus, 'A', 'assess', 0);
    publishWave(bus, 'A', 'impl', 0);
    publishWave(bus, 'A', 'assess', 1);
    publishWave(bus, 'A', 'impl', 1);
    publishWave(bus, 'A', 'assess', 2);
    publishWave(bus, 'A', 'impl', 2);
    const snap = bus.snapshot('A');
    const filtered = filterCaptureEvents(snap, { wave: 'impl', lines: 2 });
    expect(filtered.map((e) => ('turn' in e ? e.turn : -1))).toEqual([1, 2]);
  });
});

describe('formatCaptureLine', () => {
  it('emits one compact JSON line per event', () => {
    const bus = new EventBus();
    const ev = publishWave(bus, 'A', 'impl', 7);
    const line = formatCaptureLine(ev);
    expect(line.endsWith('\n')).toBe(false);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.type).toBe('wave-output');
    expect(parsed.fixId).toBe('A');
    expect(parsed.turn).toBe(7);
  });
});

describe('runCaptureFromSnapshot', () => {
  it('prints filtered events to the provided write sink', () => {
    const bus = new EventBus();
    publishFixStarted(bus, 'A');
    publishWaveEnter(bus, 'A', 'assess');
    publishWave(bus, 'A', 'assess', 0);
    publishWave(bus, 'A', 'impl', 1);
    const out: string[] = [];
    runCaptureFromSnapshot(bus.snapshot('A'), { wave: 'impl' }, (chunk) => {
      out.push(chunk);
    });
    // One line per kept event (fix-started + wave-output:impl)
    expect(out.length).toBe(2);
    expect(out.every((c) => c.endsWith('\n'))).toBe(true);
  });

  it('prints nothing (and exits cleanly) for an empty snapshot', () => {
    const out: string[] = [];
    runCaptureFromSnapshot([], {}, (chunk) => out.push(chunk));
    expect(out).toEqual([]);
  });
});
