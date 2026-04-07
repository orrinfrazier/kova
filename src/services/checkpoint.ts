// File-based checkpoint manager — save/restore fix state between waves.
// If a run crashes, resume from last completed wave.

import { fs, path } from 'zx';
import type { FixState } from '../types/index.js';
import { log } from '../utils/logger.js';

function checkpointPath(workDir: string): string {
  return path.join(workDir, '.kova', 'state.json');
}

export async function saveCheckpoint(workDir: string, state: FixState): Promise<void> {
  const filePath = checkpointPath(workDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2));
  log.debug(`Checkpoint saved: ${state.completedWaves.length} waves completed`);
}

export async function loadCheckpoint(workDir: string): Promise<FixState | null> {
  const filePath = checkpointPath(workDir);

  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const state = JSON.parse(content) as FixState;
    log.info(`Checkpoint loaded: ${state.completedWaves.length} waves completed, resuming...`);
    return state;
  } catch {
    return null;
  }
}

export async function clearCheckpoint(workDir: string): Promise<void> {
  const filePath = checkpointPath(workDir);
  try {
    await fs.unlink(filePath);
  } catch {
    // File doesn't exist, that's fine
  }
}
