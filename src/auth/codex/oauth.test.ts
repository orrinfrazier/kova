import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  base64UrlEncode,
  buildAuthorizeUrl,
  CLIENT_ID,
  exchangeCodeForTokens,
  exchangeDeviceCode,
  extractAccountId,
  extractAccountIdFromClaims,
  generatePkce,
  generateState,
  ISSUER,
  parseJwtClaims,
  pollDeviceAuth,
  refreshAccessToken,
  startDeviceAuth,
  type TokenResponse,
} from './oauth.js';

/** Compose a fake JWT for tests. Header/signature don't matter; we only parse the payload. */
function fakeJwt(claims: Record<string, unknown>): string {
  const header = base64UrlEncode(Buffer.from('{"alg":"none"}', 'utf8'));
  const payload = base64UrlEncode(Buffer.from(JSON.stringify(claims), 'utf8'));
  return `${header}.${payload}.sig`;
}

describe('generatePkce', () => {
  it('returns a 43-char verifier and a base64url challenge that is SHA256(verifier)', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toHaveLength(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    const expected = base64UrlEncode(createHash('sha256').update(verifier).digest());
    expect(challenge).toBe(expected);
    expect(challenge).not.toMatch(/[+/=]/);
  });

  it('produces different verifiers across calls', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('generateState', () => {
  it('produces a base64url string with no padding', () => {
    const s = generateState();
    expect(s).not.toMatch(/[+/=]/);
    expect(s.length).toBeGreaterThan(20);
  });
});

describe('buildAuthorizeUrl', () => {
  it('encodes all required params, sets originator=kova and PKCE method S256', () => {
    const url = new URL(
      buildAuthorizeUrl(
        'http://localhost:1455/auth/callback',
        { verifier: 'v'.repeat(43), challenge: 'CHAL' },
        'STATE',
      ),
    );
    expect(url.origin).toBe(ISSUER);
    expect(url.pathname).toBe('/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile email offline_access');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true');
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true');
    expect(url.searchParams.get('state')).toBe('STATE');
    expect(url.searchParams.get('originator')).toBe('kova');
  });
});

describe('exchangeCodeForTokens', () => {
  it('POSTs the expected form body and returns the parsed token response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', id_token: 'IDT', expires_in: 3600 }), {
        status: 200,
      }),
    );
    const tokens = await exchangeCodeForTokens({
      code: 'CODE',
      redirectUri: 'http://localhost:1455/auth/callback',
      pkce: { verifier: 'V', challenge: 'C' },
      fetchImpl,
    });
    expect(tokens.access_token).toBe('AT');
    expect(tokens.refresh_token).toBe('RT');

    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall as [string, RequestInit | undefined];
    expect(url).toBe(`${ISSUER}/oauth/token`);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('client_id')).toBe(CLIENT_ID);
    expect(body.get('code_verifier')).toBe('V');
  });

  it('throws when the upstream returns non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad code', { status: 400 }));
    await expect(
      exchangeCodeForTokens({
        code: 'X',
        redirectUri: 'http://localhost:1455/auth/callback',
        pkce: { verifier: 'V', challenge: 'C' },
        fetchImpl,
      }),
    ).rejects.toThrow(/Token exchange failed: 400/);
  });
});

describe('refreshAccessToken', () => {
  it('POSTs refresh_token grant and returns new tokens', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 7200 }), { status: 200 }),
      );
    const tokens = await refreshAccessToken({ refreshToken: 'old-rt', fetchImpl });
    expect(tokens.access_token).toBe('AT2');
    expect(tokens.refresh_token).toBe('RT2');
    expect(tokens.expires_in).toBe(7200);

    const init = fetchImpl.mock.calls[0]?.[1] as { body: string } | undefined;
    const body = new URLSearchParams(init?.body ?? '');
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-rt');
    expect(body.get('client_id')).toBe(CLIENT_ID);
  });

  it('throws on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    await expect(refreshAccessToken({ refreshToken: 'rt', fetchImpl })).rejects.toThrow(/Token refresh failed: 401/);
  });
});

