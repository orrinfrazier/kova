// RunRegistry — file-based catalog of fix runs for `kova attach` / `kova ls`.
//
// Layout (mirrors checkpoint.ts):
//   <repoPath>/.kova/runs/<runId>.json    — one file per registered run.
//
// Concurrency model:
//   - One file per run. Concurrent fixes write to disjoint files, so writers
//     never race on the same path.
//   - Each write is performed write-then-rename through a `.tmp` sibling, so
//     a concurrent `listRuns()` either sees the previous full file or the new
//     full file — never a torn read.
//   - listRuns()/getRun() tolerate malformed or non-JSON files in the
//     directory; they are skipped, not surfaced as errors. This matches the
//     forgiving behavior of checkpoint.ts when a state file is missing.
//
// Lifecycle:
//   - registerRun(repoPath, run) on fix-started.
//   - updateRun(repoPath, runId, patch) on wave-enter / fix-done.
//   - clearRun(repoPath, runId) optional — `kova ls` keeps showing terminal
//     runs; cleanup is the operator's responsibility today.
//
// The registry is intentionally tiny: every field is what `kova ls` and
// `kova attach` actually need to render or look up.

import { randomBytes } from 'node:crypto';
import { fs, path } from 'zx';
import { log } from '../utils/logger.js';

export type RunStatus = 'running' | 'done' | 'failed';

export interface Run {
  /** Stable id for the run (matches fix.ts's runId / fixId). */
  runId: string;
  /** Fix identifier used to filter SSE events for this run. */
  fixId: string;
  /** owner/repo identifier. */
  repoId: string;
  /** GitHub issue number being worked on, if any. */
  issueNumber?: number;
  /** ISO timestamp when the fix started. */
  startedAt: string;
  /** Current high-level status. */
  status: RunStatus;
  /** Name of the wave currently executing, when applicable. */
  currentWave?: string;
  /** Resulting PR number, when applicable. */
  prNumber?: number;
  /** ISO timestamp when the run reached a terminal status. */
  completedAt?: string;
}

function runsDir(repoPath: string): string {
  return path.join(repoPath, '.kova', 'runs');
}

function runFile(repoPath: string, runId: string): string {
  return path.join(runsDir(repoPath), `${runId}.json`);
}

async function ensureRunsDir(repoPath: string): Promise<void> {
  await fs.mkdir(runsDir(repoPath), { recursive: true });
}

async function writeAtomically(filePath: string, content: string): Promise<void> {
  // Suffix the tmp file with crypto-random bytes so two concurrent writers
  // to the SAME runId (defensive — should not happen) cannot stomp each other.
  const suffix = randomBytes(6).toString('hex');
  const tmp = `${filePath}.${suffix}.tmp`;
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, filePath);
}

export async function registerRun(repoPath: string, run: Run): Promise<void> {
  await ensureRunsDir(repoPath);
  await writeAtomically(runFile(repoPath, run.runId), JSON.stringify(run, null, 2));
  log.debug(`[run-registry] registered ${run.runId} (issue #${run.issueNumber ?? '?'})`);
}

export async function getRun(repoPath: string, runId: string): Promise<Run | null> {
  try {
    const content = await fs.readFile(runFile(repoPath, runId), 'utf-8');
    return JSON.parse(content) as Run;
  } catch {
    return null;
  }
}

export async function listRuns(repoPath: string): Promise<Run[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(runsDir(repoPath));
  } catch {
    return [];
  }
  const runs: Run[] = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    // Skip the half-written temp files we may briefly leave behind on crash.
    if (name.endsWith('.tmp')) continue;
    try {
      const content = await fs.readFile(path.join(runsDir(repoPath), name), 'utf-8');
      runs.push(JSON.parse(content) as Run);
    } catch {
      // Malformed file — skip it. listRuns is forgiving; the bad file is
      // diagnostic, not a hard error.
    }
  }
  return runs;
}

export async function updateRun(repoPath: string, runId: string, patch: Partial<Run>): Promise<void> {
  const existing = await getRun(repoPath, runId);
  if (!existing) {
    // No-op: refuse to materialize a run from a partial patch. The caller
    // must registerRun() first. This guards against late wave-enter events
    // resurrecting a cleared run.
    return;
  }
  const next: Run = { ...existing, ...patch };
  await writeAtomically(runFile(repoPath, runId), JSON.stringify(next, null, 2));
}

export async function clearRun(repoPath: string, runId: string): Promise<void> {
  try {
    await fs.unlink(runFile(repoPath, runId));
  } catch {
    // Missing file is fine — the operation is idempotent.
  }
}
