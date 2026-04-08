// Deterministic secrets scanner — runs before commit to catch leaked credentials.
// Orchestrator-level gate: regex-based, not AI judgment.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SecretFinding {
  file: string;
  line: number;
  type: string;
}

export interface SecretsScanResult {
  clean: boolean;
  findings: SecretFinding[];
  report: string;
}

interface SecretPattern {
  type: string;
  regex: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { type: 'GitHub PAT', regex: /ghp_[A-Za-z0-9]{36}/ },
  { type: 'Anthropic API key', regex: /sk-ant-[A-Za-z0-9-]{20,}/ },
  { type: 'AWS access key', regex: /AKIA[A-Z0-9]{16}/ },
  { type: 'Private key', regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
  { type: 'OpenAI API key', regex: /sk-proj-[A-Za-z0-9]{20,}/ },
];

function isPatternReference(line: string, match: string): boolean {
  // Skip regex literals: /ghp_[A-Za-z0-9]{36}/
  if (/\/.*\[.*\].*\//.test(line) && line.includes('[')) {
    const matchIdx = line.indexOf(match);
    // Check if the match is inside a regex character class or pattern definition
    const before = line.slice(0, matchIdx);
    if (/\/[^/]*$/.test(before) || /\[.*$/.test(before)) return true;
  }
  // Skip comments that describe patterns
  const trimmed = line.trimStart();
  if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) {
    // Only skip if the line looks like a pattern description (contains regex syntax)
    if (/\[.*\]\{?\d*,?\d*\}?/.test(line)) return true;
  }
  return false;
}

export async function scanForSecrets(workDir: string, files: string[]): Promise<SecretsScanResult> {
  const findings: SecretFinding[] = [];

  for (const file of files) {
    let content: string;
    try {
      content = await readFile(join(workDir, file), 'utf-8');
    } catch {
      continue; // file doesn't exist or can't be read
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      for (const pattern of SECRET_PATTERNS) {
        const match = pattern.regex.exec(line);
        if (match && !isPatternReference(line, match[0])) {
          findings.push({
            file,
            line: i + 1,
            type: pattern.type,
          });
        }
      }
    }
  }

  const report =
    findings.length === 0 ? 'No secrets detected.' : findings.map((f) => `${f.file}:${f.line} — ${f.type}`).join('\n');

  return {
    clean: findings.length === 0,
    findings,
    report,
  };
}
