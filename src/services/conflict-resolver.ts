// Conflict resolution service — attempts to auto-resolve rebase conflicts.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'zx';
import { log } from '../utils/logger.js';

$.verbose = false;

export type ConflictResult =
  | { resolved: true; filesResolved: string[] }
  | { resolved: false; filesUnresolved: string[] };

interface ConflictBlock {
  /** Lines from the current (ours) side */
  ours: string[];
  /** Lines from the incoming (theirs) side */
  theirs: string[];
  /** Lines from the base (ancestor) side, if diff3 markers present */
  base: string[];
}

/**
 * Parse a file's content into resolved lines and conflict blocks.
 * Returns null if no conflict markers are found.
 */
function parseConflictMarkers(content: string): {
  sections: Array<{ type: 'clean'; lines: string[] } | { type: 'conflict'; block: ConflictBlock }>;
} | null {
  const lines = content.split('\n');
  const sections: Array<{ type: 'clean'; lines: string[] } | { type: 'conflict'; block: ConflictBlock }> = [];
  let currentClean: string[] = [];
  let inConflict = false;
  let side: 'ours' | 'base' | 'theirs' = 'ours';
  let ours: string[] = [];
  let base: string[] = [];
  let theirs: string[] = [];

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      if (currentClean.length > 0) {
        sections.push({ type: 'clean', lines: currentClean });
        currentClean = [];
      }
      inConflict = true;
      side = 'ours';
      ours = [];
      base = [];
      theirs = [];
    } else if (inConflict && line.startsWith('|||||||')) {
      // diff3 base marker
      side = 'base';
    } else if (inConflict && line.startsWith('=======')) {
      side = 'theirs';
    } else if (inConflict && line.startsWith('>>>>>>>')) {
      sections.push({ type: 'conflict', block: { ours, theirs, base } });
      inConflict = false;
    } else if (inConflict) {
      if (side === 'ours') ours.push(line);
      else if (side === 'base') base.push(line);
      else theirs.push(line);
    } else {
      currentClean.push(line);
    }
  }

  if (currentClean.length > 0) {
    sections.push({ type: 'clean', lines: currentClean });
  }

  const hasConflicts = sections.some((s) => s.type === 'conflict');
  if (!hasConflicts) return null;

  return { sections };
}

/**
 * Try to auto-resolve a single conflict block.
 * Returns the resolved lines if possible, or null if unresolvable.
 *
 * Strategy: if ours and theirs both modify the same line(s) differently
 * from the original, it's unresolvable. If they modify different
 * content (non-overlapping), we can combine.
 */
function tryResolveBlock(block: ConflictBlock): string[] | null {
  const { ours, theirs } = block;

  // If both sides are identical, just pick one
  if (ours.join('\n') === theirs.join('\n')) {
    return ours;
  }

  // If one side is empty, take the other
  if (ours.length === 0) return theirs;
  if (theirs.length === 0) return ours;

  // Both sides have content and they differ — this is a true conflict
  // on the same lines. We cannot auto-resolve this.
  return null;
}

/**
 * Attempt to auto-resolve conflicts in a single file.
 * Returns the resolved content string, or null if unresolvable.
 */
function tryResolveFile(content: string): string | null {
  const parsed = parseConflictMarkers(content);
  if (!parsed) return content; // No conflicts

  const resolvedLines: string[] = [];

  for (const section of parsed.sections) {
    if (section.type === 'clean') {
      resolvedLines.push(...section.lines);
    } else {
      const resolved = tryResolveBlock(section.block);
      if (resolved === null) return null; // Unresolvable
      resolvedLines.push(...resolved);
    }
  }

  return resolvedLines.join('\n');
}

/**
 * Resolve rebase conflicts in the given working directory.
 *
 * 1. Fetch origin and attempt rebase onto origin/{defaultBranch}
 * 2. If no conflicts, return resolved
 * 3. If conflicts, attempt auto-resolution by parsing conflict markers
 * 4. If all files resolved, continue rebase
 * 5. If any file unresolvable, abort rebase and return unresolved
 */
export async function resolveConflicts(workDir: string, defaultBranch: string): Promise<ConflictResult> {
  // Fetch latest
  await $`git -C ${workDir} fetch origin`;

  // Record the current HEAD before rebase so we can detect auto-merged files
  const headBefore = (await $`git -C ${workDir} rev-parse HEAD`).stdout.trim();

  // Find the merge base between our branch and origin/default to detect overlapping files
  let mergeBase: string;
  try {
    mergeBase = (await $`git -C ${workDir} merge-base HEAD origin/${defaultBranch}`).stdout.trim();
  } catch {
    mergeBase = headBefore;
  }

  // Files changed on our branch since the merge base
  const oursChanged = new Set(
    (await $`git -C ${workDir} diff --name-only ${mergeBase}..HEAD`).stdout.trim().split('\n').filter(Boolean),
  );

  // Files changed on target since the merge base
  const theirsChanged = new Set(
    (await $`git -C ${workDir} diff --name-only ${mergeBase}..origin/${defaultBranch}`).stdout
      .trim()
      .split('\n')
      .filter(Boolean),
  );

  // Files modified on both sides — these are potential conflict files
  const bothSides = [...oursChanged].filter((f) => theirsChanged.has(f));

  // Attempt rebase
  try {
    await $`git -C ${workDir} rebase origin/${defaultBranch}`;
    // No conflicts — rebase succeeded cleanly, but files touched on both
    // sides were auto-merged by git
    return { resolved: true, filesResolved: bothSides };
  } catch {
    log.debug('Rebase conflict detected, attempting auto-resolution');
  }

  // Get list of conflicted files
  let conflictFiles: string[];
  try {
    const result = await $`git -C ${workDir} diff --name-only --diff-filter=U`;
    conflictFiles = result.stdout.trim().split('\n').filter(Boolean);
  } catch {
    // Can't determine conflicts — abort and report failure
    await safeAbortRebase(workDir);
    return { resolved: false, filesUnresolved: [] };
  }

  if (conflictFiles.length === 0) {
    await safeAbortRebase(workDir);
    return { resolved: false, filesUnresolved: [] };
  }

  const filesResolved: string[] = [];
  const filesUnresolved: string[] = [];

  for (const file of conflictFiles) {
    const filePath = join(workDir, file);
    const content = await readFile(filePath, 'utf-8');
    const resolved = tryResolveFile(content);

    if (resolved !== null) {
      await writeFile(filePath, resolved);
      await $`git -C ${workDir} add ${file}`;
      filesResolved.push(file);
    } else {
      filesUnresolved.push(file);
    }
  }

  if (filesUnresolved.length > 0) {
    // Cannot resolve all files — abort rebase
    await safeAbortRebase(workDir);
    return { resolved: false, filesUnresolved };
  }

  // All conflicts resolved — continue rebase
  try {
    await $`git -C ${workDir} -c core.editor=true rebase --continue`;
    return { resolved: true, filesResolved };
  } catch {
    // Rebase continue failed — abort
    await safeAbortRebase(workDir);
    return { resolved: false, filesUnresolved: conflictFiles };
  }
}

async function safeAbortRebase(workDir: string): Promise<void> {
  try {
    await $`git -C ${workDir} rebase --abort`;
  } catch {
    // Best effort
  }
}
