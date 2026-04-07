import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainstormIssue } from '../types/index.js';
import { appendCycle, detectDiminishingReturns, loadHistory, titleSimilarity } from './brainstorm-history.js';

function makeIssue(title: string, category = 'enhancement' as const): BrainstormIssue {
  return {
    title,
    body: 'test body',
    labels: [],
    priority: 'medium',
    category,
    confidence: 0.8,
  };
}

// --- titleSimilarity ---

describe('titleSimilarity', () => {
  it('returns 1.0 for identical titles', () => {
    expect(titleSimilarity('Add input validation', 'Add input validation')).toBe(1);
  });

  it('returns 1.0 for case-insensitive match', () => {
    expect(titleSimilarity('Add Input Validation', 'add input validation')).toBe(1);
  });

  it('returns 0 for completely different titles', () => {
    expect(titleSimilarity('Fix login bug', 'Upgrade database schema')).toBe(0);
  });

  it('returns partial overlap for similar titles', () => {
    const score = titleSimilarity('Add input validation to API', 'Add input validation to forms');
    // 4 shared words out of 6 unique words → ~0.67
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(1);
  });

  it('returns 0 when both titles are empty', () => {
    expect(titleSimilarity('', '')).toBe(0);
  });
});

// --- loadHistory / appendCycle ---

describe('brainstorm history persistence', () => {
  let repoPath: string;

  beforeEach(async () => {
    repoPath = await mkdtemp(join(tmpdir(), 'kova-hist-'));
  });

  afterEach(async () => {
    await rm(repoPath, { recursive: true, force: true });
  });

  it('loadHistory returns empty cycles when no history file exists', async () => {
    const history = await loadHistory(repoPath);
    expect(history.cycles).toEqual([]);
  });

  it('appendCycle creates history file and stores cycle', async () => {
    await appendCycle(repoPath, {
      timestamp: '2026-04-07T00:00:00.000Z',
      issues: [{ title: 'Fix bug', category: 'bug' }],
    });

    const history = await loadHistory(repoPath);
    expect(history.cycles).toHaveLength(1);
    expect(history.cycles[0]?.issues[0]?.title).toBe('Fix bug');
  });

  it('appendCycle appends to existing history', async () => {
    await appendCycle(repoPath, {
      timestamp: '2026-04-07T00:00:00.000Z',
      issues: [{ title: 'First issue', category: 'bug' }],
    });
    await appendCycle(repoPath, {
      timestamp: '2026-04-07T01:00:00.000Z',
      issues: [{ title: 'Second issue', category: 'enhancement' }],
    });

    const history = await loadHistory(repoPath);
    expect(history.cycles).toHaveLength(2);
  });

  it('history file is valid JSON', async () => {
    await appendCycle(repoPath, {
      timestamp: '2026-04-07T00:00:00.000Z',
      issues: [{ title: 'Test', category: 'bug' }],
    });

    const raw = await readFile(join(repoPath, '.kova', 'brainstorm-history.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// --- detectDiminishingReturns ---

describe('detectDiminishingReturns', () => {
  it('reports 0% overlap when history is empty', () => {
    const report = detectDiminishingReturns([makeIssue('Add validation'), makeIssue('Fix login')], { cycles: [] });

    expect(report.overlapPercent).toBe(0);
    expect(report.novelCount).toBe(2);
    expect(report.isStale).toBe(false);
    expect(report.shouldStop).toBe(false);
    expect(report.novelIssues).toHaveLength(2);
    expect(report.duplicateIssues).toHaveLength(0);
  });

  it('detects exact title duplicates from previous cycle', () => {
    const report = detectDiminishingReturns([makeIssue('Add validation'), makeIssue('Fix login')], {
      cycles: [
        {
          timestamp: '2026-04-06T00:00:00.000Z',
          issues: [{ title: 'Add validation', category: 'enhancement' }],
        },
      ],
    });

    expect(report.overlapPercent).toBe(50);
    expect(report.novelCount).toBe(1);
    expect(report.duplicateIssues).toContain('Add validation');
    expect(report.novelIssues).toContain('Fix login');
  });

  it('detects similar (not exact) titles as duplicates', () => {
    const report = detectDiminishingReturns([makeIssue('Add input validation to API endpoints')], {
      cycles: [
        {
          timestamp: '2026-04-06T00:00:00.000Z',
          issues: [{ title: 'Add input validation to API', category: 'enhancement' }],
        },
      ],
    });

    // High similarity (4/5 words overlap) → should count as duplicate
    expect(report.overlapPercent).toBe(100);
    expect(report.novelCount).toBe(0);
  });

  it('sets isStale when overlap exceeds 50%', () => {
    const report = detectDiminishingReturns([makeIssue('Issue A'), makeIssue('Issue B'), makeIssue('Issue C')], {
      cycles: [
        {
          timestamp: '2026-04-06T00:00:00.000Z',
          issues: [
            { title: 'Issue A', category: 'bug' },
            { title: 'Issue B', category: 'bug' },
          ],
        },
      ],
    });

    // 2 of 3 overlap → ~67%
    expect(report.isStale).toBe(true);
    expect(report.overlapPercent).toBeGreaterThan(50);
  });

  it('sets shouldStop when fewer than 2 novel issues', () => {
    const report = detectDiminishingReturns(
      [makeIssue('Old issue A'), makeIssue('Old issue B'), makeIssue('One new thing')],
      {
        cycles: [
          {
            timestamp: '2026-04-06T00:00:00.000Z',
            issues: [
              { title: 'Old issue A', category: 'bug' },
              { title: 'Old issue B', category: 'bug' },
            ],
          },
        ],
      },
    );

    expect(report.novelCount).toBe(1);
    expect(report.shouldStop).toBe(true);
  });

  it('compares against all historical cycles, not just the last', () => {
    const report = detectDiminishingReturns(
      [makeIssue('From cycle 1'), makeIssue('From cycle 2'), makeIssue('Brand new')],
      {
        cycles: [
          {
            timestamp: '2026-04-05T00:00:00.000Z',
            issues: [{ title: 'From cycle 1', category: 'bug' }],
          },
          {
            timestamp: '2026-04-06T00:00:00.000Z',
            issues: [{ title: 'From cycle 2', category: 'bug' }],
          },
        ],
      },
    );

    expect(report.overlapPercent).toBeGreaterThan(50);
    expect(report.novelCount).toBe(1);
    expect(report.duplicateIssues).toContain('From cycle 1');
    expect(report.duplicateIssues).toContain('From cycle 2');
  });

  it('handles empty new issues array', () => {
    const report = detectDiminishingReturns([], { cycles: [] });
    expect(report.overlapPercent).toBe(0);
    expect(report.novelCount).toBe(0);
    expect(report.shouldStop).toBe(true);
  });
});
