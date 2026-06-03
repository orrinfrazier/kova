// ShipEngine — git operations engine (issue #356).
//
// Encapsulates the deterministic ship phase of a fix run:
//   1. Pre-ship conflict detection (`checkForConflicts`).
//   2. Auto-resolve non-overlapping conflicts (`git checkout origin/<base> -- <file>`).
//   3. Retry parallel TI loop for overlapping conflicts (via injected hook).
//   4. Rebase on default branch (`rebaseOnDefault`).
//   5. Auto-resolve rebase conflicts (`resolveConflicts`).
//   6. Pre-commit secrets scan (`scanForSecrets`).
//   7. Commit + push + create PR (`commitAndPush`, `createPR`, `listOpenPRs`).
//
// Ship is NOT an AI wave — no model, no cost, no turns. It therefore lives
// outside the `WaveEngine<TInput, TOutput>` contract (whose `name` is
// `FixAIWaveName`). The engine returns a discriminated union signaling
// shipped / no_changes / failed, with `failed` carrying a stable reason code
// (`secrets | rebase | conflict`) so callers can route on it without parsing
// error strings.
//
// What the engine does NOT do:
//   - Touch FixState, checkpoints, or metrics — those are orchestrator concerns.
//   - Reach into AI wave routing — ship has no model context.
//   - Decide whether ship should run at all — the orchestrator owns `shouldSkip`.

import { $ } from 'zx';
import { checkForConflicts } from '../../services/conflict-check.js';
import { resolveConflicts } from '../../services/conflict-resolver.js';
import { createPR, listOpenPRs } from '../../services/github.js';
import { scanForSecrets } from '../../services/secrets-scan.js';
import { commitAndPush, detectDefaultBranch, getChangedFiles, rebaseOnDefault } from '../../services/worktree.js';
import { log } from '../../utils/logger.js';
import type { ShipEngine, ShipEngineContext, ShipEngineInput, ShipEngineResult } from './types.js';

$.verbose = false;

/**
 * Build the PR body sections. Exposed for unit testing the formatting
 * without invoking gh.
 */
export function buildShipPRBody(input: ShipEngineInput, openPRs: string[]): string {
  const sections: string[] = [
    '## Summary',
    `Fixes #${input.issue.number}`,
    '',
    '## Context',
    input.issue.title,
    '',
    '## Open PRs (for merge ordering)',
    ...openPRs.map((pr) => `- ${pr}`),
  ];

  if (input.mergeDependencies && input.mergeDependencies.length > 0) {
    sections.push('', '## Merge Dependencies', ...input.mergeDependencies.map((n) => `depends on #${n}`));
  }

  if (input.reviewKnownIssues && input.reviewKnownIssues.length > 0) {
    sections.push(
      '',
      '## Known Issues',
      'The following issues were identified during review but could not be resolved within the iteration limit:',
      '',
      ...input.reviewKnownIssues.map((i) => `- [${i.severity}] \`${i.file}\`: ${i.description}`),
    );
  }

  return sections.join('\n');
}

/**
 * Run the pre-ship conflict-detection + auto-resolution flow. Returns
 * silently on the happy path; calls the injected retry hook when overlapping
 * conflicts are detected. Internal helper — exported only for unit testing.
 */
