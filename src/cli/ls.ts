// `kova ls` — list active and recent fix runs from the on-disk RunRegistry.
//
// Mirrors the tmux idiom that an attachable session is discoverable: `tmux ls`
// before `tmux attach`. The on-disk registry (services/run-registry.ts) is the
// canonical source — we just gather + render. Newest-first ordering keeps the
// most relevant run on the first row for the common "I just started one"
// workflow.

import { listRuns, type Run } from '../services/run-registry.js';

export interface LsResult {
  runs: Run[];
}

export async function gatherLs(repoPath: string): Promise<LsResult> {
  const runs = await listRuns(repoPath);
  // Newest first — matches `tmux ls` order (most recently created at top).
  runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
  return { runs };
}

function formatRelativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function formatLsTable(result: LsResult): string {
  if (result.runs.length === 0) {
    return 'No active runs.';
  }

  const headers = ['Run ID', 'Issue', 'Repo', 'Status', 'Started', 'Wave'];
  const rows: string[][] = result.runs.map((r) => [
    r.runId,
    r.issueNumber != null ? `#${r.issueNumber}` : '—',
    r.repoId,
    r.status,
    formatRelativeDate(r.startedAt),
    r.currentWave ?? '—',
  ]);

  const widths = headers.map((h, i) => {
    const maxDataWidth = Math.max(...rows.map((row) => (row[i] ?? '').length), 0);
    return Math.max(h.length, maxDataWidth);
  });

  const headerLine = headers.map((h, i) => pad(h, widths[i] ?? h.length)).join('  ');
  const separatorLine = widths.map((w) => '─'.repeat(w)).join('  ');
  const dataLines = rows.map((row) => row.map((cell, i) => pad(cell, widths[i] ?? cell.length)).join('  '));

  return [headerLine, separatorLine, ...dataLines, separatorLine].join('\n');
}
