// Deterministic static pre-scan over diff-added lines — orchestrator-side
// fail-closed gate for the review wave. Scans for secrets (reusing the
// secrets-scan patterns) and injection/eval primitives. Any hit is a confirmed
// blocking finding that forces verdict = needs_fixes regardless of the model's
// judgment.

import { $ } from 'zx';

$.verbose = false;

export interface PrescanFinding {
  file: string;
  /** 1-based line number within the file's new content, when extractable. */
  line: number | null;
  /** Short label of the pattern that fired (e.g. "GitHub PAT", "eval()"). */
  type: string;
  /** The actual added-diff line, trimmed for the summary. */
  snippet: string;
}

export interface PrescanResult {
  findings: PrescanFinding[];
  /** True iff any pattern fired — orchestrator forces needs_fixes when true. */
  blocking: boolean;
  /** Human-readable summary for the reviewer's user message. */
  summary: string;
}

interface Pattern {
  type: string;
  regex: RegExp;
}

// Secret patterns mirror src/services/secrets-scan.ts SECRET_PATTERNS.
// Kept inline (not imported) so the pre-scan can evolve independently from
// the commit-time scan and so we can add deterministic injection/eval
// patterns alongside without conflating concerns.
const SECRET_PATTERNS: Pattern[] = [
  { type: 'GitHub PAT', regex: /ghp_[A-Za-z0-9]{36}/ },
  { type: 'Anthropic API key', regex: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { type: 'AWS access key', regex: /AKIA[A-Z0-9]{16}/ },
  { type: 'Private key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { type: 'OpenAI API key', regex: /sk-proj-[A-Za-z0-9]{20,}/ },
];

// Injection / eval primitives. These are CONSERVATIVE — they fire only on
// constructs that are dangerous in nearly all contexts. Comments and pattern
// references are filtered out via isPatternReference().
const INJECTION_PATTERNS: Pattern[] = [
  { type: 'eval()', regex: /(?:^|[^a-zA-Z0-9_$])eval\s*\(/ },
  { type: 'new Function()', regex: /new\s+Function\s*\(/ },
  // child_process exec with string concat / template literal — the safe form
  // is execFile() with array args. We flag the dangerous string form.
  { type: 'child_process.exec()', regex: /child_process\.exec\s*\(/ },
];

const ALL_PATTERNS: Pattern[] = [...SECRET_PATTERNS, ...INJECTION_PATTERNS];

function isPatternReference(line: string, match: string): boolean {
  // Skip regex literals: /ghp_[A-Za-z0-9]{36}/ — the secrets-scan service
  // has the same heuristic. We mirror it so adding a new pattern to the
  // pre-scan list doesn't break secrets-scan.test.ts coverage of regex defs.
  if (/\/.*\[.*\].*\//.test(line) && line.includes('[')) {
    const matchIdx = line.indexOf(match);
    const before = line.slice(0, matchIdx);
    if (/\/[^/]*$/.test(before) || /\[.*$/.test(before)) return true;
  }
  // Skip comments that describe patterns.
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
    if (/\[.*\]\{?\d*,?\d*\}?/.test(line)) return true;
  }
  return false;
}

/** Parse a unified diff into { file, addedLines: [{ lineNo, content }] }. */
interface DiffSection {
  file: string;
  added: Array<{ lineNo: number; content: string }>;
}

function parseUnifiedDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  let current: DiffSection | null = null;
  let newLineNo = 0;

  const lines = diff.split('\n');
  for (const raw of lines) {
    // New file header: "+++ b/path/to/file" or "+++ /dev/null"
    if (raw.startsWith('+++ ')) {
      const target = raw.slice(4).trim();
      if (target === '/dev/null') {
        // File is being deleted — no added lines to scan.
        current = null;
        continue;
      }
      // Strip the "b/" prefix that `git diff` emits.
      const file = target.startsWith('b/') ? target.slice(2) : target;
      current = { file, added: [] };
      sections.push(current);
      continue;
    }
    if (raw.startsWith('--- ')) continue;
    if (raw.startsWith('diff --git ')) continue;
    if (raw.startsWith('index ')) continue;

    // Hunk header: @@ -A,B +C,D @@ ...
    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunkMatch && hunkMatch[1] != null) {
      newLineNo = Number.parseInt(hunkMatch[1], 10);
      continue;
    }

    if (current === null) continue;

    if (raw.startsWith('+')) {
      // Skip the "+++ " header (already handled above).
      const content = raw.slice(1);
      current.added.push({ lineNo: newLineNo, content });
      newLineNo += 1;
    } else if (raw.startsWith('-')) {
      // Removed line — does not advance newLineNo.
    } else {
      // Context line.
      newLineNo += 1;
    }
  }

  return sections;
}

/**
 * Run the deterministic pre-scan over added-diff lines in `workDir`.
 *
 * Covers:
 * - Modified tracked files (`git diff HEAD` for added lines).
 * - Untracked new files (treated as fully added).
 *
 * Returns a list of findings + a blocking flag. The summary is suitable for
 * injecting into the reviewer's user message as confirmed data.
 */
export async function scanDiffForBlockingFindings(workDir: string): Promise<PrescanResult> {
  const findings: PrescanFinding[] = [];

  // 1) Modified tracked files — `git diff HEAD` against the working tree.
  let unifiedDiff = '';
  try {
    const diff = await $`git -C ${workDir} diff HEAD --unified=0`;
    unifiedDiff = diff.stdout;
  } catch {
    // No HEAD yet, or not a git repo — fall through to untracked scan.
    unifiedDiff = '';
  }

  for (const section of parseUnifiedDiff(unifiedDiff)) {
    for (const { lineNo, content } of section.added) {
      for (const pattern of ALL_PATTERNS) {
        const match = pattern.regex.exec(content);
        if (match && !isPatternReference(content, match[0])) {
          findings.push({
            file: section.file,
            line: lineNo,
            type: pattern.type,
            snippet: content.trim().slice(0, 200),
          });
        }
      }
    }
  }

  // 2) Untracked files — scan in full (every line is "added" relative to the
  // pre-impl baseline).
  let untrackedFiles: string[] = [];
  try {
    const ls = await $`git -C ${workDir} ls-files --others --exclude-standard`;
    untrackedFiles = ls.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    untrackedFiles = [];
  }

  for (const file of untrackedFiles) {
    let content: string;
    try {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      content = await readFile(join(workDir, file), 'utf-8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line == null) continue;
      for (const pattern of ALL_PATTERNS) {
        const match = pattern.regex.exec(line);
        if (match && !isPatternReference(line, match[0])) {
          findings.push({
            file,
            line: i + 1,
            type: pattern.type,
            snippet: line.trim().slice(0, 200),
          });
        }
      }
    }
  }

  const blocking = findings.length > 0;
  const summary =
    findings.length === 0
      ? 'No static pre-scan findings.'
      : findings.map((f) => `${f.file}${f.line != null ? `:${f.line}` : ''} — ${f.type}`).join('\n');

  return { findings, blocking, summary };
}
