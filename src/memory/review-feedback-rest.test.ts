import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EpisodicMemoryConfig } from '../types/config.js';
import {
  classifyFeedback,
  formatReviewFeedback,
  queryReviewFeedbackContext,
  recordReviewFeedback,
} from './review-feedback-rest.js';

let tmpRoot: string | null = null;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'kova-feedback-rest-'));
});

afterEach(() => {
  if (tmpRoot && existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

function getTmp(): string {
  if (!tmpRoot) throw new Error('tmpRoot not initialised');
  return tmpRoot;
}

function makeEpisodeConfig(overrides?: Partial<EpisodicMemoryConfig>): EpisodicMemoryConfig {
  return {
    enabled: true,
    max_episodes: 3,
    cross_repo: true,
    same_repo_weight: 1.5,
    language_filter: true,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  classifyFeedback                                                   */
/* ------------------------------------------------------------------ */

describe('classifyFeedback', () => {
  it('classifies "test" keyword as missing_test', () => {
    expect(classifyFeedback('You should add a test for this')).toBe('missing_test');
  });

  it('classifies "security" keyword as security_concern', () => {
    expect(classifyFeedback('This has a security vulnerability')).toBe('security_concern');
  });

  it('classifies "injection" keyword as security_concern', () => {
    expect(classifyFeedback('SQL injection risk here')).toBe('security_concern');
  });

  it('classifies "auth" keyword as security_concern', () => {
    expect(classifyFeedback('The auth check is missing')).toBe('security_concern');
  });

  it('classifies "style" keyword as style_issue', () => {
    expect(classifyFeedback('This is a style concern')).toBe('style_issue');
  });

  it('classifies "format" keyword as style_issue', () => {
    expect(classifyFeedback('The format is inconsistent')).toBe('style_issue');
  });

  it('classifies "logic" keyword as logic_error', () => {
    expect(classifyFeedback('There is a logic error in this branch')).toBe('logic_error');
  });

  it('classifies "bug" keyword as logic_error', () => {
    expect(classifyFeedback('This is a bug')).toBe('logic_error');
  });

  it('classifies "incorrect" keyword as logic_error', () => {
    expect(classifyFeedback('The result is incorrect')).toBe('logic_error');
  });

  it('classifies "wrong" keyword as logic_error', () => {
    expect(classifyFeedback('This value is wrong')).toBe('logic_error');
  });

  it('classifies "performance" keyword as performance', () => {
    expect(classifyFeedback('This has a performance issue')).toBe('performance');
  });

  it('classifies "slow" keyword as performance', () => {
    expect(classifyFeedback('This query is slow')).toBe('performance');
  });

  it('classifies "memory" keyword as performance', () => {
    expect(classifyFeedback('High memory usage detected')).toBe('performance');
  });

  it('classifies "naming" keyword as naming', () => {
    expect(classifyFeedback('The naming convention is wrong here')).toBe('naming');
  });

  it('classifies "rename" keyword as naming', () => {
    expect(classifyFeedback('You should rename this variable')).toBe('naming');
  });

  it('classifies "architecture" keyword as architecture', () => {
    expect(classifyFeedback('The architecture needs rethinking')).toBe('architecture');
  });

  it('classifies "structure" keyword as architecture', () => {
    expect(classifyFeedback('The structure is wrong')).toBe('architecture');
  });

  it('classifies "pattern" keyword as architecture', () => {
    expect(classifyFeedback('Use a different pattern here')).toBe('architecture');
  });

  it('classifies "doc" keyword as documentation', () => {
    expect(classifyFeedback('Add a doc comment here')).toBe('documentation');
  });

  it('classifies "comment" keyword as documentation', () => {
    expect(classifyFeedback('This needs a comment')).toBe('documentation');
  });

  it('classifies "readme" keyword as documentation', () => {
    expect(classifyFeedback('Update the readme')).toBe('documentation');
  });

  it('defaults to style_issue for unrecognized text', () => {
    expect(classifyFeedback('I have some general thoughts about this')).toBe('style_issue');
  });
});

/* ------------------------------------------------------------------ */
/*  recordReviewFeedback                                               */
/* ------------------------------------------------------------------ */

describe('recordReviewFeedback / queryReviewFeedbackContext (sqlite-vec)', () => {
  const sampleFeedback = [
    {
      repo: 'test-repo',
      pr_number: 42,
      feedback_type: 'style_issue' as const,
      comment_text: 'always use const here for readability',
      file_path: 'src/auth.ts',
      author: 'alice',
    },
  ];

  it('persists records and surfaces them on query', async () => {
    const ok = await recordReviewFeedback(makeEpisodeConfig(), sampleFeedback, getTmp());
    expect(ok).toBe(true);
    const results = await queryReviewFeedbackContext(
      makeEpisodeConfig(),
      'always use const here for readability',
      'test-repo',
      getTmp(),
    );
    expect(results.length).toBe(1);
    expect(results[0]?.comment_text).toContain('const');
    expect(results[0]?.file_path).toBe('src/auth.ts');
  });

  it('record returns false when disabled', async () => {
    const result = await recordReviewFeedback(makeEpisodeConfig({ enabled: false }), sampleFeedback, getTmp());
    expect(result).toBe(false);
  });

  it('record returns false when workDir missing', async () => {
    const result = await recordReviewFeedback(makeEpisodeConfig(), sampleFeedback);
    expect(result).toBe(false);
  });

  it('query returns [] when disabled', async () => {
    const result = await queryReviewFeedbackContext(makeEpisodeConfig({ enabled: false }), 'q', undefined, getTmp());
    expect(result).toEqual([]);
  });

  it('query returns [] when workDir missing', async () => {
    const result = await queryReviewFeedbackContext(makeEpisodeConfig(), 'q', undefined);
    expect(result).toEqual([]);
  });

  it('query filters by repo when provided', async () => {
    const base = sampleFeedback[0];
    if (!base) throw new Error('sample fixture missing');
    await recordReviewFeedback(
      makeEpisodeConfig(),
      [
        { ...base, repo: 'org/a', pr_number: 1 },
        { ...base, repo: 'org/b', pr_number: 2 },
      ],
      getTmp(),
    );
    const results = await queryReviewFeedbackContext(
      makeEpisodeConfig(),
      'always use const here for readability',
      'org/a',
      getTmp(),
    );
    expect(results.every((r) => r.pr_number === 1)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  formatReviewFeedback                                               */
/* ------------------------------------------------------------------ */

describe('formatReviewFeedback', () => {
  it('formats multiple feedback items as markdown', () => {
    const feedback = [
      {
        feedback_type: 'style_issue',
        pr_number: 42,
        comment_text: 'Use const',
        file_path: 'src/auth.ts',
      },
      {
        feedback_type: 'logic_error',
        pr_number: 99,
        comment_text: 'Off-by-one in loop',
        file_path: 'src/parser.ts',
      },
    ];
    const result = formatReviewFeedback(feedback);
    expect(result).toContain('## Past reviewer feedback');
    expect(result).toContain('[style_issue]');
    expect(result).toContain('PR #42');
    expect(result).toContain('"Use const"');
    expect(result).toContain('file: src/auth.ts');
    expect(result).toContain('[logic_error]');
    expect(result).toContain('PR #99');
    expect(result).toContain('"Off-by-one in loop"');
    expect(result).toContain('file: src/parser.ts');
  });

  it('returns empty string for empty array', () => {
    expect(formatReviewFeedback([])).toBe('');
  });
});
