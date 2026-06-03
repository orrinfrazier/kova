import { describe, expect, it } from 'vitest';
import {
  buildRunArgs,
  buildSandboxImage,
  buildSandboxImageArgs,
  containerName,
  DEFAULT_SANDBOX_LIMITS,
  defaultSandboxImage,
  parseTimeout,
  resolveDockerfilePath,
  sandboxImageTag,
} from './sandbox.js';

const fullConfig = {
  backend: 'docker',
  image: 'node:20-bookworm',
  extra_packages: [] as string[],
  restrict_network: false,
  cpus: 2,
  memory: '4g',
  timeout: '30m',
} as const;

/* ------------------------------------------------------------------ */
/*  Pure functions                                                      */
/* ------------------------------------------------------------------ */

describe('sandboxImageTag', () => {
  it('returns default tag for a repo name', () => {
    expect(sandboxImageTag('my-repo')).toBe('kova-sandbox-my-repo:latest');
  });

  it('sanitises repo names with slashes', () => {
    expect(sandboxImageTag('org/repo')).toBe('kova-sandbox-org-repo:latest');
  });

  it('lowercases the tag', () => {
    expect(sandboxImageTag('MyRepo')).toBe('kova-sandbox-myrepo:latest');
  });
});

describe('defaultSandboxImage', () => {
  it('returns the expected default base image', () => {
    expect(defaultSandboxImage()).toBe('node:20-bookworm');
  });
});

describe('resolveDockerfilePath', () => {
  it('returns the bundled Dockerfile path', () => {
    const result = resolveDockerfilePath();
    expect(result).toMatch(/sandbox\/Dockerfile$/);
  });
});

/* ------------------------------------------------------------------ */
/*  buildSandboxImageArgs (unit — no Docker needed)                    */
/* ------------------------------------------------------------------ */

describe('buildSandboxImageArgs', () => {
  it('generates correct docker build arguments with custom image', () => {
    const { args } = buildSandboxImageArgs({
      repoName: 'my-repo',
      config: { ...fullConfig, image: 'ubuntu:22.04' },
    });

    expect(args).toContain('--build-arg');
    expect(args).toContain('BASE_IMAGE=ubuntu:22.04');
    expect(args).toContain('-t');
    expect(args).toContain('kova-sandbox-my-repo:latest');
  });

  it('uses default base image when config is undefined', () => {
    const { args } = buildSandboxImageArgs({
      repoName: 'my-repo',
      config: undefined,
    });

    expect(args).toContain('BASE_IMAGE=node:20-bookworm');
  });

  it('includes extra packages as build arg', () => {
    const { args } = buildSandboxImageArgs({
      repoName: 'my-repo',
      config: { ...fullConfig, extra_packages: ['ffmpeg', 'imagemagick'] },
    });

    expect(args).toContain('EXTRA_PACKAGES=ffmpeg imagemagick');
  });

  it('omits extra packages build arg when list is empty', () => {
    const { args } = buildSandboxImageArgs({
      repoName: 'my-repo',
      config: fullConfig,
    });

    const extraIdx = args.findIndex((a) => a.startsWith('EXTRA_PACKAGES='));
    expect(extraIdx).toBe(-1);
  });

  it('includes dockerfile path and context dir', () => {
    const { args } = buildSandboxImageArgs({
      repoName: 'test',
      config: undefined,
    });

    const fIdx = args.indexOf('-f');
    expect(fIdx).toBeGreaterThan(-1);
    expect(args[fIdx + 1]).toMatch(/sandbox\/Dockerfile$/);
  });
});

/* ------------------------------------------------------------------ */
/*  buildSandboxImage (integration — requires Docker)                  */
/* ------------------------------------------------------------------ */