describe('parseJwtClaims', () => {
  it('decodes the payload of a valid JWT', () => {
    const token = fakeJwt({ chatgpt_account_id: 'acct_123' });
    const claims = parseJwtClaims(token);
    expect(claims?.chatgpt_account_id).toBe('acct_123');
  });

  it('returns undefined for malformed tokens', () => {
    // Three parts but middle isn't valid base64url-JSON → catch path returns undefined
    expect(parseJwtClaims('not.a.jwt')).toBeUndefined();
    expect(parseJwtClaims('only.two')).toBeUndefined();
    expect(parseJwtClaims('one-segment')).toBeUndefined();
    expect(parseJwtClaims('a.@@@.c')).toBeUndefined();
  });
});

describe('extractAccountIdFromClaims', () => {
  it('prefers chatgpt_account_id', () => {
    expect(extractAccountIdFromClaims({ chatgpt_account_id: 'A' })).toBe('A');
  });

  it('falls back to the namespaced auth claim', () => {
    expect(extractAccountIdFromClaims({ 'https://api.openai.com/auth': { chatgpt_account_id: 'B' } })).toBe('B');
  });

  it('falls back to organizations[0].id', () => {
    expect(extractAccountIdFromClaims({ organizations: [{ id: 'org_1' }, { id: 'org_2' }] })).toBe('org_1');
  });

  it('returns undefined when no claim is present', () => {
    expect(extractAccountIdFromClaims({})).toBeUndefined();
  });
});

describe('extractAccountId', () => {
  it('prefers id_token claims', () => {
    const tokens: TokenResponse = {
      access_token: fakeJwt({ chatgpt_account_id: 'from-at' }),
      refresh_token: 'RT',
      id_token: fakeJwt({ chatgpt_account_id: 'from-idt' }),
    };
    expect(extractAccountId(tokens)).toBe('from-idt');
  });

  it('falls back to access_token when id_token lacks the claim', () => {
    const tokens: TokenResponse = {
      access_token: fakeJwt({ chatgpt_account_id: 'from-at' }),
      refresh_token: 'RT',
      id_token: fakeJwt({}),
    };
    expect(extractAccountId(tokens)).toBe('from-at');
  });
});

describe('device flow', () => {
  it('startDeviceAuth POSTs the user-agent and returns the parsed init payload', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ device_auth_id: 'D', user_code: 'AAA-BBB', interval: '5' }), { status: 200 }),
      );
    const init = await startDeviceAuth({ userAgent: 'kova/test', fetchImpl });
    expect(init.user_code).toBe('AAA-BBB');
    const callInit = fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> } | undefined;
    expect(callInit?.headers['User-Agent']).toBe('kova/test');
  });

  it('pollDeviceAuth returns ok=true when the server returns 200', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ authorization_code: 'AC', code_verifier: 'CV' }), { status: 200 }),
      );
    const poll = await pollDeviceAuth({ deviceAuthId: 'D', userCode: 'X', userAgent: 'kova', fetchImpl });
    expect(poll.ok).toBe(true);
    expect(poll.ok && poll.data.authorization_code).toBe('AC');
  });

  it('pollDeviceAuth marks 403/404 as retryable and other 4xx/5xx as fatal', async () => {
    const make = (status: number) => vi.fn().mockResolvedValue(new Response('', { status }));
    const r403 = await pollDeviceAuth({ deviceAuthId: 'D', userCode: 'X', userAgent: 'kova', fetchImpl: make(403) });
    expect(r403).toEqual({ ok: false, retry: true, status: 403 });
    const r404 = await pollDeviceAuth({ deviceAuthId: 'D', userCode: 'X', userAgent: 'kova', fetchImpl: make(404) });
    expect(r404.ok).toBe(false);
    expect(r404.ok === false && r404.retry).toBe(true);
    const r500 = await pollDeviceAuth({ deviceAuthId: 'D', userCode: 'X', userAgent: 'kova', fetchImpl: make(500) });
    expect(r500.ok).toBe(false);
    expect(r500.ok === false && r500.retry).toBe(false);
  });

  it('exchangeDeviceCode uses the deviceauth/callback redirect_uri', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }), { status: 200 }),
      );
    await exchangeDeviceCode({ authorizationCode: 'AC', codeVerifier: 'CV', fetchImpl });
    const init = fetchImpl.mock.calls[0]?.[1] as { body: string } | undefined;
    const body = new URLSearchParams(init?.body ?? '');
    expect(body.get('redirect_uri')).toBe(`${ISSUER}/deviceauth/callback`);
    expect(body.get('code_verifier')).toBe('CV');
  });
});
