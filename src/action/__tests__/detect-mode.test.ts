import { describe, expect, it } from 'vitest';
import { type DetectedTrigger, type DetectModeConfig, detectMode } from '../detect-mode.js';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const DEFAULTS: DetectModeConfig = {
  trigger_phrase: '@kova',
  label_trigger: 'kova',
  assignee_trigger: 'kova-bot',
};

function issueLabeledEvent(label: string, issueNumber = 42): unknown {
  return {
    action: 'labeled',
    issue: { number: issueNumber, title: 'a bug', body: 'broken' },
    label: { name: label },
  };
}

function issueAssignedEvent(assignee: string, issueNumber = 42): unknown {
  return {
    action: 'assigned',
    issue: { number: issueNumber, title: 'a bug', body: 'broken' },
    assignee: { login: assignee },
  };
}

function issueCommentEvent(body: string, issueNumber = 42, action = 'created'): unknown {
  return {
    action,
    issue: { number: issueNumber, title: 'a bug', body: 'broken' },
    comment: { body },
  };
}

/* ------------------------------------------------------------------ */
/*  Explicit inputs take precedence                                    */
/* ------------------------------------------------------------------ */

describe('detectMode — explicit inputs', () => {
  it('returns explicit fix mode when issue_number is set, ignoring event', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: issueLabeledEvent('not-the-trigger'),
      config: DEFAULTS,
      explicit: { mode: 'fix', issue_number: '99' },
    });
    expect(result).toEqual<DetectedTrigger>({ mode: 'fix', issue_number: '99', source: 'explicit' });
  });

  it('returns explicit auto mode when no issue but mode passed', () => {
    const result = detectMode({
      eventName: 'workflow_dispatch',
      eventPayload: {},
      config: DEFAULTS,
      explicit: { mode: 'auto' },
    });
    expect(result).toEqual<DetectedTrigger>({ mode: 'auto', issue_number: undefined, source: 'explicit' });
  });

  it('returns explicit brainstorm when set', () => {
    const result = detectMode({
      eventName: 'schedule',
      eventPayload: {},
      config: DEFAULTS,
      explicit: { mode: 'brainstorm' },
    });
    expect(result).toEqual<DetectedTrigger>({ mode: 'brainstorm', issue_number: undefined, source: 'explicit' });
  });

  it('treats explicit "all: true" as a fix-all explicit trigger (no issue_number required)', () => {
    const result = detectMode({
      eventName: 'workflow_dispatch',
      eventPayload: {},
      config: DEFAULTS,
      explicit: { mode: 'fix', all: true },
    });
    expect(result).toEqual<DetectedTrigger>({ mode: 'fix', issue_number: undefined, source: 'explicit' });
  });
});

/* ------------------------------------------------------------------ */
/*  Label trigger                                                      */
/* ------------------------------------------------------------------ */

describe('detectMode — issues.labeled', () => {
  it('returns fix when the configured kova label is applied', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: issueLabeledEvent('kova', 7),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toEqual<DetectedTrigger>({ mode: 'fix', issue_number: '7', source: 'label' });
  });

  it('returns null when a different label is applied', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: issueLabeledEvent('bug'),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });

  it('returns null on labeled events when the label_trigger is empty', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: issueLabeledEvent('kova'),
      config: { ...DEFAULTS, label_trigger: '' },
      explicit: {},
    });
    expect(result).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Assignee trigger                                                   */
/* ------------------------------------------------------------------ */

describe('detectMode — issues.assigned', () => {
  it('returns fix when the assignee matches assignee_trigger', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: issueAssignedEvent('kova-bot', 11),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toEqual<DetectedTrigger>({ mode: 'fix', issue_number: '11', source: 'assignee' });
  });

  it('strips leading @ from assignee_trigger', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: issueAssignedEvent('kova-bot'),
      config: { ...DEFAULTS, assignee_trigger: '@kova-bot' },
      explicit: {},
    });
    expect(result?.mode).toBe('fix');
    expect(result?.source).toBe('assignee');
  });

  it('returns null when the assignee does not match', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: issueAssignedEvent('someone-else'),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });

  it('returns null when assignee_trigger is empty', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: issueAssignedEvent('kova-bot'),
      config: { ...DEFAULTS, assignee_trigger: '' },
      explicit: {},
    });
    expect(result).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/*  Comment trigger phrase                                             */
/* ------------------------------------------------------------------ */

describe('detectMode — issue_comment trigger_phrase', () => {
  it('returns fix when a comment contains the trigger_phrase with no explicit mode keyword', () => {
    const result = detectMode({
      eventName: 'issue_comment',
      eventPayload: issueCommentEvent('hey @kova please look at this', 5),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toEqual<DetectedTrigger>({ mode: 'fix', issue_number: '5', source: 'comment' });
  });

  it('returns auto mode when the comment says "@kova auto"', () => {
    const result = detectMode({
      eventName: 'issue_comment',
      eventPayload: issueCommentEvent('@kova auto please', 5),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result?.mode).toBe('auto');
    expect(result?.source).toBe('comment');
  });

  it('returns brainstorm mode when the comment says "@kova brainstorm"', () => {
    const result = detectMode({
      eventName: 'issue_comment',
      eventPayload: issueCommentEvent('@kova brainstorm', 5),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result?.mode).toBe('brainstorm');
    expect(result?.source).toBe('comment');
  });

  it('matches trigger_phrase case-insensitively with word boundaries', () => {
    const result = detectMode({
      eventName: 'issue_comment',
      eventPayload: issueCommentEvent('Hi @Kova!', 5),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result?.mode).toBe('fix');
  });

  it('does not match when trigger_phrase is a substring of a larger word', () => {
    const result = detectMode({
      eventName: 'issue_comment',
      eventPayload: issueCommentEvent('@kovasomething here', 5),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });

  it('returns null when comment lacks the trigger phrase', () => {
    const result = detectMode({
      eventName: 'issue_comment',
      eventPayload: issueCommentEvent('just a regular comment'),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });

  it('returns null on comment.deleted (only created/edited count)', () => {
    const result = detectMode({
      eventName: 'issue_comment',
      eventPayload: issueCommentEvent('@kova fix', 5, 'deleted'),
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });

  it('escapes regex metacharacters in trigger_phrase', () => {
    const result = detectMode({
      eventName: 'issue_comment',
      eventPayload: issueCommentEvent('please /kova.fix', 5),
      config: { ...DEFAULTS, trigger_phrase: '/kova.fix' },
      explicit: {},
    });
    expect(result?.mode).toBe('fix');
  });
});

/* ------------------------------------------------------------------ */
/*  No trigger / unknown events                                        */
/* ------------------------------------------------------------------ */

describe('detectMode — no trigger match', () => {
  it('returns null for unrelated events (push, schedule, etc.)', () => {
    const result = detectMode({
      eventName: 'push',
      eventPayload: {},
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });

  it('returns null for issues.opened with no trigger phrase in body or title', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: {
        action: 'opened',
        issue: { number: 4, title: 'a bug', body: 'no trigger here' },
      },
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });

  it('returns null on malformed payload (Zod parse failure) instead of throwing', () => {
    const result = detectMode({
      eventName: 'issues',
      eventPayload: { action: 'labeled' }, // missing issue + label fields
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });

  it('returns null when explicit.mode is undefined and event is null', () => {
    const result = detectMode({
      eventName: '',
      eventPayload: null,
      config: DEFAULTS,
      explicit: {},
    });
    expect(result).toBeNull();
  });
});
