// Persistent storage for ChatGPT/Codex OAuth credentials.
//
// File: ~/.kova/auth/openai.json (0600 perms, ~/.kova/auth dir is 0700).
// Shape: { type:'oauth', access, refresh, expires, accountId? }.
//
// `expires` is an absolute epoch-ms timestamp (Date.now() + expires_in*1000).

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Persisted credential shape. */
export interface CodexCredentials {
  type: 'oauth';
  /** Access token (JWT) — pi-ai passes this verbatim as the `apiKey`. */
  access: string;
  /** Refresh token (opaque) — used to mint a new access token before expiry. */
  refresh: string;
  /** Absolute epoch-ms at which `access` is no longer accepted. */
  expires: number;
  /** ChatGPT account id (extracted from access_token JWT claims). Optional —
   *  pi-ai's provider re-extracts from the access_token, so storage is purely
   *  a UX hint (e.g. for `kova auth status`). */
  accountId?: string | undefined;
}

/** Resolve the default credentials file path, honoring `KOVA_AUTH_DIR` for
 *  tests and headless CI runs that don't want to touch the user's `~/.kova/`. */
export function defaultCodexCredentialsPath(): string {
  const dir = process.env.KOVA_AUTH_DIR ?? join(homedir(), '.kova', 'auth');
  return join(dir, 'openai.json');
}

/** Read credentials from disk. Returns `undefined` if the file is missing.
 *  Throws on malformed JSON or schema mismatch — never returns garbage. */
export function readCodexCredentials(path: string = defaultCodexCredentialsPath()): CodexCredentials | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Partial<CodexCredentials>;
  if (parsed.type !== 'oauth' || typeof parsed.access !== 'string' || typeof parsed.refresh !== 'string') {
    throw new Error(`Malformed credentials at ${path}: missing required fields`);
  }
  if (typeof parsed.expires !== 'number') {
    throw new Error(`Malformed credentials at ${path}: expires must be a number`);
  }
  return parsed as CodexCredentials;
}

/** Write credentials to disk with restrictive perms (dir 0700, file 0600).
 *  Creates parent dir if missing. Overwrites atomically by writing then chmod. */
export function writeCodexCredentials(creds: CodexCredentials, path: string = defaultCodexCredentialsPath()): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    try {
      chmodSync(dir, 0o700);
    } catch {
      // best-effort; on systems without POSIX perms (e.g. Windows) chmod is a no-op anyway
    }
  }
  writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort, same reason as above
  }
}

/** Token is "expiring" when remaining lifetime < margin (ms). Default margin
 *  is 5 minutes — enough headroom for a wave to start without re-auth flakes. */
export function isExpiring(creds: CodexCredentials, marginMs = 5 * 60 * 1000, now = Date.now()): boolean {
  return creds.expires - now < marginMs;
}
