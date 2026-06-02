// Tests for `sandbox.backend` Zod validation — the config layer's contract
// for the pluggable-backend extraction (issue #301).
//
// Unknown backend names must reject at config-load time (so misconfigured
// repos.yaml fails fast in CI rather than surfacing during a wave).

import { describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '../types/config.js';

describe('SandboxConfigSchema — backend field', () => {
  it('defaults backend to "docker" when omitted', () => {
    const parsed = SandboxConfigSchema.parse({});
    expect(parsed.backend).toBe('docker');
  });

  it('accepts backend: "docker" explicitly', () => {
    const parsed = SandboxConfigSchema.parse({ backend: 'docker' });
    expect(parsed.backend).toBe('docker');
  });

  it('accepts backend: "daytona"', () => {
    const parsed = SandboxConfigSchema.parse({ backend: 'daytona' });
    expect(parsed.backend).toBe('daytona');
  });

  it('rejects unknown backend with a field-scoped error', () => {
    const result = SandboxConfigSchema.safeParse({ backend: 'gvisor' });
    expect(result.success).toBe(false);
    if (!result.success) {
      // The error path must point at `backend` so the operator sees which field is wrong.
      const backendErr = result.error.issues.find((i) => i.path.includes('backend'));
      expect(backendErr).toBeDefined();
    }
  });

  it('preserves other defaults when backend is set', () => {
    const parsed = SandboxConfigSchema.parse({ backend: 'daytona' });
    expect(parsed.cpus).toBe(2);
    expect(parsed.memory).toBe('4g');
    expect(parsed.timeout).toBe('30m');
    expect(parsed.image).toBe('node:20-bookworm');
  });
});
