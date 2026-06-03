import { describe, expect, it, vi } from 'vitest';
import { handleWebhookEvent } from './webhook-handler.js';

/* ------------------------------------------------------------------ */
/*  Realistic GitHub webhook payload factories                         */
/* ------------------------------------------------------------------ */

function makeIssuesPayload(overrides?: {
  action?: string;
  issueNumber?: number;
  labels?: Array<{ name: string }>;
}): Record<string, unknown> {
  const { action = 'labeled', issueNumber = 42, labels = [{ name: 'auto-fix' }] } = overrides ?? {};
  return {
    action,
    issue: {
      number: issueNumber,
      title: 'Fix the broken thing',
      body: 'Something is broken and needs fixing.',
      labels,
      html_url: `https://github.com/owner/repo/issues/${issueNumber}`,
    },
    label: labels[0] ?? { name: 'auto-fix' },
    repository: {
      full_name: 'owner/repo',
    },
    sender: {
      login: 'octocat',
    },
  };
}

function makeIssueCommentPayload(overrides?: {
  action?: string;
  issueNumber?: number;
  body?: string;
}): Record<string, unknown> {
  const { action = 'created', issueNumber = 99, body = '/kova fix' } = overrides ?? {};
  return {
    action,
    issue: {
      number: issueNumber,
      title: 'Some open issue',
      body: 'Issue description here.',
      labels: [],
      html_url: `https://github.com/owner/repo/issues/${issueNumber}`,
    },
    comment: {
      id: 123456,
      body,
      user: {
        login: 'collaborator',
      },
    },
    repository: {
      full_name: 'owner/repo',
    },
    sender: {
      login: 'collaborator',
    },
  };
}

/* ------------------------------------------------------------------ */
/*  issues event — labeled action                                      */
/* ------------------------------------------------------------------ */

describe('handleWebhookEvent — issues event', () => {
  it('enqueues a fix when labeled action + auto-fix label', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issues', makeIssuesPayload(), enqueue);

    expect(result.action).toBe('enqueued');
    expect(result.issueNumber).toBe(42);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(42);
  });

  it('returns the issue number in the result', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issues', makeIssuesPayload({ issueNumber: 123 }), enqueue);

    expect(result.issueNumber).toBe(123);
  });

  it('ignores issues event with unlabeled action', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issues', makeIssuesPayload({ action: 'unlabeled' }), enqueue);

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores issues event with opened action', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issues', makeIssuesPayload({ action: 'opened' }), enqueue);

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores issues event with closed action', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issues', makeIssuesPayload({ action: 'closed' }), enqueue);

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores labeled action when label is not auto-fix', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent(
      'issues',
      makeIssuesPayload({ action: 'labeled', labels: [{ name: 'bug' }] }),
      enqueue,
    );

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores labeled action when label is enhancement (not auto-fix)', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent(
      'issues',
      makeIssuesPayload({ action: 'labeled', labels: [{ name: 'enhancement' }] }),
      enqueue,
    );

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns duplicate when enqueue returns false (issue already pending)', () => {
    const enqueue = vi.fn().mockReturnValue(false);
    const result = handleWebhookEvent('issues', makeIssuesPayload(), enqueue);

    expect(result.action).toBe('duplicate');
    expect(result.issueNumber).toBe(42);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(42);
  });
});

/* ------------------------------------------------------------------ */
/*  issue_comment event                                                */
/* ------------------------------------------------------------------ */

