// Interactive approval flow for brainstormed issues.
// Presents issues one at a time via @clack/prompts TUI.

import * as p from '@clack/prompts';
import type { BrainstormIssue } from '../types/index.js';

export interface ApprovalOptions {
  autoApprove?: boolean;
}

export interface ApprovalResult {
  approved: BrainstormIssue[];
  rejected: number;
  edited: number;
  skipped: number;
  cancelled: boolean;
}

function formatIssueNote(issue: BrainstormIssue): string {
  const labels = issue.labels.length > 0 ? `Labels: ${issue.labels.join(', ')}` : 'Labels: none';
  return [`[${issue.priority.toUpperCase()}] ${issue.category}`, labels, '', issue.body].join('\n');
}

export async function approveIssues(issues: BrainstormIssue[], options: ApprovalOptions = {}): Promise<ApprovalResult> {
  if (options.autoApprove) {
    return {
      approved: issues.map((i) => ({ ...i })),
      rejected: 0,
      edited: 0,
      skipped: 0,
      cancelled: false,
    };
  }

  if (issues.length === 0) {
    return { approved: [], rejected: 0, edited: 0, skipped: 0, cancelled: false };
  }

  const approved: BrainstormIssue[] = [];
  let rejected = 0;
  let edited = 0;
  let skipped = 0;
  let cancelled = false;

  p.intro('Review brainstormed issues');

  for (let i = 0; i < issues.length; i++) {
    const original = issues[i] as BrainstormIssue;
    const issue: BrainstormIssue = { ...original, labels: [...original.labels] };
    let wasEdited = false;

    let deciding = true;
    while (deciding) {
      p.note(formatIssueNote(issue), `Issue ${i + 1}/${issues.length}: ${issue.title}`);

      const action = (await p.select({
        message: 'Action?',
        options: [
          { value: 'approve' as const, label: 'Approve — create this issue' },
          { value: 'reject' as const, label: 'Reject — skip permanently' },
          { value: 'edit' as const, label: 'Edit — modify before deciding' },
          { value: 'skip' as const, label: 'Skip — decide later' },
        ],
      })) as 'approve' | 'reject' | 'edit' | 'skip' | symbol;

      if (p.isCancel(action)) {
        cancelled = true;
        deciding = false;
        break;
      }

      if (action === 'approve') {
        approved.push(issue);
        if (wasEdited) edited++;
        deciding = false;
      } else if (action === 'reject') {
        rejected++;
        if (wasEdited) edited++;
        deciding = false;
      } else if (action === 'skip') {
        skipped++;
        deciding = false;
      } else if (action === 'edit') {
        const field = (await p.select({
          message: 'What to edit?',
          options: [
            { value: 'title' as const, label: 'Title' },
            { value: 'body' as const, label: 'Body' },
            { value: 'priority' as const, label: 'Priority' },
          ],
        })) as 'title' | 'body' | 'priority' | symbol;

        if (p.isCancel(field)) {
          cancelled = true;
          deciding = false;
          continue;
        }

        if (field === 'title') {
          const newTitle = await p.text({
            message: 'New title:',
            initialValue: issue.title,
          });
          if (p.isCancel(newTitle)) {
            cancelled = true;
            deciding = false;
            continue;
          }
          issue.title = newTitle;
          wasEdited = true;
        } else if (field === 'body') {
          const newBody = await p.text({
            message: 'New body:',
            initialValue: issue.body,
          });
          if (p.isCancel(newBody)) {
            cancelled = true;
            deciding = false;
            continue;
          }
          issue.body = newBody;
          wasEdited = true;
        } else if (field === 'priority') {
          const newPriority = (await p.select({
            message: 'New priority:',
            options: [
              { value: 'critical' as const, label: 'Critical' },
              { value: 'high' as const, label: 'High' },
              { value: 'medium' as const, label: 'Medium' },
              { value: 'low' as const, label: 'Low' },
            ],
          })) as BrainstormIssue['priority'] | symbol;
          if (p.isCancel(newPriority)) {
            cancelled = true;
            deciding = false;
            continue;
          }
          issue.priority = newPriority;
          wasEdited = true;
        }
      }
    }

    if (cancelled) break;
  }

  p.outro(`Done: ${approved.length} approved, ${rejected} rejected, ${edited} edited, ${skipped} skipped`);

  return { approved, rejected, edited, skipped, cancelled };
}
