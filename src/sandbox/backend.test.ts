// Tests for the SandboxBackend interface + factory.
// Verifies that backend resolution honors the config-supplied backend name
// and that unknown backend names reject at factory time, not mid-wave.

import { describe, expect, it } from 'vitest';
import { getSandboxBackend, type SandboxBackend, type SandboxBackendName } from './backend.js';
import { DockerBackend } from './docker-backend.js';

describe('SandboxBackend interface', () => {
  it('declares the wire surface every backend must expose', () => {
    // Type-level smoke check: DockerBackend must satisfy SandboxBackend.
    // The cast is the assertion — if DockerBackend's surface drifts, this fails to compile.
    const backend: SandboxBackend = new DockerBackend();
    expect(typeof backend.start).toBe('function');
    expect(typeof backend.execWave).toBe('function');
    expect(typeof backend.stop).toBe('function');
    expect(typeof backend.getStats).toBe('function');
    // Optional persistence hooks (no-op on DockerBackend, real work on serverless backends)
    expect(typeof backend.hibernate).toBe('function');
    expect(typeof backend.resume).toBe('function');
  });
});

describe('getSandboxBackend factory', () => {
  it('resolves "docker" to a DockerBackend instance', () => {
    const backend = getSandboxBackend('docker');
    expect(backend).toBeInstanceOf(DockerBackend);
  });

  it('resolves "daytona" to a DaytonaBackend instance', async () => {
    const backend = getSandboxBackend('daytona');
    // We don't import DaytonaBackend directly here to keep this test file's
    // assertions structural rather than identity-based — but the name must match.
    expect(backend.constructor.name).toBe('DaytonaBackend');
  });

  it('throws on unknown backend name with a clear message', () => {
    // Cast widens to the underlying string type so we can pass an unknown name.
    expect(() => getSandboxBackend('gvisor' as SandboxBackendName)).toThrow(/unknown sandbox backend/i);
  });

  it('returns a fresh instance per call', () => {
    const a = getSandboxBackend('docker');
    const b = getSandboxBackend('docker');
    expect(a).not.toBe(b);
  });
});
