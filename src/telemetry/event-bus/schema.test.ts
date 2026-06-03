import { describe, expect, it } from 'vitest';
import { type KovaEvent, KovaEventSchema } from './schema.js';

describe('KovaEventSchema', () => {
  const base = {
    runId: 'run-1',
    repoId: 'orrinfrazier/kova',
    fixId: 'fix-292',
    timestamp: '2026-06-01T12:00:00.000Z',
    seq: 0,
  };

  it('parses fix-started event', () => {
    const ev = { ...base, type: 'fix-started', issueNumber: 292 };
    const parsed = KovaEventSchema.parse(ev);
    expect(parsed.type).toBe('fix-started');
  });

  it('parses wave-enter event', () => {
    const ev = { ...base, type: 'wave-enter', wave: 'assess' };
    const parsed = KovaEventSchema.parse(ev);
    expect(parsed.type).toBe('wave-enter');
    if (parsed.type === 'wave-enter') {
      expect(parsed.wave).toBe('assess');
    }
  });

  it('parses wave-output event with pieceId', () => {
    const ev = {
      ...base,
      type: 'wave-output',
      wave: 'impl',
      pieceId: 'piece-1',
      turn: 3,
      text: 'tool call: edit',
    };
    const parsed = KovaEventSchema.parse(ev);
    expect(parsed.type).toBe('wave-output');
    if (parsed.type === 'wave-output') {
      expect(parsed.turn).toBe(3);
      expect(parsed.pieceId).toBe('piece-1');
    }
  });

  it('parses cost event', () => {
    const ev = { ...base, type: 'cost', wave: 'impl', costUsd: 0.0123 };
    const parsed = KovaEventSchema.parse(ev);
    if (parsed.type === 'cost') {
      expect(parsed.costUsd).toBeCloseTo(0.0123);
    }
  });

  it('parses steered event', () => {
    const ev = {
      ...base,
      type: 'steered',
      wave: 'impl',
      tier: 'steer',
      usageRatio: 0.72,
    };
    const parsed = KovaEventSchema.parse(ev);
    expect(parsed.type).toBe('steered');
  });

  it('parses aborted event', () => {
    const ev = { ...base, type: 'aborted', wave: 'impl', reason: 'context_exhausted' };
    const parsed = KovaEventSchema.parse(ev);
    expect(parsed.type).toBe('aborted');
  });

  it('parses fix-done event', () => {
    const ev = { ...base, type: 'fix-done', outcome: 'done', totalCostUsd: 1.23 };
    const parsed = KovaEventSchema.parse(ev);
    expect(parsed.type).toBe('fix-done');
  });

  it('rejects event missing fixId', () => {
    const ev = { ...base, fixId: undefined, type: 'fix-started', issueNumber: 1 };
    expect(() => KovaEventSchema.parse(ev)).toThrow();
  });

  it('rejects unknown event type', () => {
    const ev = { ...base, type: 'unknown-event' };
    expect(() => KovaEventSchema.parse(ev)).toThrow();
  });

  it('type narrows via discriminated union', () => {
    const ev: KovaEvent = KovaEventSchema.parse({
      ...base,
      type: 'fix-done',
      outcome: 'failed',
      totalCostUsd: 0,
    });
    if (ev.type === 'fix-done') {
      // Should compile and not have wave field
      expect(ev.outcome).toBe('failed');
    }
  });
});
