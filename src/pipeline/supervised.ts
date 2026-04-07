// Supervised pipeline orchestrator.
// Flow: brainstorm → approveIssues → createIssue → confirm pause → fixByNumbers

import { confirm, intro, isCancel, note, outro } from '@clack/prompts';
import { fs, path } from 'zx';
import { approveIssues } from '../services/approval.js';
import { createIssue, fetchIssues } from '../services/github.js';
import type { RepoConfig } from '../types/index.js';
import type { BrainstormReturn } from './brainstorm.js';
import { brainstorm } from './brainstorm.js';
import type { LoopResult } from './loop.js';
import { fixByNumbers } from './loop.js';

export interface SupervisedOptions {
  repoPath: string;
  repoName: string;
  config: RepoConfig;
  skipBrainstorm?: boolean;
  threshold?: number;
  focus?: string[];
  yes?: boolean;
  budgetUsd?: number;
  maxIssues?: number;
}

export interface SupervisedResult {
  success: boolean;
  brainstormResult?: BrainstormReturn;
  createdIssues: number[];
  fixResult?: LoopResult;
  error?: string;
}

interface SessionState {
  phase: 'fixing';
  issueNumbers: number[];
  createdAt: string;
  repoPath: string;
}

function sessionFilePath(repoPath: string): string {
  return path.join(repoPath, '.kova', 'supervised-session.json');
}

async function loadSession(repoPath: string): Promise<SessionState | null> {
  try {
    const content = await fs.readFile(sessionFilePath(repoPath), 'utf-8');
    return JSON.parse(content) as SessionState;
  } catch {
    return null;
  }
}

async function saveSession(state: SessionState): Promise<void> {
  const filePath = sessionFilePath(state.repoPath);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}

export async function clearSupervisedSession(repoPath: string): Promise<void> {
  try {
    await fs.unlink(sessionFilePath(repoPath));
  } catch {
    // no-op if file does not exist
  }
}

export async function runSupervised(options: SupervisedOptions): Promise<SupervisedResult> {
  const { repoPath, repoName, config, skipBrainstorm, threshold, focus, yes, budgetUsd } = options;

  intro('kova supervised');

  // Check for existing session
  const session = await loadSession(repoPath);

  let issueNumbers: number[] = [];
  let brainstormResult: BrainstormReturn | undefined;

  if (session?.phase === 'fixing') {
    // Resume from fix phase
    note(`Resuming from saved session: ${session.issueNumbers.length} issue(s) to fix`, 'Session found');
    issueNumbers = session.issueNumbers;
  } else if (skipBrainstorm) {
    // Fetch existing approved issues
    const existingIssues = await fetchIssues(repoPath, 'approved');
    issueNumbers = existingIssues.map((i) => i.number);
    if (issueNumbers.length === 0) {
      outro('No approved issues found — nothing to fix.');
      return { success: true, createdIssues: [] };
    }
  } else {
    // Full brainstorm flow
    brainstormResult = await brainstorm({
      repoPath,
      config,
      ...(threshold !== undefined && { threshold }),
      ...(focus !== undefined && { focus }),
    });

    if (!brainstormResult.success) {
      outro('Brainstorm failed.');
      return {
        success: false,
        createdIssues: [],
        error: brainstormResult.error ?? 'Brainstorm failed',
      };
    }

    // Approval phase
    const approvalResult = await approveIssues(brainstormResult.issues, yes ? { autoApprove: true } : {});

    if (approvalResult.cancelled) {
      outro('Approval cancelled.');
      return {
        success: false,
        createdIssues: [],
        error: 'Approval cancelled by user',
      };
    }

    if (approvalResult.approved.length === 0) {
      outro('No issues approved — nothing to fix.');
      return {
        success: true,
        brainstormResult,
        createdIssues: [],
      };
    }

    // Create issues in GitHub
    const createdNumbers: number[] = [];
    for (const issue of approvalResult.approved) {
      try {
        const created = await createIssue(repoPath, issue.title, issue.body, [...issue.labels, 'approved']);
        createdNumbers.push(created.number);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        note(`Failed to create "${issue.title}": ${msg}`, 'Warning');
      }
    }

    issueNumbers = createdNumbers;

    // Save session checkpoint
    await saveSession({
      phase: 'fixing',
      issueNumbers,
      createdAt: new Date().toISOString(),
      repoPath,
    });
  }

  // Pause before fix phase
  const shouldFix = await confirm({ message: `Proceed to fix ${issueNumbers.length} issue(s)?` });

  if (isCancel(shouldFix) || shouldFix === false) {
    outro('Fix phase skipped.');
    return {
      success: false,
      ...(brainstormResult !== undefined && { brainstormResult }),
      createdIssues: issueNumbers,
    };
  }

  // Fix phase
  const fixResult = await fixByNumbers({ repoPath, repoName, config, issueNumbers, budgetUsd });

  // Clear session after successful fix
  await clearSupervisedSession(repoPath);

  outro(`Done. ${fixResult.succeeded}/${fixResult.total} succeeded.`);

  return {
    success: true,
    ...(brainstormResult !== undefined && { brainstormResult }),
    createdIssues: issueNumbers,
    fixResult,
  };
}