async function preShipConflictPhase(workDir: string, input: ShipEngineInput): Promise<void> {
  const conflictCheck = await checkForConflicts(workDir, input.specFiles);
  if (!conflictCheck.hasConflicts) return;

  log.info(`[ship] Pre-ship conflict check: ${conflictCheck.conflictingFiles.join(', ')}`);

  // Non-overlapping conflicts (files we didn't touch) — accept upstream version.
  if (conflictCheck.nonOverlapping.length > 0) {
    const defaultBranch = await detectDefaultBranch(workDir);
    log.info(`[ship] Auto-resolving non-overlapping conflicts: ${conflictCheck.nonOverlapping.join(', ')}`);
    for (const file of conflictCheck.nonOverlapping) {
      try {
        await $`git -C ${workDir} checkout origin/${defaultBranch} -- ${file}`;
        await $`git -C ${workDir} add ${file}`;
      } catch {
        log.warn(`[ship] Failed to checkout upstream version of ${file}`);
      }
    }
    // Commit the upstream file adoptions. May be a no-op if nothing was
    // staged — that's fine.
    try {
      await $`git -C ${workDir} commit -m ${'chore: adopt upstream changes for non-overlapping files'}`;
    } catch {
      // Nothing to commit — that's fine.
    }
  }

  // Overlapping conflicts (in our spec files) — retry impl once with conflict
  // context. Caller injects the retry hook to keep this engine decoupled from
  // the TI loop module.
  if (conflictCheck.overlapping.length > 0 && input.retryParallelTILoop) {
    log.info(`[ship] Overlapping conflicts in spec files: ${conflictCheck.overlapping.join(', ')} — retrying impl`);
    const conflictHint = `Your changes conflict with upstream in: ${conflictCheck.overlapping.join(', ')}. Fetch the latest version of these files from the default branch and adapt your implementation to avoid merge conflicts.`;
    const retryResult = await input.retryParallelTILoop({ codebaseContext: conflictHint });
    if (!retryResult.testsPassing) {
      log.warn('[ship] Conflict retry: tests not passing after impl retry, proceeding with rebase');
    }
  }
}

/**
 * Create a ShipEngine instance. Stateless — the returned object can be
 * reused across runs.
 */
export function createShipEngine(): ShipEngine {
  return {
    name: 'ship',
    async run(ctx: ShipEngineContext, input: ShipEngineInput): Promise<ShipEngineResult> {
      const { workDir, repoPath } = ctx;

      // (1) Pre-ship conflict detection + remediation.
      await preShipConflictPhase(workDir, input);

      // (2) Rebase on default branch before shipping.
      const rebaseResult = await rebaseOnDefault(workDir);
      if (!rebaseResult.success && rebaseResult.conflicted) {
        const defaultBranch = await detectDefaultBranch(workDir);
        const resolution = await resolveConflicts(workDir, defaultBranch);
        if (resolution.resolved) {
          log.info(`[ship] Conflicts auto-resolved in: ${resolution.filesResolved.join(', ')}`);
        } else {
          const filesUnresolved = (resolution as { filesUnresolved?: string[] }).filesUnresolved ?? [];
          const error = `Unresolvable merge conflicts in: ${filesUnresolved.join(', ')}`;
          log.error(`[ship] Merge conflicts could not be resolved: ${error}`);
          return { status: 'failed', reason: 'rebase', error };
        }
      }

      // (3) Pre-commit secrets scan.
      const changedFiles = await getChangedFiles(workDir);
      if (changedFiles.length > 0) {
        const secretsScan = await scanForSecrets(workDir, changedFiles);
        if (!secretsScan.clean) {
          log.error(`[ship] Secrets detected before commit:\n${secretsScan.report}`);
          const error = `Secrets detected — commit blocked: ${secretsScan.findings.length} finding(s)\n${secretsScan.report}`;
          return { status: 'failed', reason: 'secrets', error };
        }
      }

      // (4) Commit + push. May be a no-op if nothing to commit.
      const commitResult = await commitAndPush(workDir, input.branch, input.issue);
      if (!commitResult.committed) {
        log.warn('[ship] No changes to commit — skipping PR');
        return { status: 'no_changes' };
      }

      // (5) Create the PR.
      const openPRs = await listOpenPRs(repoPath);
      const prTitle = `fix: ${input.issue.title} (#${input.issue.number})`;
      const prBody = buildShipPRBody(input, openPRs);
      const prUrl = await createPR(workDir, input.branch, prTitle, prBody);
      log.info(`[ship] PR created: ${prUrl}`);

      return {
        status: 'shipped',
        prUrl,
        ...(commitResult.commitMessage !== undefined && { commitMessage: commitResult.commitMessage }),
        filesStaged: commitResult.filesStaged,
      };
    },
  };
}
