// Brainstorm history — track past brainstorm cycles to detect diminishing returns.

import { fs, path } from 'zx';
import type { BrainstormIssue } from '../types/index.js';
import { log } from '../utils/logger.js';

export interface BrainstormCycleEntry {
  title: string;
  category: string;
}

export interface BrainstormCycle {
  timestamp: string;
  issues: BrainstormCycleEntry[];
  summary?: string;
}

export interface BrainstormHistory {
  cycles: BrainstormCycle[];
}

export interface DiminishingReturnsReport {
  overlapPercent: number;
  novelCount: number;
  isStale: boolean;
  shouldStop: boolean;
  novelIssues: string[];
  duplicateIssues: string[];
}

function historyPath(repoPath: string): string {
  return path.join(repoPath, '.kova', 'brainstorm-history.json');
}

export async function loadHistory(repoPath: string): Promise<BrainstormHistory> {
  const filePath = historyPath(repoPath);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as BrainstormHistory;
  } catch {
    return { cycles: [] };
  }
}

export async function appendCycle(repoPath: string, cycle: BrainstormCycle): Promise<void> {
  const history = await loadHistory(repoPath);
  history.cycles.push(cycle);

  const filePath = historyPath(repoPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(history, null, 2));
  log.debug(`Brainstorm history: ${history.cycles.length} cycle(s) recorded`);
}

/** Jaccard similarity on lowercased word sets. Returns 0–1. */
export function titleSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

const SIMILARITY_THRESHOLD = 0.7;

export function detectDiminishingReturns(
  newIssues: BrainstormIssue[],
  history: BrainstormHistory,
): DiminishingReturnsReport {
  if (newIssues.length === 0) {
    return {
      overlapPercent: 0,
      novelCount: 0,
      isStale: false,
      shouldStop: true,
      novelIssues: [],
      duplicateIssues: [],
    };
  }

  // Collect all historical titles
  const historicalTitles = history.cycles.flatMap((c) => c.issues.map((i) => i.title));

  const novelIssues: string[] = [];
  const duplicateIssues: string[] = [];

  for (const issue of newIssues) {
    const isDuplicate = historicalTitles.some((hist) => titleSimilarity(issue.title, hist) >= SIMILARITY_THRESHOLD);
    if (isDuplicate) {
      duplicateIssues.push(issue.title);
    } else {
      novelIssues.push(issue.title);
    }
  }

  const overlapPercent = Math.round((duplicateIssues.length / newIssues.length) * 100);

  return {
    overlapPercent,
    novelCount: novelIssues.length,
    isStale: overlapPercent > 50,
    shouldStop: novelIssues.length < 2,
    novelIssues,
    duplicateIssues,
  };
}
