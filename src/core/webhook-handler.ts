// Webhook event handler — parses GitHub webhook events and enqueues fixes.

export interface WebhookResult {
  action: 'enqueued' | 'ignored' | 'duplicate';
  issueNumber?: number;
  reason?: string;
}

/**
 * Handle a GitHub webhook event and decide whether to enqueue a fix.
 * The `enqueue` callback returns false if the issue is already pending.
 */
export function handleWebhookEvent(
  eventType: string,
  payload: Record<string, unknown>,
  enqueue: (issueNumber: number) => boolean,
): WebhookResult {
  if (eventType === 'issues') {
    return handleIssuesEvent(payload, enqueue);
  }

  if (eventType === 'issue_comment') {
    return handleIssueCommentEvent(payload, enqueue);
  }

  return { action: 'ignored', reason: `unhandled event type: ${eventType}` };
}

function handleIssuesEvent(payload: Record<string, unknown>, enqueue: (issueNumber: number) => boolean): WebhookResult {
  if (payload.action !== 'labeled') {
    return { action: 'ignored', reason: `issues action "${String(payload.action)}" is not "labeled"` };
  }

  const label = payload.label as { name: string } | undefined;
  if (!label || label.name !== 'auto-fix') {
    return { action: 'ignored', reason: `label "${label?.name ?? 'unknown'}" is not "auto-fix"` };
  }

  const issue = payload.issue as { number: number };
  const issueNumber = issue.number;

  if (enqueue(issueNumber)) {
    return { action: 'enqueued', issueNumber };
  }

  return { action: 'duplicate', issueNumber };
}

function handleIssueCommentEvent(
  payload: Record<string, unknown>,
  enqueue: (issueNumber: number) => boolean,
): WebhookResult {
  if (payload.action !== 'created') {
    return { action: 'ignored', reason: `issue_comment action "${String(payload.action)}" is not "created"` };
  }

  const comment = payload.comment as { body?: string } | undefined;
  const body = comment?.body ?? '';

  if (!body.startsWith('/kova fix')) {
    return { action: 'ignored', reason: 'comment does not start with "/kova fix"' };
  }

  const issue = payload.issue as { number: number };
  const issueNumber = issue.number;

  if (enqueue(issueNumber)) {
    return { action: 'enqueued', issueNumber };
  }

  return { action: 'duplicate', issueNumber };
}
