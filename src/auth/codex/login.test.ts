import { describe, expect, it } from 'vitest';

import { tokensToCredentials } from './login.js';
import type { TokenResponse } from './oauth.js';

describe('tokensToCredentials', () => {
  it('computes expires from now + expires_in*1000', () => {
    const tokens: TokenResponse = {
      access_token: 'AT',
      refresh_token: 'RT',
      expires_in: 1800,
    };
    const creds = tokensToCredentials(tokens, 1_000_000);
    expect(creds.expires).toBe(1_000_000 + 1800 * 1000);
    expect(creds.access).toBe('AT');
    expect(creds.refresh).toBe('RT');
    expect(creds.type).toBe('oauth');
  });

  it('defaults to 3600s when expires_in is missing', () => {
    const creds = tokensToCredentials({ access_token: 'AT', refresh_token: 'RT' }, 0);
    expect(creds.expires).toBe(3600 * 1000);
  });

  it('extracts accountId from id_token if present', () => {
    // Build a fake JWT with the account claim
    const header = Buffer.from('{"alg":"none"}').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ chatgpt_account_id: 'acct_xyz' })).toString('base64url');
    const idToken = `${header}.${payload}.sig`;
    const creds = tokensToCredentials({ access_token: 'AT', refresh_token: 'RT', id_token: idToken });
    expect(creds.accountId).toBe('acct_xyz');
  });
});
