// Detect kova run mode from a GitHub Action event payload + Action inputs.
//
// Borrowed pattern: oss/claude-code-action — action.yml exposes
// trigger_phrase/label_trigger/assignee_trigger and src/modes/detector.ts
// auto-selects mode from the event payload. We follow the same shape but
// resolve to kova's `fix | auto | brainstorm` modes (plus null = no run).

import { z } from 'zod';

const VALID_MODES = ['fix', 'auto', 'brainstorm'] as const;
export type Mode = (typeof VALID_MODES)[number];
export type TriggerSource = 'explicit' | 'label' | 'assignee' | 'comment';

export interface DetectModeConfig {
  /** Phrase that triggers kova when found in an issue comment (e.g. "@kova"). */
  trigger_phrase: string;
  /** Label whose addition triggers a fix run (e.g. "kova"). Empty disables. */
  label_trigger: string;
  /** Username whose assignment triggers a fix run. Leading "@" is stripped. Empty disables. */
  assignee_trigger: string;
}

export interface ExplicitInputs {
  mode?: Mode;
  issue_number?: string;
  all?: boolean;
}

export interface DetectModeRequest {
  /** Value of GITHUB_EVENT_NAME (e.g. "issues", "issue_comment"). */
  eventName: string;
  /** Parsed JSON contents of GITHUB_EVENT_PATH. May be malformed. */
  eventPayload: unknown;
  config: DetectModeConfig;
  explicit: ExplicitInputs;
}

export interface DetectedTrigger {
  mode: Mode;
  issue_number: string | undefined;
  source: TriggerSource;
}

/* ------------------------------------------------------------------ */
/*  Zod schemas — used to safely parse payload shapes at the boundary  */
/* ------------------------------------------------------------------ */

const IssueRef = z.object({
  number: z.number(),
  title: z.string().optional(),
  body: z.string().nullable().optional(),
});

const IssuesLabeledPayload = z.object({
  action: z.literal('labeled'),
  issue: IssueRef,
  label: z.object({ name: z.string() }),
});

const IssuesAssignedPayload = z.object({
  action: z.literal('assigned'),
  issue: IssueRef,
  assignee: z.object({ login: z.string() }).nullable(),
});

const IssuesOpenedPayload = z.object({
  action: z.literal('opened'),
  issue: IssueRef,
});

const IssueCommentPayload = z.object({
  action: z.enum(['created', 'edited']),
  issue: IssueRef,
  comment: z.object({ body: z.string() }),
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function triggerRegex(triggerPhrase: string): RegExp {
  // Word-boundary-ish match: phrase must be preceded by start/whitespace and
  // followed by whitespace/punctuation/end. Avoids substring false-positives
  // (e.g. "@kovasomething" should NOT match "@kova").
  return new RegExp(`(^|\\s)${escapeRegExp(triggerPhrase)}([\\s.,!?;:]|$)`, 'i');
}

function modeFromComment(commentBody: string, triggerPhrase: string): Mode {
  // Look for "<trigger_phrase> <mode-keyword>" anywhere in the comment.
  // If no explicit mode keyword follows the trigger, default to "fix".
  const escaped = escapeRegExp(triggerPhrase);
  for (const candidate of VALID_MODES) {
    const re = new RegExp(`${escaped}\\s+${candidate}\\b`, 'i');
    if (re.test(commentBody)) {
      return candidate;
    }
  }
  return 'fix';
}

function explicitTrigger(explicit: ExplicitInputs): DetectedTrigger | null {
  // Explicit inputs always win over event-derived triggers.
  // `all: true` is also a valid explicit fix trigger (covers /fix --all in CI).
  if (explicit.mode && (explicit.issue_number || explicit.all || explicit.mode !== 'fix')) {
    return { mode: explicit.mode, issue_number: explicit.issue_number, source: 'explicit' };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  detectMode — main entry point                                      */
/* ------------------------------------------------------------------ */

export function detectMode(req: DetectModeRequest): DetectedTrigger | null {
  // 1. Explicit inputs take precedence — preserves today's workflow_dispatch path.
  const explicit = explicitTrigger(req.explicit);
  if (explicit) {
    return explicit;
  }

  // 2. Event-aware detection.
  const { eventName, eventPayload, config } = req;

  if (eventName === 'issues') {
    // 2a. Label trigger
    if (config.label_trigger) {
      const labeled = IssuesLabeledPayload.safeParse(eventPayload);
      if (labeled.success && labeled.data.label.name === config.label_trigger) {
        return {
          mode: 'fix',
          issue_number: String(labeled.data.issue.number),
          source: 'label',
        };
      }
    }

    // 2b. Assignee trigger
    if (config.assignee_trigger) {
      const assigned = IssuesAssignedPayload.safeParse(eventPayload);
      if (assigned.success && assigned.data.assignee) {
        const trigger = config.assignee_trigger.replace(/^@/, '');
        if (assigned.data.assignee.login === trigger) {
          return {
            mode: 'fix',
            issue_number: String(assigned.data.issue.number),
            source: 'assignee',
          };
        }
      }
    }

    // 2c. issues.opened with trigger phrase in title or body
    if (config.trigger_phrase) {
      const opened = IssuesOpenedPayload.safeParse(eventPayload);
      if (opened.success) {
        const re = triggerRegex(config.trigger_phrase);
        const title = opened.data.issue.title ?? '';
        const body = opened.data.issue.body ?? '';
        if (re.test(title) || re.test(body)) {
          return {
            mode: 'fix',
            issue_number: String(opened.data.issue.number),
            source: 'comment',
          };
        }
      }
    }
  }

  if (eventName === 'issue_comment' && config.trigger_phrase) {
    const comment = IssueCommentPayload.safeParse(eventPayload);
    if (comment.success) {
      const body = comment.data.comment.body;
      const re = triggerRegex(config.trigger_phrase);
      if (re.test(body)) {
        return {
          mode: modeFromComment(body, config.trigger_phrase),
          issue_number: String(comment.data.issue.number),
          source: 'comment',
        };
      }
    }
  }

  // 3. No trigger matched — caller should NOT run kova.
  return null;
}
