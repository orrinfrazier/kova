// Progress comment tracker — creates/updates a single GitHub issue comment
// as waves complete during the fix pipeline.

import type { FixState, Issue, WaveName } from '../types/index.js';
import { log } from '../utils/logger.js';
import { editIssueComment, upsertTrackingComment } from './github.js';

const PIPELINE_WAVES: WaveName[] = ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'];

const WAVE_LABELS: Record<WaveName, string> = {
  assess: 'Assess',
  spec: 'Spec',
  test: 'Test',
  impl: 'Impl',
  quality: 'Quality',
  review: 'Review',
  ship: 'Ship',
  brainstorm: 'Brainstorm',
};

type ProgressStatus = 'running' | 'completed' | 'failed' | 'interrupted';

export function formatProgressBody(
  _issue: Issue,
  completedWaves: WaveName[],
  status: ProgressStatus,
  prUrl?: string,
  error?: string,
): string {
  const completedSet = new Set(completedWaves);

  // Find the first non-completed wave to mark as in-progress
  let inProgressWave: WaveName | undefined;
  if (status === 'running') {
    inProgressWave = PIPELINE_WAVES.find((w) => !completedSet.has(w));
  }

  const waveLines = PIPELINE_WAVES.map((wave) => {
    const label = WAVE_LABELS[wave];
    if (completedSet.has(wave)) {
      return `| ${label} | done |`;
    }
    if (wave === inProgressWave) {
      return `| ${label} | in progress |`;
    }
    return `| ${label} | pending |`;
  });

  const sections: string[] = [
    `## Kova is working on this issue`,
    '',
    `| Wave | Status |`,
    `|------|--------|`,
    ...waveLines,
  ];

  if (status === 'completed' && prUrl) {
    sections.push('', `**Result:** PR created — ${prUrl}`);
  } else if (status === 'failed' && error) {
    sections.push('', `**Failed:** ${error}`);
  } else if (status === 'interrupted') {
    sections.push('', `**Interrupted** — will resume on next run.`);
  }

  return sections.join('\n');
}

export interface ProgressTrackerOptions {
  repoPath: string;
  ownerRepo: string;
  issue: Issue;
}

export class ProgressTracker {
  private commentId: number | null = null;
  private readonly ownerRepo: string;
  private readonly issue: Issue;

  constructor(options: ProgressTrackerOptions) {
    this.ownerRepo = options.ownerRepo;
    this.issue = options.issue;
  }

  async start(): Promise<void> {
    const body = formatProgressBody(this.issue, [], 'running');
    try {
      // Use upsert so a resumed run in a fresh worktree finds the existing
      // tracking comment by HTML marker instead of posting a duplicate.
      this.commentId = await upsertTrackingComment(this.ownerRepo, this.issue.number, body);
    } catch (err) {
      log.warn(`[progress] Failed to create progress comment: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async waveCompleted(_wave: WaveName, state: FixState): Promise<void> {
    const body = formatProgressBody(this.issue, state.completedWaves, 'running');
    await this.updateOrCreate(body);
  }

  async complete(prUrl?: string): Promise<void> {
    const allWaves = [...PIPELINE_WAVES];
    const body = formatProgressBody(this.issue, allWaves, 'completed', prUrl);
    await this.updateOrCreate(body);
  }

  async failed(error: string): Promise<void> {
    const body = formatProgressBody(this.issue, [], 'failed', undefined, error);
    await this.updateOrCreate(body);
  }

  private async updateOrCreate(body: string): Promise<void> {
    try {
      if (this.commentId != null) {
        await editIssueComment(this.ownerRepo, this.commentId, body);
      } else {
        // No stored comment id (e.g. resumed run in a fresh worktree) — find
        // the existing tracking comment via the HTML marker and edit it in
        // place, or create a fresh one.
        this.commentId = await upsertTrackingComment(this.ownerRepo, this.issue.number, body);
      }
    } catch (err) {
      log.warn(`[progress] Failed to update progress comment: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