describe('buildSandboxImage', () => {
  it('returns failure when docker is not available', async () => {
    const result = await buildSandboxImage({
      repoName: 'test-repo',
      config: undefined,
      dockerCommand: 'docker-nonexistent-binary',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/*  parseTimeout                                                       */
/* ------------------------------------------------------------------ */

describe('parseTimeout', () => {
  it('parses minutes', () => {
    expect(parseTimeout('30m')).toBe(30 * 60 * 1000);
  });

  it('parses hours', () => {
    expect(parseTimeout('2h')).toBe(2 * 60 * 60 * 1000);
  });

  it('parses seconds', () => {
    expect(parseTimeout('90s')).toBe(90 * 1000);
  });

  it('defaults to minutes for bare number', () => {
    expect(parseTimeout('15')).toBe(15 * 60 * 1000);
  });

  it('throws on invalid format', () => {
    expect(() => parseTimeout('abc')).toThrow();
  });
});

/* ------------------------------------------------------------------ */
/*  DEFAULT_SANDBOX_LIMITS                                             */
/* ------------------------------------------------------------------ */

describe('DEFAULT_SANDBOX_LIMITS', () => {
  it('has expected defaults', () => {
    expect(DEFAULT_SANDBOX_LIMITS.cpus).toBe(2);
    expect(DEFAULT_SANDBOX_LIMITS.memory).toBe('4g');
    expect(DEFAULT_SANDBOX_LIMITS.timeout).toBe('30m');
  });
});

/* ------------------------------------------------------------------ */
/*  containerName                                                      */
/* ------------------------------------------------------------------ */

describe('containerName', () => {
  it('generates a deterministic container name', () => {
    expect(containerName('my-repo', 42)).toBe('kova-sandbox-my-repo-42');
  });

  it('sanitises special characters', () => {
    expect(containerName('org/repo', 7)).toBe('kova-sandbox-org-repo-7');
  });
});

/* ------------------------------------------------------------------ */
/*  buildRunArgs (unit — no Docker needed)                             */
/* ------------------------------------------------------------------ */

describe('buildRunArgs', () => {
  it('includes --cpus and --memory flags', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
      config: { ...fullConfig, cpus: 4, memory: '8g', timeout: '1h' },
    });

    const cpuIdx = args.indexOf('--cpus');
    expect(args[cpuIdx + 1]).toBe('4');

    const memIdx = args.indexOf('--memory');
    expect(args[memIdx + 1]).toBe('8g');
  });

  it('uses default limits when config is not provided', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    const cpuIdx = args.indexOf('--cpus');
    expect(args[cpuIdx + 1]).toBe('2');

    const memIdx = args.indexOf('--memory');
    expect(args[memIdx + 1]).toBe('4g');
  });

  it('adds --network none when restrict_network is true', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
      config: { ...fullConfig, restrict_network: true },
    });

    const netIdx = args.indexOf('--network');
    expect(args[netIdx + 1]).toBe('none');
  });

  it('omits --network when restrict_network is false', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
      config: fullConfig,
    });

    expect(args).not.toContain('--network');
  });

  it('mounts repo path as /workspace volume', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/home/user/repos/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    const vIdx = args.indexOf('-v');
    expect(args[vIdx + 1]).toBe('/home/user/repos/my-repo:/workspace');

    const wIdx = args.indexOf('-w');
    expect(args[wIdx + 1]).toBe('/workspace');
  });

  it('includes --name and -d flags (no --rm for long-lived containers)', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    expect(args).not.toContain('--rm');
    expect(args).toContain('-d');
    expect(args).toContain('--name');
    const nameIdx = args.indexOf('--name');
    expect(args[nameIdx + 1]).toBe('kova-sandbox-my-repo-42');
  });

  it('ends with image tag followed by sleep infinity', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    const imageIdx = args.indexOf('kova-sandbox-my-repo:latest');
    expect(imageIdx).toBeGreaterThan(-1);
    expect(args[imageIdx + 1]).toBe('sleep');
    expect(args[imageIdx + 2]).toBe('infinity');
  });

  it('passes ANTHROPIC_API_KEY as env var', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    const envIdx = args.indexOf('-e');
    expect(envIdx).toBeGreaterThan(-1);
    expect(args[envIdx + 1]).toMatch(/^ANTHROPIC_API_KEY=/);
  });

  it('passes OPENAI_API_KEY as env var when set', () => {
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '-e');
    expect(envArgs).toContainEqual('OPENAI_API_KEY=sk-openai-test');
    delete process.env.OPENAI_API_KEY;
  });

  it('passes GEMINI_API_KEY as env var when set', () => {
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '-e');
    expect(envArgs).toContainEqual('GEMINI_API_KEY=gemini-test-key');
    delete process.env.GEMINI_API_KEY;
  });

  it('falls back to GOOGLE_API_KEY for GEMINI_API_KEY in sandbox', () => {
    process.env.GOOGLE_API_KEY = 'google-fallback-key';
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '-e');
    expect(envArgs).toContainEqual('GEMINI_API_KEY=google-fallback-key');
    delete process.env.GOOGLE_API_KEY;
  });

  it('omits OPENAI_API_KEY when not set', () => {
    delete process.env.OPENAI_API_KEY;
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
    });

    const envArgs = args.filter((_, i) => i > 0 && args[i - 1] === '-e');
    expect(envArgs.some((a) => a.startsWith('OPENAI_API_KEY='))).toBe(false);
  });

  it('mounts kova root at /app when kovaRoot is provided', () => {
    const args = buildRunArgs({
      repoName: 'my-repo',
      issueNumber: 42,
      repoPath: '/tmp/my-repo',
      imageTag: 'kova-sandbox-my-repo:latest',
      kovaRoot: '/opt/kova',
    });

    const volumes = args.filter((_, i) => i > 0 && args[i - 1] === '-v');
    expect(volumes).toContain('/opt/kova:/app:ro');
  });
});
