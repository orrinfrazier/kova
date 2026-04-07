// Sandbox image management — build and manage Docker images for isolated execution.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { $ } from 'zx';
import type { SandboxConfig } from '../types/index.js';
import { log } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Default resource limits for sandbox containers. */
export const DEFAULT_SANDBOX_LIMITS = {
  cpus: 2,
  memory: '4g',
  timeout: '30m',
} as const;

/** Parse a timeout string (e.g. '30m', '1h', '90s') into milliseconds. Bare numbers default to minutes. */
export function parseTimeout(timeout: string): number {
  const match = timeout.match(/^(\d+)(s|m|h)?$/);
  if (!match?.[1]) throw new Error(`Invalid timeout format: ${timeout} (expected e.g. 30m, 1h, 90s)`);
  const value = Number.parseInt(match[1], 10);
  const unit = match[2] ?? 'm';
  switch (unit) {
    case 's':
      return value * 1000;
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown timeout unit: ${unit}`);
  }
}

/** Generate a container name for a sandbox run. */
export function containerName(repoName: string, issueNumber: number): string {
  const sanitised = repoName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `kova-sandbox-${sanitised}-${issueNumber}`;
}

/** Resolve kova's project root from the compiled module location. */
export function resolveKovaRoot(): string {
  return resolve(join(__dirname, '..', '..'));
}

/** Build the argument list for `docker run`. Exported for testing. */
export function buildRunArgs(opts: {
  imageTag: string;
  repoPath: string;
  config?: SandboxConfig | undefined;
  repoName: string;
  issueNumber: number;
  kovaRoot?: string | undefined;
}): string[] {
  const cpus = opts.config?.cpus ?? DEFAULT_SANDBOX_LIMITS.cpus;
  const memory = opts.config?.memory ?? DEFAULT_SANDBOX_LIMITS.memory;
  const name = containerName(opts.repoName, opts.issueNumber);
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? '';

  // Collect API keys — always pass ANTHROPIC_API_KEY, conditionally pass others
  const envFlags = ['-e', `ANTHROPIC_API_KEY=${anthropicKey}`];
  if (process.env.OPENAI_API_KEY) {
    envFlags.push('-e', `OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);
  }
  const googleKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (googleKey) {
    envFlags.push('-e', `GEMINI_API_KEY=${googleKey}`);
  }

  return [
    'run',
    '-d',
    '--name',
    name,
    '--cpus',
    String(cpus),
    '--memory',
    memory,
    '-v',
    `${opts.repoPath}:/workspace`,
    ...(opts.kovaRoot ? ['-v', `${opts.kovaRoot}:/app:ro`] : []),
    ...envFlags,
    '-w',
    '/workspace',
    ...(opts.config?.restrict_network ? ['--network', 'none'] : []),
    opts.imageTag,
    'sleep',
    'infinity',
  ];
}

/** Start a sandbox container with resource limits. Returns the container ID. */
export async function startSandboxContainer(opts: {
  repoName: string;
  issueNumber: number;
  repoPath: string;
  config?: SandboxConfig | undefined;
  dockerCommand?: string;
}): Promise<{ containerId: string; containerName: string }> {
  const docker = opts.dockerCommand ?? 'docker';
  const imageTag = sandboxImageTag(opts.repoName);
  const name = containerName(opts.repoName, opts.issueNumber);
  const kovaRoot = resolveKovaRoot();

  // Remove stale container from a previous interrupted run
  try {
    await $`${docker} rm -f ${name}`.quiet();
  } catch {
    // Expected: no stale container
  }

  const args = buildRunArgs({
    repoName: opts.repoName,
    issueNumber: opts.issueNumber,
    repoPath: opts.repoPath,
    imageTag,
    config: opts.config,
    kovaRoot,
  });

  const result = await $`${docker} ${args}`;
  const containerId = result.stdout.trim();
  log.info(`[sandbox] Container started: ${name} (${containerId.slice(0, 12)})`);

  // Install kova dependencies inside the container
  try {
    await $`${docker} exec ${name} sh -c ${'cd /app && [ -d node_modules ] || npm ci --production --ignore-scripts 2>/dev/null'}`.quiet();
  } catch {
    log.debug('[sandbox] node_modules already available or install skipped');
  }

  return { containerId, containerName: name };
}

/** Input for executing a wave inside the sandbox container. */
export interface SandboxWaveInput {
  wave: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  thinkingLevel?: string | undefined;
  fallbackModel?: string | undefined;
  outputSchemaName?: string | undefined;
}

