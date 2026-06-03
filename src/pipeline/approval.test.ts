/**
 * Tests for approval.ts — interactive approval flow for brainstormed issues.
 *
 * Mocks @clack/prompts to simulate user interaction without a real TTY.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainstormIssue } from '../types/index.js';

/* ------------------------------------------------------------------ */
/*  Mock @clack/prompts                                                */
/* ------------------------------------------------------------------ */

const mockSelect = vi.fn();
const mockText = vi.fn();
const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockNote = vi.fn();
const mockIsCancel = vi.fn().mockReturnValue(false);

vi.mock('@clack/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  text: (...args: unknown[]) => mockText(...args),
  intro: (...args: unknown[]) => mockIntro(...args),
  outro: (...args: unknown[]) => mockOutro(...args),
  note: (...args: unknown[]) => mockNote(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
}));

const { approveIssues } = await import('./approval.js');

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const SAMPLE_ISSUES: BrainstormIssue[] = [
  {
    title: 'Add input validation',
    body: 'Several endpoints accept user input without validation.',
    labels: ['bug', 'security'],
    priority: 'high',
    category: 'security',
    confidence: 0.9,
  },
  {
    title: 'Refactor error handling',
    body: 'Error handling is copy-pasted across 5 files.',
    labels: ['tech-debt'],
    priority: 'medium',
    category: 'tech-debt',
    confidence: 0.8,
  },
  {
    title: 'Add dark mode support',
    body: 'Users want dark mode.',
    labels: ['enhancement'],
    priority: 'low',
    category: 'enhancement',
    confidence: 0.6,
  },
];

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

beforeEach(() => {
  mockSelect.mockReset();
  mockText.mockReset();
  mockIntro.mockReset();
  mockOutro.mockReset();
  mockNote.mockReset();
  mockIsCancel.mockReturnValue(false);
});

describe('approveIssues', () => {
  describe('auto-approve mode (--yes)', () => {
    it('approves all issues without prompting', async () => {
      const result = await approveIssues(SAMPLE_ISSUES, { autoApprove: true });

      expect(result.approved).toHaveLength(3);
      expect(result.approved[0]?.title).toBe('Add input validation');
      expect(result.rejected).toBe(0);
      expect(result.edited).toBe(0);
      expect(result.skipped).toBe(0);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('returns empty result for empty issues array', async () => {
      const result = await approveIssues([], { autoApprove: true });

      expect(result.approved).toHaveLength(0);
      expect(result.rejected).toBe(0);
    });
  });

  describe('interactive mode', () => {
    it('presents each issue and collects approve actions', async () => {
      mockSelect.mockResolvedValueOnce('approve');
      mockSelect.mockResolvedValueOnce('approve');
      mockSelect.mockResolvedValueOnce('approve');

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved).toHaveLength(3);
      expect(result.rejected).toBe(0);
      expect(mockSelect).toHaveBeenCalledTimes(3);
    });

    it('rejects issues when user selects reject', async () => {
      mockSelect.mockResolvedValueOnce('approve');
      mockSelect.mockResolvedValueOnce('reject');
      mockSelect.mockResolvedValueOnce('approve');

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved).toHaveLength(2);
      expect(result.rejected).toBe(1);
      expect(result.approved[0]?.title).toBe('Add input validation');
      expect(result.approved[1]?.title).toBe('Add dark mode support');
    });

    it('skips issues when user selects skip', async () => {
      mockSelect.mockResolvedValueOnce('skip');
      mockSelect.mockResolvedValueOnce('skip');
      mockSelect.mockResolvedValueOnce('approve');

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved).toHaveLength(1);
      expect(result.skipped).toBe(2);
    });

    it('allows editing title and body', async () => {
      mockSelect.mockResolvedValueOnce('edit');
      mockSelect.mockResolvedValueOnce('title');
      mockText.mockResolvedValueOnce('Updated validation title');
      mockSelect.mockResolvedValueOnce('approve');

      mockSelect.mockResolvedValueOnce('approve');
      mockSelect.mockResolvedValueOnce('approve');

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved).toHaveLength(3);
      expect(result.edited).toBe(1);
      expect(result.approved[0]?.title).toBe('Updated validation title');
    });

    it('allows editing body', async () => {
      mockSelect.mockResolvedValueOnce('edit');
      mockSelect.mockResolvedValueOnce('body');
      mockText.mockResolvedValueOnce('New body text');
      mockSelect.mockResolvedValueOnce('approve');

      mockSelect.mockResolvedValueOnce('reject');
      mockSelect.mockResolvedValueOnce('reject');

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved).toHaveLength(1);
      expect(result.approved[0]?.body).toBe('New body text');
      expect(result.edited).toBe(1);
    });

    it('allows editing priority', async () => {
      mockSelect.mockResolvedValueOnce('edit');
      mockSelect.mockResolvedValueOnce('priority');
      mockSelect.mockResolvedValueOnce('critical');
      mockSelect.mockResolvedValueOnce('approve');

      mockSelect.mockResolvedValueOnce('approve');
      mockSelect.mockResolvedValueOnce('approve');

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved[0]?.priority).toBe('critical');
      expect(result.edited).toBe(1);
    });

    it('handles cancel (Ctrl+C) gracefully', async () => {
      mockSelect.mockResolvedValueOnce('approve');
      const cancelSymbol = Symbol('cancel');
      mockSelect.mockResolvedValueOnce(cancelSymbol);
      mockIsCancel.mockImplementation((val) => val === cancelSymbol);

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved).toHaveLength(1);
      expect(result.cancelled).toBe(true);
    });

    it('supports multiple edits before approving', async () => {
      mockSelect.mockResolvedValueOnce('edit');
      mockSelect.mockResolvedValueOnce('title');
      mockText.mockResolvedValueOnce('New title');
      mockSelect.mockResolvedValueOnce('edit');
      mockSelect.mockResolvedValueOnce('body');
      mockText.mockResolvedValueOnce('New body');
      mockSelect.mockResolvedValueOnce('approve');

      mockSelect.mockResolvedValueOnce('reject');
      mockSelect.mockResolvedValueOnce('reject');

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved).toHaveLength(1);
      expect(result.approved[0]?.title).toBe('New title');
      expect(result.approved[0]?.body).toBe('New body');
      expect(result.edited).toBe(1);
    });

    it('does not mutate the original issues array', async () => {
      mockSelect.mockResolvedValueOnce('edit');
      mockSelect.mockResolvedValueOnce('title');
      mockText.mockResolvedValueOnce('Changed title');
      mockSelect.mockResolvedValueOnce('approve');

      mockSelect.mockResolvedValueOnce('approve');
      mockSelect.mockResolvedValueOnce('approve');

      const original = SAMPLE_ISSUES.map((i) => ({ ...i }));
      await approveIssues(SAMPLE_ISSUES);

      expect(SAMPLE_ISSUES[0]?.title).toBe(original[0]?.title);
    });
  });

  describe('summary counts', () => {
    it('tracks all action counts correctly', async () => {
      mockSelect.mockResolvedValueOnce('approve');
      mockSelect.mockResolvedValueOnce('reject');
      mockSelect.mockResolvedValueOnce('skip');

      const result = await approveIssues(SAMPLE_ISSUES);

      expect(result.approved).toHaveLength(1);
      expect(result.rejected).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.edited).toBe(0);
    });
  });
});
