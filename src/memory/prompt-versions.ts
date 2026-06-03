// Prompt versioning — hash prompts, store snapshots, detect changes, diff versions.
// Storage: .kova/prompt-versions/versions.jsonl + .kova/prompt-versions/snapshots/{hash}.txt

import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { log } from '../utils/logger.js';

export interface PromptVersion {
  wave: string;
  hash: string;
  timestamp: string;
}

export interface PromptChange {
  wave: string;
  previousHash: string;
  currentHash: string;
}

const PromptVersionSchema = z.object({
  wave: z.string(),
  hash: z.string(),
  timestamp: z.string(),
});

function versionsDir(repoPath: string): string {
  return join(repoPath, '.kova', 'prompt-versions');
}

function versionsLogPath(repoPath: string): string {
  return join(versionsDir(repoPath), 'versions.jsonl');
}

function snapshotPath(repoPath: string, hash: string): string {
  return join(versionsDir(repoPath), 'snapshots', `${hash}.txt`);
}

/** SHA-256 hash of prompt content, truncated to 12 hex chars. */
export function hashPrompt(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12);
}

/** Record a prompt version — stores snapshot and appends to version log. */
export async function recordPromptVersion(repoPath: string, wave: string, content: string): Promise<PromptVersion> {
  const hash = hashPrompt(content);
  const timestamp = new Date().toISOString();
  const dir = versionsDir(repoPath);

  // Ensure directories exist
  await mkdir(join(dir, 'snapshots'), { recursive: true });

  // Store snapshot (deduplicated by hash — only write if new)
  const snapPath = snapshotPath(repoPath, hash);
  try {
    await readFile(snapPath, 'utf-8');
    // Already exists, skip write
  } catch {
    await writeFile(snapPath, content, 'utf-8');
  }

  // Append to version log
  const entry: PromptVersion = { wave, hash, timestamp };
  await appendFile(versionsLogPath(repoPath), `${JSON.stringify(entry)}\n`);

  log.debug(`Recorded prompt version: ${wave} → ${hash}`);
  return entry;
}

/** Read the full version history, optionally filtered by wave. */
export async function getVersionHistory(repoPath: string, wave?: string): Promise<PromptVersion[]> {
  let content: string;
  try {
    content = await readFile(versionsLogPath(repoPath), 'utf-8');
  } catch {
    return [];
  }

  const versions: PromptVersion[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      const result = PromptVersionSchema.safeParse(parsed);
      if (result.success) {
        versions.push(result.data);
      } else {
        log.debug(`Skipping malformed prompt version line: ${line.slice(0, 80)}`);
      }
    } catch {
      log.debug(`Skipping unparseable prompt version line: ${line.slice(0, 80)}`);
    }
  }

  if (wave) {
    return versions.filter((v) => v.wave === wave);
  }
  return versions;
}

/** Read a stored prompt snapshot by hash. Returns null if not found. */
export async function getSnapshot(repoPath: string, hash: string): Promise<string | null> {
  try {
    return await readFile(snapshotPath(repoPath, hash), 'utf-8');
  } catch {
    return null;
  }
}

/** Detect if a prompt has changed from the last recorded version for this wave. */
export async function detectPromptChange(
  repoPath: string,
  wave: string,
  currentContent: string,
): Promise<PromptChange | null> {
  const history = await getVersionHistory(repoPath, wave);
  if (history.length === 0) return null;

  const lastVersion = history[history.length - 1];
  if (!lastVersion) return null;

  const currentHash = hashPrompt(currentContent);
  if (currentHash === lastVersion.hash) return null;

  log.info(`Prompt changed for wave "${wave}": ${lastVersion.hash} → ${currentHash}`);
  return {
    wave,
    previousHash: lastVersion.hash,
    currentHash,
  };
}

/** Diff two prompt versions by hash. Returns null if either hash not found, empty string if identical. */
export async function diffVersions(repoPath: string, hash1: string, hash2: string): Promise<string | null> {
  if (hash1 === hash2) return '';

  const [content1, content2] = await Promise.all([getSnapshot(repoPath, hash1), getSnapshot(repoPath, hash2)]);

  if (content1 === null || content2 === null) return null;

  // Simple line-based diff
  const lines1 = content1.split('\n');
  const lines2 = content2.split('\n');
  const diffLines: string[] = [];

  const maxLen = Math.max(lines1.length, lines2.length);
  for (let i = 0; i < maxLen; i++) {
    const l1 = lines1[i];
    const l2 = lines2[i];
    if (l1 === l2) {
      diffLines.push(` ${l1 ?? ''}`);
    } else {
      if (l1 !== undefined) diffLines.push(`-${l1}`);
      if (l2 !== undefined) diffLines.push(`+${l2}`);
    }
  }

  return diffLines.join('\n');
}