/** Execute an Agent SDK wave inside the sandbox container via docker exec. */
export async function execWaveInContainer(
  containerNameStr: string,
  input: SandboxWaveInput,
  repoPath: string,
  dockerCommand?: string,
): Promise<unknown> {
  const docker = dockerCommand ?? 'docker';
  const { mkdir, writeFile } = await import('node:fs/promises');

  // Write wave input to shared volume
  const ioDir = join(repoPath, '.kova', 'sandbox');
  await mkdir(ioDir, { recursive: true });
  await writeFile(join(ioDir, 'wave-input.json'), JSON.stringify(input, null, 2));

  const containerInputPath = '/workspace/.kova/sandbox/wave-input.json';
  const runnerPath = '/app/dist/sandbox/run-wave.js';

  log.info(`[sandbox] Executing wave '${input.wave}' in container ${containerNameStr}`);

  const result = await $`${docker} exec ${containerNameStr} node ${runnerPath} ${containerInputPath}`;

  // The runner writes WaveHandoff JSON as the last line of stdout
  const stdout = result.stdout.trim();
  const lines = stdout.split('\n');
  const lastLine = lines[lines.length - 1];

  if (!lastLine) {
    throw new Error(`[sandbox] No output from wave '${input.wave}'`);
  }

  try {
    return JSON.parse(lastLine) as unknown;
  } catch {
    throw new Error(`[sandbox] Failed to parse wave output: ${lastLine.slice(0, 200)}`);
  }
}

/** Kill a running container. */
export async function killContainer(containerId: string, dockerCommand?: string): Promise<void> {
  const docker = dockerCommand ?? 'docker';
  try {
    await $`${docker} rm -f ${containerId}`.quiet();
    log.info(`[sandbox] Container removed: ${containerId.slice(0, 12)}`);
  } catch {
    log.debug(`[sandbox] Container already stopped: ${containerId.slice(0, 12)}`);
  }
}

/** Get resource usage stats from a running container. */
export async function getContainerStats(
  containerId: string,
  dockerCommand?: string,
): Promise<{ memoryMB: number; cpuPercent: number }> {
  const docker = dockerCommand ?? 'docker';
  try {
    const result = await $`${docker} stats ${containerId} --no-stream --format {{.MemUsage}},{{.CPUPerc}}`.quiet();
    const [memUsage, cpuPerc] = result.stdout.trim().split(',');
    const memMatch = memUsage?.match(/([\d.]+)(MiB|GiB)/);
    const memoryMB = memMatch?.[1]
      ? memMatch[2] === 'GiB'
        ? Number.parseFloat(memMatch[1]) * 1024
        : Number.parseFloat(memMatch[1])
      : 0;
    const cpuPercent = Number.parseFloat(cpuPerc?.replace('%', '') ?? '0');
    return { memoryMB, cpuPercent };
  } catch {
    return { memoryMB: 0, cpuPercent: 0 };
  }
}

/** Default base image for the sandbox Dockerfile. */
export function defaultSandboxImage(): string {
  return 'node:20-bookworm';
}

/** Resolve the path to the bundled sandbox Dockerfile. */
export function resolveDockerfilePath(): string {
  return resolve(join(__dirname, '..', '..', 'sandbox', 'Dockerfile'));
}

/** Generate a Docker image tag for a repo's sandbox. */
export function sandboxImageTag(repoName: string): string {
  const sanitised = repoName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `kova-sandbox-${sanitised}:latest`;
}

/** Build the argument list for `docker build` without executing it. Exported for testing. */
export function buildSandboxImageArgs(opts: { repoName: string; config: SandboxConfig | undefined }): {
  args: string[];
} {
  const baseImage = opts.config?.image ?? defaultSandboxImage();
  const tag = sandboxImageTag(opts.repoName);
  const dockerfilePath = resolveDockerfilePath();
  const contextDir = dirname(dockerfilePath);

  const extraPackages = opts.config?.extra_packages ?? [];

  const args = [
    'build',
    '--build-arg',
    `BASE_IMAGE=${baseImage}`,
    ...(extraPackages.length > 0 ? ['--build-arg', `EXTRA_PACKAGES=${extraPackages.join(' ')}`] : []),
    '-t',
    tag,
    '-f',
    dockerfilePath,
    contextDir,
  ];

  return { args };
}

export interface SandboxBuildResult {
  success: boolean;
  tag?: string;
  duration?: number;
  error?: string;
}

/** Build the sandbox Docker image for a repository. */
export async function buildSandboxImage(opts: {
  repoName: string;
  config: SandboxConfig | undefined;
  dockerCommand?: string;
}): Promise<SandboxBuildResult> {
  const docker = opts.dockerCommand ?? 'docker';
  const { args } = buildSandboxImageArgs({
    repoName: opts.repoName,
    config: opts.config,
  });
  const tag = sandboxImageTag(opts.repoName);

  const start = Date.now();

  try {
    // Check Docker is available
    await $`${docker} info`.quiet();
  } catch {
    return {
      success: false,
      error: 'Docker is not available. Ensure Docker is installed and running.',
    };
  }

  try {
    log.info(`[sandbox] Building image ${tag}...`);
    const proc = $`${docker} ${args}`;
    proc.stdout.pipe(process.stdout);
    proc.stderr.pipe(process.stderr);
    await proc;

    const duration = Date.now() - start;
    log.info(`[sandbox] Image built: ${tag} (${duration}ms)`);
    return { success: true, tag, duration };
  } catch (error) {
    return {
      success: false,
      error: `Docker build failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
