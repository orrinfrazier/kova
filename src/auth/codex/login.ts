// Orchestration for the two Codex OAuth flows:
//   - `loginBrowser()`: opens a system browser to the authorize URL, runs a
//     short-lived loopback server on :1455 for the callback, exchanges the
//     code → tokens, persists.
//   - `loginHeadless()`: device-code flow for SSH / headless boxes — prints a
//     user_code and polls the device-auth endpoint until the user finishes
//     login in *their* browser.
//
// Both return the parsed TokenResponse and persist credentials via storage.ts.

import { createServer, type Server } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  exchangeDeviceCode,
  extractAccountId,
  generatePkce,
  generateState,
  OAUTH_POLLING_SAFETY_MARGIN_MS,
  OAUTH_PORT,
  type PkcePair,
  pollDeviceAuth,
  startDeviceAuth,
  type TokenResponse,
} from './oauth.js';
import { type CodexCredentials, writeCodexCredentials } from './storage.js';

/** Convert a TokenResponse into the persisted credentials shape. */
export function tokensToCredentials(tokens: TokenResponse, now = Date.now()): CodexCredentials {
  return {
    type: 'oauth',
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: now + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractAccountId(tokens),
  };
}

/** Listener handle returned by `startBrowserCallbackServer`. Caller MUST await
 *  `tokensPromise` and call `close()` when done (success or error). */
export interface BrowserCallbackHandle {
  redirectUri: string;
  tokensPromise: Promise<TokenResponse>;
  close: () => void;
}

/** Start a single-shot loopback HTTP server that handles the OAuth redirect.
 *  Resolves `tokensPromise` with the exchanged tokens; rejects on error or
 *  /cancel. The server stays up until `close()` is called. */
export function startBrowserCallbackServer(args: {
  pkce: PkcePair;
  state: string;
  port?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
}): BrowserCallbackHandle {
  const port = args.port ?? OAUTH_PORT;
  const redirectUri = `http://localhost:${port}/auth/callback`;

  let server: Server | undefined;

  const tokensPromise = new Promise<TokenResponse>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);

      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        const errorDesc = url.searchParams.get('error_description');

        if (error) {
          const msg = errorDesc || error;
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(htmlError(msg));
          reject(new Error(msg));
          return;
        }
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(htmlError('Missing authorization code'));
          reject(new Error('Missing authorization code'));
          return;
        }
        if (state !== args.state) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(htmlError('Invalid state — potential CSRF'));
          reject(new Error('Invalid state — potential CSRF'));
          return;
        }

        exchangeCodeForTokens({ code, redirectUri, pkce: args.pkce, fetchImpl: args.fetchImpl })
          .then((tokens) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(htmlSuccess());
            resolve(tokens);
          })
          .catch((err) => {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(htmlError(String(err instanceof Error ? err.message : err)));
            reject(err);
          });
        return;
      }

      if (url.pathname === '/cancel') {
        res.writeHead(200);
        res.end('Login cancelled');
        reject(new Error('Login cancelled'));
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.on('error', reject);
    server.listen(port);
  });

  return {
    redirectUri,
    tokensPromise,
    close: () => server?.close(),
  };
}

/** Run the browser-callback OAuth flow end-to-end. Caller is responsible for
 *  driving the user to `authorizeUrl` (printing it or shelling out to `open`).
 *  Returns the persisted credentials. */
export async function loginBrowser(args: {
  /** Called with the authorize URL — caller decides whether to print, open in
   *  browser, etc. Defaults to printing the URL to stderr. */
  presentUrl?: (url: string) => void;
  port?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch | undefined;
  writeCredentials?: (creds: CodexCredentials) => void;
}): Promise<CodexCredentials> {
  const pkce = generatePkce();
  const state = generateState();
  const handle = startBrowserCallbackServer({ pkce, state, port: args.port, fetchImpl: args.fetchImpl });
  const url = buildAuthorizeUrl(handle.redirectUri, pkce, state);

  (args.presentUrl ?? defaultPresentUrl)(url);

  const timeoutMs = args.timeoutMs ?? 5 * 60 * 1000;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error('OAuth callback timeout — authorization took too long')),
      timeoutMs,
    );
  });

  try {
    const tokens = await Promise.race([handle.tokensPromise, timeoutPromise]);
    const creds = tokensToCredentials(tokens);
    (args.writeCredentials ?? writeCodexCredentials)(creds);
    return creds;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    handle.close();
  }
}

/** Run the headless device-code flow. Caller is responsible for displaying the
 *  user_code (defaults to stderr). Polls until the user approves in their browser. */
export async function loginHeadless(args: {
  userAgent: string;
  presentCode?: (info: { userCode: string; url: string }) => void;
  fetchImpl?: typeof fetch | undefined;
  sleepImpl?: (ms: number) => Promise<void>;
  writeCredentials?: (creds: CodexCredentials) => void;
}): Promise<CodexCredentials> {
  const fetchImpl = args.fetchImpl;
  const sleepImpl = args.sleepImpl ?? sleep;

  const init = await startDeviceAuth({ userAgent: args.userAgent, fetchImpl });
  const intervalMs = Math.max(Number.parseInt(init.interval, 10) || 5, 1) * 1000;

  (args.presentCode ?? defaultPresentCode)({
    userCode: init.user_code,
    url: `https://auth.openai.com/codex/device`,
  });

  // Poll until success or fatal error
  while (true) {
    const poll = await pollDeviceAuth({
      deviceAuthId: init.device_auth_id,
      userCode: init.user_code,
      userAgent: args.userAgent,
      fetchImpl,
    });
    if (poll.ok) {
      const tokens = await exchangeDeviceCode({
        authorizationCode: poll.data.authorization_code,
        codeVerifier: poll.data.code_verifier,
        fetchImpl,
      });
      const creds = tokensToCredentials(tokens);
      (args.writeCredentials ?? writeCodexCredentials)(creds);
      return creds;
    }
    if (!poll.retry) {
      throw new Error(`Device auth poll failed with status ${poll.status}`);
    }
    await sleepImpl(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS);
  }
}

// --- UX defaults ----------------------------------------------------------

function defaultPresentUrl(url: string): void {
  process.stderr.write(`\nOpen this URL in your browser to authorize kova:\n\n  ${url}\n\nWaiting for callback…\n`);
}

function defaultPresentCode(info: { userCode: string; url: string }): void {
  process.stderr.write(`\nGo to ${info.url} and enter this code:\n\n  ${info.userCode}\n\nWaiting for approval…\n`);
}

function htmlSuccess(): string {
  return `<!doctype html><html><head><title>Kova — Authorization Successful</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0e0e10;color:#f5f5f7}h1{margin-bottom:.5rem}p{color:#a1a1aa}</style>
</head><body><div><h1>Authorization Successful</h1><p>You can close this window and return to kova.</p></div>
<script>setTimeout(()=>window.close(),1500)</script></body></html>`;
}

function htmlError(message: string): string {
  const safe = message.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c);
  return `<!doctype html><html><head><title>Kova — Authorization Failed</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0e0e10;color:#f5f5f7}h1{color:#fc533a;margin-bottom:.5rem}.err{color:#ff917b;font-family:monospace;background:#3c140d;padding:1rem;border-radius:.5rem;margin-top:1rem;max-width:520px}</style>
</head><body><div><h1>Authorization Failed</h1><p>An error occurred during authorization.</p><div class="err">${safe}</div></div></body></html>`;
}
