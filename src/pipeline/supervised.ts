// Supervised pipeline orchestrator.
// Flow: brainstorm → coverage checkpoint → approveIssues → createIssue → confirm pause → fixByNumbers

import { confirm, intro, isCancel, note, outro } from '@clack/prompts';
import { fs, path } from 'zx';
import { approveIssues } from '../services/approval.js';
import { resolveBrainstormDependencies } from '../services/brainstorm-deps.js';
import { createIssue, fetchIssues } from '../services/github.js';
import type { RepoConfig } from '../types/index.js';
import type { BrainstormReturn } from './brainstorm.js';
import { brainstorm, printCoverageMap } from './brainstorm.js';
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

    // Coverage checkpoint (issue #280): show the scope ledger and ask the user
    // to confirm coverage is complete BEFORE we approve / create any issues.
    // The --yes flag bypasses this (same semantics as approval auto-approve).
    if (!yes) {
      printCoverageMap(brainstormResult.coverage);
      const scopeOk = await confirm({ message: 'Scope is complete — proceed to file issues?' });
      if (isCancel(scopeOk) || scopeOk === false) {
        outro('Scope checkpoint declined — no issues filed.');
        return {
          success: false,
          brainstormResult,
          createdIssues: [],
          error: 'Coverage checkpoint declined by user',
        };
      }
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

    // Resolve in-batch dependency titles → sibling issues, then
    // topologically sort so blockers are filed first (issue #279).
    // Unresolvable titles are surfaced to the user via note() so
    // they're never silently discarded.
    const { ordered, unresolvable } = resolveBrainstormDependencies(approvalResult.approved);

    if (unresolvable.length > 0) {
      const lines = unresolvable.map((u) => `- "${u.title}" → unresolvable: ${u.deps.map((d) => `"${d}"`).join(', ')}`);
      note(
        `Some dependency titles did not match any approved sibling and were dropped:\n${lines.join('\n')}`,
        'Unresolvable dependencies',
      );
    }

    // Title → GH issue number, used to resolve "Blocked by #N" lines for
    // dependents as they're filed.
    const titleToNumber = new Map<string, number>();
    const normalizedTitle = (t: string) => t.trim().toLowerCase();

    // Create issues in GitHub in dependency order.
    const createdNumbers: number[] = [];
    for (const issue of ordered) {
      // For each dep that resolved to a sibling we've already filed,
      // append a "Blocked by #N" line so prioritize.ts → parseDependencies
      // can pick it up at fix time.
      const deps = issue.dependencies ?? [];
      const blockerNumbers: number[] = [];
      for (const depTitle of deps) {
        const blocker = titleToNumber.get(normalizedTitle(depTitle));
        if (blocker !== undefined) blockerNumbers.push(blocker);
      }
      const blockedByLines =
        blockerNumbers.length > 0 ? `\n\n${blockerNumbers.map((n) => `Blocked by #${n}`).join('\n')}` : '';
      const finalBody = `${issue.body}${blockedByLines}`;

      try {
        const created = await createIssue(repoPath, issue.title, finalBody, [...issue.labels, 'approved']);
        createdNumbers.push(created.number);
        titleToNumber.set(normalizedTitle(issue.title), created.number);
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