describe('handleWebhookEvent — issue_comment event', () => {
  it('enqueues a fix when comment body is exactly /kova fix', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issue_comment', makeIssueCommentPayload(), enqueue);

    expect(result.action).toBe('enqueued');
    expect(result.issueNumber).toBe(99);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(99);
  });

  it('enqueues a fix when comment body starts with /kova fix followed by more text', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issue_comment', makeIssueCommentPayload({ body: '/kova fix please' }), enqueue);

    expect(result.action).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('enqueues a fix when comment body starts with /kova fix with trailing whitespace', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issue_comment', makeIssueCommentPayload({ body: '/kova fix  ' }), enqueue);

    expect(result.action).toBe('enqueued');
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it('ignores comment that does not start with /kova fix', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent(
      'issue_comment',
      makeIssueCommentPayload({ body: 'LGTM, please /kova fix this' }),
      enqueue,
    );

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores comment with body /kova (no fix subcommand)', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issue_comment', makeIssueCommentPayload({ body: '/kova' }), enqueue);

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores comment with empty body', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issue_comment', makeIssueCommentPayload({ body: '' }), enqueue);

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores issue_comment with deleted action', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent(
      'issue_comment',
      makeIssueCommentPayload({ action: 'deleted', body: '/kova fix' }),
      enqueue,
    );

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores issue_comment with edited action', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent(
      'issue_comment',
      makeIssueCommentPayload({ action: 'edited', body: '/kova fix' }),
      enqueue,
    );

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('returns duplicate when enqueue returns false (issue already pending)', () => {
    const enqueue = vi.fn().mockReturnValue(false);
    const result = handleWebhookEvent('issue_comment', makeIssueCommentPayload(), enqueue);

    expect(result.action).toBe('duplicate');
    expect(result.issueNumber).toBe(99);
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(99);
  });

  it('returns the correct issue number from the issue object', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('issue_comment', makeIssueCommentPayload({ issueNumber: 777 }), enqueue);

    expect(result.issueNumber).toBe(777);
    expect(enqueue).toHaveBeenCalledWith(777);
  });
});

/* ------------------------------------------------------------------ */
/*  Unrecognised / other event types                                   */
/* ------------------------------------------------------------------ */

describe('handleWebhookEvent — other event types', () => {
  it('ignores push event', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('push', { ref: 'refs/heads/main', commits: [] }, enqueue);

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores pull_request event', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('pull_request', { action: 'opened', number: 5 }, enqueue);

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores workflow_run event', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent(
      'workflow_run',
      { action: 'completed', workflow_run: { conclusion: 'success' } },
      enqueue,
    );

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('ignores ping event', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('ping', { zen: 'Design for failure.', hook_id: 1 }, enqueue);

    expect(result.action).toBe('ignored');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('provides a reason string for ignored events', () => {
    const enqueue = vi.fn().mockReturnValue(true);
    const result = handleWebhookEvent('push', { ref: 'refs/heads/main' }, enqueue);

    expect(result.action).toBe('ignored');
    expect(typeof result.reason).toBe('string');
    expect(result.reason?.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/*  Duplicate detection (delegated to queue via enqueue return value)  */
/* ------------------------------------------------------------------ */

describe('handleWebhookEvent — duplicate detection', () => {
  it('marks result as duplicate when issues enqueue returns false', () => {
    const enqueue = vi.fn().mockReturnValue(false);

    const result = handleWebhookEvent('issues', makeIssuesPayload({ issueNumber: 55 }), enqueue);

    expect(result.action).toBe('duplicate');
    expect(result.issueNumber).toBe(55);
  });

  it('marks result as duplicate when issue_comment enqueue returns false', () => {
    const enqueue = vi.fn().mockReturnValue(false);

    const result = handleWebhookEvent('issue_comment', makeIssueCommentPayload({ issueNumber: 66 }), enqueue);

    expect(result.action).toBe('duplicate');
    expect(result.issueNumber).toBe(66);
  });

  it('successive events for same issue: first enqueued, second duplicate', () => {
    // Simulate a real queue: first call succeeds, second returns false
    const enqueue = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);

    const payload = makeIssuesPayload({ issueNumber: 11 });

    const first = handleWebhookEvent('issues', payload, enqueue);
    const second = handleWebhookEvent('issues', payload, enqueue);

    expect(first.action).toBe('enqueued');
    expect(second.action).toBe('duplicate');
    expect(enqueue).toHaveBeenCalledTimes(2);
  });
});
