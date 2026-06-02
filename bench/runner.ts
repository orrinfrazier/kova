// Per-fixture runner.
//
// Each `runFixture` call:
//   1. mkdtemp under `tmpRoot ?? os.tmpdir()`
//   2. copy the fixture's seed repo into the tmp dir
//   3. invoke `fixApply` against the tmp dir
//   4. run the acceptance command, capturing stdout/stderr/exitCode
//   5. clean up the tmp dir (unless `keep: true`)
//   6. emit a `FixtureRunResult`
//
// The seed dir is read-only from the harness's perspective — we copy
// into the workdir; we never mutate the seed. The acceptance command
// runs inside the workdir, so even a buggy fixApply can't escape the
// sandbox.

import { spawn } from 'node:child_process';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FixApply, FixtureRunResult, LoadedFixture } from './types.js';

export interface RunFixtureOpts {
  fixApply: FixApply;
  /** Root for `mkdtemp`. Defaults to `os.tmpdir()`. */
  tmpRoot?: string;
  /** Keep the temp workdir after the run for inspection. Default: false. */
  keep?: boolean;
}

interface AcceptanceOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function runFixture(fixture: LoadedFixture, opts: RunFixtureOpts): Promise<FixtureRunResult> {
  const startedAt = Date.now();
  const root = opts.tmpRoot ?? tmpdir();
  const workdir = await mkdtemp(join(root, `kova-bench-${fixture.manifest.id}-`));

  try {
    // Copy the seed into the workdir. Use `cp -R` semantics via fs.cp with
    // `recursive: true` — it follows symlinks by default which is fine for
    // a curated fixture seed.
    await cp(fixture.repoSeedDir, workdir, { recursive: true });

    let fixApplyResult: Awaited<ReturnType<FixApply>>;
    try {
      fixApplyResult = await opts.fixApply({
        workdir,
        issue: fixture.manifest.issue,
        fixtureId: fixture.manifest.id,
      });
    } catch (err) {
      return {
        schemaVersion: 1,
        fixtureId: fixture.manifest.id,
        passed: false,
        durationMs: Date.now() - startedAt,
        cost: 0,
        waves: [],
        error: `fixApply error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const outcome = await runAcceptance(fixture.acceptanceCommand, workdir, fixture.manifest.timeoutMs);

    const passed = !outcome.timedOut && outcome.exitCode === 0;
    return {
      schemaVersion: 1,
      fixtureId: fixture.manifest.id,
      passed,
      durationMs: Date.now() - startedAt,
      cost: fixApplyResult.cost,
      waves: fixApplyResult.waves,
      ...(outcome.timedOut ? { error: `timeout after ${fixture.manifest.timeoutMs}ms` } : {}),
      acceptanceStdout: outcome.stdout,
      acceptanceStderr: outcome.stderr,
    };
  } finally {
    if (!opts.keep) {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}

function runAcceptance(command: string, cwd: string, timeoutMs: number): Promise<AcceptanceOutcome> {
  return new Promise<AcceptanceOutcome>((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: null, stdout, stderr: stderr + String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr, timedOut });
    });
  });
}
