// OAuth + PKCE primitives for ChatGPT Pro/Plus (Codex) subscription auth.
//
// Wire shape (mirrors opencode/packages/opencode/src/plugin/codex.ts):
//   - PKCE-S256 verifier + challenge
//   - Authorize URL: auth.openai.com/oauth/authorize with codex CLI's CLIENT_ID
//   - Token exchange + refresh: auth.openai.com/oauth/token
//   - Headless device-code variant: auth.openai.com/api/accounts/deviceauth/{usercode,token}
//   - Account-ID extraction from id_token / access_token JWT claims
//
// The pi-ai openai-codex-responses provider (registered automatically by
// `registerBuiltInApiProviders`) accepts the access_token as `apiKey` and
// extracts the ChatGPT-Account-Id from the JWT internally, so kova only
// needs to surface the raw access token via `resolveApiKey`.

import { createHash, randomBytes } from 'node:crypto';

/** OAuth client_id registered for the public Codex CLI. Reused here so kova
 *  rides on the same ChatGPT subscription billing path as the official CLI
 *  (and as opencode / pi-mono). */
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** OAuth issuer + endpoint roots. */
export const ISSUER = 'https://auth.openai.com';

/** Localhost port the browser-callback flow listens on. Matches opencode/codex
 *  CLI defaults so users can reuse existing browser cookies. */
export const OAUTH_PORT = 1455;

/** Device-flow polling safety margin — added to the interval the server returns
 *  to avoid premature requests during the device authorization window. */
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000;

/** PKCE pair — verifier is the secret, challenge goes in the authorize URL. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** Generate a PKCE-S256 verifier + challenge per RFC 7636.
 *  Verifier is 43 chars from the unreserved set; challenge is base64url(SHA256(verifier)). */
export function generatePkce(): PkcePair {
  const verifier = randomVerifier(43);
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Random unreserved-charset string of `length` chars. */
function randomVerifier(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    out += chars[byte % chars.length];
  }
  return out;
}

/** Base64-URL encode (RFC 4648 §5) — no padding, +/= → -_/empty. */
export function base64UrlEncode(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Generate a fresh CSRF `state` value (32 random bytes, base64url-encoded). */
export function generateState(): string {
  return base64UrlEncode(randomBytes(32));
}

/** Build the OAuth authorize URL kova opens in the user's browser.
 *  `originator=kova` lets the OpenAI side identify the caller (opencode uses 'opencode'). */
export function buildAuthorizeUrl(redirectUri: string, pkce: PkcePair, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: 'openid profile email offline_access',
    code_challenge: pkce.challenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'kova',
  });
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

/** Token response from auth.openai.com — fields we consume. */
export interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

/** Exchange an authorization code (browser-flow callback) for tokens. */
export async function exchangeCodeForTokens(args: {
  code: string;
  redirectUri: string;
  pkce: PkcePair;
  fetchImpl?: typeof fetch | undefined;
}): Promise<TokenResponse> {
  const doFetch = args.fetchImpl ?? fetch;
  const response = await doFetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
      client_id: CLIENT_ID,
      code_verifier: args.pkce.verifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text().catch(() => '')}`.trim());
  }
  return (await response.json()) as TokenResponse;
}

/** Refresh an access token using a stored refresh_token. */
export async function refreshAccessToken(args: {
  refreshToken: string;
  fetchImpl?: typeof fetch | undefined;
}): Promise<TokenResponse> {
  const doFetch = args.fetchImpl ?? fetch;
  const response = await doFetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: args.refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status} ${await response.text().catch(() => '')}`.trim());
  }
  return (await response.json()) as TokenResponse;
}

// --- JWT claim parsing (for ChatGPT-Account-Id) ----------------------------

/** Subset of id_token / access_token claims we consume. */
export interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  'https://api.openai.com/auth'?: {
    chatgpt_account_id?: string;
  };
}

/** Parse the middle (payload) segment of a JWT. Returns `undefined` for malformed input.
 *  Note: we do NOT verify the signature — these tokens were just minted by
 *  auth.openai.com for us. */
export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const payload = parts[1];
  if (!payload) return undefined;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()) as IdTokenClaims;
  } catch {
    return undefined;
  }
}

/** Walk the claim variants the OpenAI auth server uses for account id. */
export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims['https://api.openai.com/auth']?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

/** Prefer id_token's account-id claim, fall back to access_token's. */
export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const id = claims && extractAccountIdFromClaims(claims);
    if (id) return id;
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    return claims ? extractAccountIdFromClaims(claims) : undefined;
  }
  return undefined;
}

// --- Headless device-code flow --------------------------------------------

/** Initial response from the device-auth endpoint. */
export interface DeviceAuthInit {
  device_auth_id: string;
  user_code: string;
  interval: string;
}

/** Begin the device-code flow. Returns the user_code to display + the polling id. */
export async function startDeviceAuth(args: {
  userAgent: string;
  fetchImpl?: typeof fetch | undefined;
}): Promise<DeviceAuthInit> {
  const doFetch = args.fetchImpl ?? fetch;
  const response = await doFetch(`${ISSUER}/api/accounts/deviceauth/usercode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': args.userAgent,
    },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  if (!response.ok) throw new Error(`Failed to initiate device authorization: ${response.status}`);
  return (await response.json()) as DeviceAuthInit;
}

/** Poll-for-token response (intermediate step in device flow). */
export interface DeviceAuthPollSuccess {
  authorization_code: string;
  code_verifier: string;
}

/** One poll of the device-auth token endpoint.
 *  Returns `{ ok: true, data }` on success, `{ ok: false, retry }` when still pending. */
export async function pollDeviceAuth(args: {
  deviceAuthId: string;
  userCode: string;
  userAgent: string;
  fetchImpl?: typeof fetch | undefined;
}): Promise<{ ok: true; data: DeviceAuthPollSuccess } | { ok: false; retry: boolean; status: number }> {
  const doFetch = args.fetchImpl ?? fetch;
  const response = await doFetch(`${ISSUER}/api/accounts/deviceauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': args.userAgent,
    },
    body: JSON.stringify({
      device_auth_id: args.deviceAuthId,
      user_code: args.userCode,
    }),
  });
  if (response.ok) {
    return { ok: true, data: (await response.json()) as DeviceAuthPollSuccess };
  }
  const retry = response.status === 403 || response.status === 404;
  return { ok: false, retry, status: response.status };
}

/** Exchange a device-flow authorization_code (NOT a browser-flow code) for tokens. */
export async function exchangeDeviceCode(args: {
  authorizationCode: string;
  codeVerifier: string;
  fetchImpl?: typeof fetch | undefined;
}): Promise<TokenResponse> {
  const doFetch = args.fetchImpl ?? fetch;
  const response = await doFetch(`${ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: args.authorizationCode,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: args.codeVerifier,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${await response.text().catch(() => '')}`.trim());
  }
  return (await response.json()) as TokenResponse;
}
