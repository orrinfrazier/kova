// Typed handoff contract between waves.
// Every wave produces a WaveHandoff<T> written to .kova/handoffs/{wave}.json.
// Next wave consumes it with Zod validation.

import { z } from 'zod';
import { fs, path } from 'zx';
import { log } from '../utils/logger.js';

const WaveNameSchema = z.enum(['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship', 'brainstorm']);

export const WaveHandoffSchema = z.object({
  wave: WaveNameSchema,
  timestamp: z.string().datetime(),
  model: z.string(),
  cost: z.number(),
  turns: z.number(),
  confidence: z.enum(['high', 'medium', 'low']),
  artifact: z.unknown(),
  approach_notes: z.string(),
  /**
   * True when `artifact` is the typed structured-output result (`T`).
   * False when `artifact` is the raw model string fallback (parse failure
   * or no outputFormat requested). Callers should check `parsed` before
   * treating `artifact` as `T` — replaces the legacy `typeof artifact === 'string'`
   * runtime check that proved the declared type was a lie (issue #308).
   *
   * Optional in the schema for backward-compat with persisted handoffs
   * written before this field existed. New emissions from `spawnWaveAgent`
   * always include it.
   */
  parsed: z.boolean().optional(),
  fallback_used: z.boolean().optional(),
  local_attempt_cost: z.number().optional(),
  /** Number of structured-output repair turns used (0..2). Present when outputFormat+zodSchema was set. */
  repair_attempts: z.number().int().min(0).max(2).optional(),
});

export type WaveHandoff<T = unknown> = Omit<z.infer<typeof WaveHandoffSchema>, 'artifact'> & {
  artifact: T;
};

function handoffDir(workDir: string): string {
  return path.join(workDir, '.kova', 'handoffs');
}

function handoffPath(workDir: string, wave: string): string {
  return path.join(handoffDir(workDir), `${wave}.json`);
}

export async function saveHandoff<T>(workDir: string, handoff: WaveHandoff<T>): Promise<void> {
  const dir = handoffDir(workDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(handoffPath(workDir, handoff.wave), JSON.stringify(handoff, null, 2));
  log.debug(`Handoff saved: ${handoff.wave} (confidence: ${handoff.confidence})`);
}

export async function loadHandoff<T = unknown>(workDir: string, wave: string): Promise<WaveHandoff<T> | null> {
  if (!WaveNameSchema.safeParse(wave).success) {
    log.warn(`Invalid wave name: ${wave}`);
    return null;
  }

  try {
    const content = await fs.readFile(handoffPath(workDir, wave), 'utf-8');
    const raw: unknown = JSON.parse(content);
    const result = WaveHandoffSchema.safeParse(raw);
    if (!result.success) {
      log.warn(`Invalid handoff for wave ${wave}: ${result.error.message}`);
      return null;
    }
    return result.data as WaveHandoff<T>;
  } catch {
    return null;
  }
}

export async function loadAllHandoffs(workDir: string): Promise<WaveHandoff[]> {
  const dir = handoffDir(workDir);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  const handoffs: WaveHandoff[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const wave = entry.replace('.json', '');
    const handoff = await loadHandoff(workDir, wave);
    if (handoff) handoffs.push(handoff);
  }
  return handoffs;
}
