import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyWebhookSignature } from './webhook-verify.js';

function computeHmacSha256(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

describe('verifyWebhookSignature', () => {
  const secret = 'test-secret-key';
  const payload = JSON.stringify({ event: 'push', ref: 'refs/heads/main' });

  describe('valid signature', () => {
    it('returns true when signature matches payload', () => {
      const signature = computeHmacSha256(payload, secret);
      expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
    });

    it('returns true for different valid payloads', () => {
      const altPayload = JSON.stringify({ event: 'pull_request', action: 'opened' });
      const signature = computeHmacSha256(altPayload, secret);
      expect(verifyWebhookSignature(altPayload, signature, secret)).toBe(true);
    });

    it('returns true for empty payload with correct signature', () => {
      const emptyPayload = '';
      const signature = computeHmacSha256(emptyPayload, secret);
      expect(verifyWebhookSignature(emptyPayload, signature, secret)).toBe(true);
    });

    it('returns true with sha256= prefix in signature', () => {
      const rawSignature = computeHmacSha256(payload, secret);
      const prefixedSignature = `sha256=${rawSignature}`;
      expect(verifyWebhookSignature(payload, prefixedSignature, secret)).toBe(true);
    });
  });

  describe('invalid signature', () => {
    it('returns false when signature is incorrect', () => {
      const wrongSignature = computeHmacSha256(payload, 'wrong-secret');
      expect(verifyWebhookSignature(payload, wrongSignature, secret)).toBe(false);
    });

    it('returns false when payload has been tampered with', () => {
      const signature = computeHmacSha256(payload, secret);
      const tamperedPayload = JSON.stringify({ event: 'push', ref: 'refs/heads/evil' });
      expect(verifyWebhookSignature(tamperedPayload, signature, secret)).toBe(false);
    });

    it('returns false for a signature of all zeros', () => {
      const zeroSignature = '0'.repeat(64);
      expect(verifyWebhookSignature(payload, zeroSignature, secret)).toBe(false);
    });

    it('returns false for a completely arbitrary string signature', () => {
      expect(verifyWebhookSignature(payload, 'not-a-real-signature', secret)).toBe(false);
    });

    it('returns false when secret differs', () => {
      const signature = computeHmacSha256(payload, secret);
      expect(verifyWebhookSignature(payload, signature, 'different-secret')).toBe(false);
    });
  });

  describe('missing signature header', () => {
    it('returns false when signature is an empty string', () => {
      expect(verifyWebhookSignature(payload, '', secret)).toBe(false);
    });

    it('returns false when signature is only the sha256= prefix', () => {
      expect(verifyWebhookSignature(payload, 'sha256=', secret)).toBe(false);
    });
  });

  describe('timing-safe comparison', () => {
    it('implementation uses timingSafeEqual (source check)', () => {
      // ESM modules can't be spied on, so verify at source level
      const { readFileSync } = require('node:fs');
      const { resolve } = require('node:path');
      const src = readFileSync(resolve(__dirname, 'webhook-verify.ts'), 'utf-8');
      expect(src).toContain('timingSafeEqual');
    });
  });
});
