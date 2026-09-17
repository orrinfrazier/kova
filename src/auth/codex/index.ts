// Barrel + module-level token cache for the ChatGPT/Codex subscription auth.
//
// Why a cache:
//   `resolveApiKey(provider)` in src/ai/wave-executor.ts is sync (and called
//   per wave with no async seam). Token refresh, on the other hand, is async
//   (HTTPS POST to auth.openai.com/oauth/token). The compromise: kova does
//   one async "warm-up" pass at CLI startup (`ensureFreshCodexToken`) that
//   loads from disk + refreshes if expiring, populates this cache, and then
//   the sync resolver just reads it.
//
//   Access tokens live ~1h. A fix run that exceeds 55 minutes will hit a 401
//   on the next wave. That's documented behavior for v1; a per-wave refresh
//   hook can land as a follow-up.

import { log } from '../../utils/logger.js';
import { refreshAccessToken } from './oauth.js';
import {
  type CodexCredentials,
  defaultCodexCredentialsPath,
  isExpiring,
  readCodexCredentials,
  writeCodexCredentials,
} from './storage.js';

export { loginBrowser, loginHeadless, tokensToCredentials } from './login.js';
export { CLIENT_ID, ISSUER, OAUTH_PORT } from './oauth.js';
export {
  type CodexCredentials,
  defaultCodexCredentialsPath,
  isExpiring,
  readCodexCredentials,
  writeCodexCredentials,
} from './storage.js';

/** Module-level cache populated by `ensureFreshCodexToken`. */
let cached: CodexCredentials | undefined;

/** Inject a credentials value into the cache. Tests use this; production code
 *  should call `ensureFreshCodexToken` instead. */
export function setCachedCodexCredentials(creds: CodexCredentials | undefined): void {
  cached = creds;
}

/** Read the in-memory cache without touching disk or the network. Used by
 *  `resolveApiKey('openai-codex')` for sync access to the current access token. */
export function getCachedCodexAccessToken(): string | undefined {
  return cached?.access;
}

/** Same, but the full credentials struct (for `kova auth status` and friends). */
export function getCachedCodexCredentials(): CodexCredentials | undefined {
  return cached;
}

/** Load credentials from disk and refresh-if-needed. Populates the in-memory
 *  cache. Returns the credentials on success, `undefined` if no file exists
 *  (caller can decide whether to demand login or fall back). Throws on
 *  malformed credentials or refresh failure — those are loud configuration
 *  errors that should fail-fast at startup. */
export async function ensureFreshCodexToken(args?: {
  path?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  marginMs?: number;
}): Promise<CodexCredentials | undefined> {
  const path = args?.path ?? defaultCodexCredentialsPath();
  const now = args?.now ?? Date.now;
  const creds = readCodexCredentials(path);
  if (!creds) {
    setCachedCodexCredentials(undefined);
    return undefined;
  }

  if (!isExpiring(creds, args?.marginMs, now())) {
    setCachedCodexCredentials(creds);
    return creds;
  }

  log.info('Refreshing expiring Codex access token');
  const tokens = await refreshAccessToken({ refreshToken: creds.refresh, fetchImpl: args?.fetchImpl });
  const refreshed: CodexCredentials = {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: creds.accountId,
  };
  writeCodexCredentials(refreshed, path);
  setCachedCodexCredentials(refreshed);
  return refreshed;
}

/** Provider name that pi-ai's `openai-codex-responses` registers under, and
 *  that kova users put in `repos.yaml providers.tiers` to opt in.
 *  See pi-ai/packages/ai/src/providers/register-builtins.ts. */
export const CODEX_PROVIDER = 'openai-codex' as const;

/** Env var override — lets CI inject a pre-extracted access token without
 *  running the OAuth flow. Falls back to disk + cache when unset. */
export const CODEX_ACCESS_TOKEN_ENV = 'OPENAI_CODEX_API_KEY' as const;

/** Sync probe used by `hasApiKey` at startup validation time. Considers an
 *  env-var token, an in-memory cache, OR a credentials file as "we have auth".
 *  Does NOT refresh — startup validation is sync, the async refresh happens in
 *  `ensureFreshCodexToken` immediately afterward. */
export function hasCodexCredentials(path?: string): boolean {
  if (process.env[CODEX_ACCESS_TOKEN_ENV]) return true;
  if (cached) return true;
  try {
    return readCodexCredentials(path) !== undefined;
  } catch {
    return false;
  }
}
