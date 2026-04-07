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

/** Build the argument list for `docker run`. Exported for testing. */
export function buildRunArgs(opts: {
  imageTag: string;
  repoPath: string;
  config?: SandboxConfig | undefined;
  repoName: string;
  issueNumber: number;
}): string[] {
  const cpus = opts.config?.cpus ?? DEFAULT_SANDBOX_LIMITS.cpus;
  const memory = opts.config?.memory ?? DEFAULT_SANDBOX_LIMITS.memory;
  const name = containerName(opts.repoName, opts.issueNumber);

  return [
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '--cpus',
    String(cpus),
    '--memory',
    memory,
    '-v',
    `${opts.repoPath}:/workspace`,
    '-w',
    '/workspace',
    ...(opts.config?.restrict_network ? ['--network', 'none'] : []),
    opts.imageTag,
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
  const args = buildRunArgs({
    repoName: opts.repoName,
    issueNumber: opts.issueNumber,
    repoPath: opts.repoPath,
    imageTag,
    config: opts.config,
  });

  const result = await $`${docker} ${args}`;
  const containerId = result.stdout.trim();
  const name = containerName(opts.repoName, opts.issueNumber);
  log.info(`[sandbox] Container started: ${name} (${containerId.slice(0, 12)})`);

  return { containerId, containerName: name };
}

/** Kill a running container. */
export async function killContainer(containerId: string, dockerCommand?: string): Promise<void> {
  const docker = dockerCommand ?? 'docker';
  try {
    await $`${docker} kill ${containerId}`.quiet();
    log.info(`[sandbox] Container killed: ${containerId.slice(0, 12)}`);
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
