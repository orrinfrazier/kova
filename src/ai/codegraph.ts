// Issue #271 — wrappers around the external `codegraph` CLI.
//
// The `codegraph` MCP server (started via stdio) returns useful results only
// after `codegraph init <workDir> --index`. A fresh worktree has no index, so
// without this gate `codegraph serve --mcp` answers empty-but-successfully and
// the agent silently gets no graph (see codegraph README:494,505 cited in #271).
//
// Strategy:
//   - probe `command -v codegraph` (or `codegraph --version`) to know if the CLI
//     is installed at all. If not on PATH, every helper returns a typed not-on-path
//     failure and the pipeline proceeds unchanged (no behavior change).
//   - `init` runs `codegraph init <workDir> --index` once per worktree setup.
//   - `status --json` reports `{initialized, nodes}` — the gate for "should we
//     even start the MCP server, or will it just serve an empty index?".
//   - `sync` runs between WAVE I (edits) and WAVE R (review) so impact reflects
//     the new edits.
//
// All helpers swallow non-zero exits and return a typed `{ok, reason}` shape so
// the caller never has to wrap a try/catch — gracefully degrading to "codegraph
// is optional" is the whole point of this module.

import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

/** Shape of the result returned by every helper in this module. */
export interface CodegraphActionResult {
  ok: boolean;
  /** Short tag for failed cases: 'not-on-path' | 'exec-failed: <msg>' | 'parse-failed: <msg>'. */
  reason?: string;
}

export interface CodegraphStatus {
  initialized: boolean;
  nodeCount: number;
  reason?: string;
}

/** Injection point for tests — runs a shell command and returns stdout/stderr/code.
 *  Real implementation is execFile from node:child_process. */
export type ExecFn = (
  command: string,
  args: string[],
  opts?: { cwd?: string; timeout?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** Default exec wrapper that adapts node:child_process to our typed shape.
 *  Rejects on non-zero exit and ENOENT alike — the helpers above classify the
 *  rejection (ENOENT -> not-on-path, anything else -> exec-failed). */
const defaultExec: ExecFn = async (command, args, opts) => {
  const result = await execFile(command, args, { timeout: opts?.timeout, cwd: opts?.cwd });
  return { stdout: result.stdout, stderr: result.stderr, code: 0 };
};

/** True when the `codegraph` CLI is on PATH and executable. */
export async function isCodegraphOnPath(exec: ExecFn = defaultExec): Promise<boolean> {
  try {
    const r = await exec('codegraph', ['--version'], { timeout: 5_000 });
    return r.code === 0;
  } catch {
    return false;
  }
}

/** Run `codegraph init <workDir> --index` (best-effort). */
export async function initCodegraph(workDir: string, exec: ExecFn = defaultExec): Promise<CodegraphActionResult> {
  try {
    const r = await exec('codegraph', ['init', workDir, '--index'], { timeout: 5 * 60_000 });
    if (r.code === 0) return { ok: true };
    return { ok: false, reason: `exec-failed: ${r.stderr || r.stdout || `exit ${r.code}`}` };
  } catch (err) {
    return { ok: false, reason: classifyExecError(err) };
  }
}

/** Probe `codegraph status --json --cwd <workDir>` and return parsed shape. */
export async function probeCodegraphStatus(workDir: string, exec: ExecFn = defaultExec): Promise<CodegraphStatus> {
  let stdout: string;
  try {
    const r = await exec('codegraph', ['status', '--json', '--cwd', workDir], { timeout: 10_000 });
    if (r.code !== 0) {
      return { initialized: false, nodeCount: 0, reason: `exec-failed: ${r.stderr || r.stdout || `exit ${r.code}`}` };
    }
    stdout = r.stdout;
  } catch (err) {
    return { initialized: false, nodeCount: 0, reason: classifyExecError(err) };
  }

  try {
    const parsed = JSON.parse(stdout) as { initialized?: unknown; nodes?: unknown };
    const initialized = parsed.initialized === true;
    const nodeCount = typeof parsed.nodes === 'number' ? parsed.nodes : 0;
    return { initialized, nodeCount };
  } catch (err) {
    return {
      initialized: false,
      nodeCount: 0,
      reason: `parse-failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Run `codegraph sync --cwd <workDir>` (best-effort) between WAVE I and WAVE R. */
export async function syncCodegraph(workDir: string, exec: ExecFn = defaultExec): Promise<CodegraphActionResult> {
  try {
    const r = await exec('codegraph', ['sync', '--cwd', workDir], { timeout: 60_000 });
    if (r.code === 0) return { ok: true };
    return { ok: false, reason: `exec-failed: ${r.stderr || r.stdout || `exit ${r.code}`}` };
  } catch (err) {
    return { ok: false, reason: classifyExecError(err) };
  }
}

/** Decide whether to withhold codegraph MCP tools for the current run.
 *  Withhold when the probe shows uninitialized OR zero nodes — both cases
 *  mean `codegraph serve --mcp` will return empty-but-successful results,
 *  which silently degrades agent reasoning. Better to withhold than to lie. */
export function shouldWithholdCodegraphTools(probe: { initialized: boolean; nodeCount: number }): boolean {
  return !probe.initialized || probe.nodeCount === 0;
}

/** Classify the rejected execFile error into our typed reason tag. */
function classifyExecError(err: unknown): string {
  if (err != null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code: unknown }).code;
    if (code === 'ENOENT') return 'not-on-path';
  }
  const msg = err instanceof Error ? err.message : String(err);
  return `exec-failed: ${msg}`;
}
