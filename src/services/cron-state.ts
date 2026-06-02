// Persisted scheduler state — `last_run_iso` per (repo, job) (issue #303).
//
// Stored in `<root>/.kova/schedule-state.json` so it sits next to fix
// checkpoints. `<root>` defaults to `~/.kova` for the system-wide scheduler
// CLI; tests inject a tmpdir. Corruption is treated as empty state so a
// hand-edited or partially-written file never blocks the next scheduler
// tick.

import { fs, path } from 'zx';
import { log } from '../utils/logger.js';

export interface ScheduleStateEntry {
  last_run_iso: string;
}

export type ScheduleState = Record<string, ScheduleStateEntry>;

/** Compose a `<repo>:<job>` key — the canonical state-map key. */
export function scheduleStateKey(repoName: string, jobName: string): string {
  return `${repoName}:${jobName}`;
}

/** Resolve the state file path for a root directory. */
export function scheduleStatePath(root: string): string {
  return path.join(root, '.kova', 'schedule-state.json');
}

/** Load the persisted state. Missing file → `{}`; corrupted file → `{}`. */
export async function loadScheduleState(root: string): Promise<ScheduleState> {
  const filePath = scheduleStatePath(root);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ScheduleState;
    }
    return {};
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    // SyntaxError / read failure → treat as empty (resilient, never blocks the schedule).
    log.warn(`schedule state corrupted, resetting: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/** Record (or overwrite) `last_run_iso` for a key. Creates `.kova/` if needed. */
export async function recordRun(root: string, key: string, lastRunIso: string): Promise<void> {
  const filePath = scheduleStatePath(root);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const current = await loadScheduleState(root);
  current[key] = { last_run_iso: lastRunIso };
  await fs.writeFile(filePath, JSON.stringify(current, null, 2));
}
