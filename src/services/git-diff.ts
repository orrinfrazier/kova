// Incremental diff detection — track which source files changed since last index.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { $ } from 'zx';

$.verbose = false;

export const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.ts',
  '.js',
  '.rs',
  '.go',
  '.py',
  '.java',
  '.rb',
  '.c',
  '.cpp',
  '.h',
]);

const SHA_FILE = join('.kova', 'last-index-sha.txt');

export async function getLastIndexedSha(repoPath: string): Promise<string | null> {
  const filePath = join(repoPath, SHA_FILE);
  try {
    const content = await readFile(filePath, 'utf-8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

export async function saveLastIndexedSha(repoPath: string, sha: string): Promise<void> {
  const kovaDir = join(repoPath, '.kova');
  await mkdir(kovaDir, { recursive: true });
  await writeFile(join(kovaDir, 'last-index-sha.txt'), sha);
}

function filterSourceFiles(files: string[]): string[] {
  return files.filter((f) => {
    const lastDot = f.lastIndexOf('.');
    if (lastDot === -1) return false;
    const ext = f.slice(lastDot);
    return SOURCE_EXTENSIONS.has(ext);
  });
}

export async function getCurrentHeadSha(repoPath: string): Promise<string> {
  const result = await $`git -C ${repoPath} rev-parse HEAD`;
  return result.stdout.trim();
}

/** Alias for getChangedFiles — returns files changed since the given SHA (or all files if null). */
export async function getChangedFilesSince(repoPath: string, sinceSha: string | null): Promise<string[]> {
  return getChangedFiles(repoPath, sinceSha);
}

export async function getChangedFiles(repoPath: string, sinceSha: string | null): Promise<string[]> {
  if (sinceSha === null) {
    // Full index: return all tracked source files
    const result = await $`git -C ${repoPath} ls-files`;
    const files = result.stdout.trim().split('\n').filter(Boolean);
    return filterSourceFiles(files);
  }

  // Incremental: files changed since the given SHA
  const result = await $`git -C ${repoPath} diff --name-only ${sinceSha} HEAD`;
  const files = result.stdout.trim().split('\n').filter(Boolean);
  return filterSourceFiles(files);
}
