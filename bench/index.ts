// CLI entrypoint for `npm run bench`.
//
// Loads fixtures, iterates sequentially, appends each result to JSONL,
// prints a final summary. Flags are intentionally minimal — the harness
// is opt-in and the defaults match the on-disk layout.

import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadFixtures } from './loader.js';
import { runFixture } from './runner.js';
import { appendResult, formatSummary, summarize } from './scorer.js';
import type { FixApply, FixtureRunResult } from './types.js';

interface CliOpts {
  fixturesRoot: string;
  outPath: string;
  fixtureFilter?: string;
  keep: boolean;
  dryRun: boolean;
  tmpRoot?: string;
}

function parseArgs(argv: readonly string[]): CliOpts {
  const opts: CliOpts = {
    fixturesRoot: resolve(process.cwd(), 'bench'),
    outPath: resolve(process.cwd(), 'bench', 'results', `run-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`),
    keep: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--fixtures':
      case '-f': {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a path argument`);
        opts.fixturesRoot = resolve(value);
        break;
      }
      case '--out':
      case '-o': {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a path argument`);
        opts.outPath = resolve(value);
        break;
      }
      case '--fixture': {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a fixture id`);
        opts.fixtureFilter = value;
        break;
      }
      case '--tmp-root': {
        const value = argv[++i];
        if (!value) throw new Error(`${arg} requires a path argument`);
        opts.tmpRoot = resolve(value);
        break;
      }
      case '--keep':
        opts.keep = true;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg !== undefined) throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: npm run bench -- [options]',
      '',
      'Options:',
      '  --fixtures, -f <dir>   Root directory containing fixtures/ (default: bench)',
      '  --out, -o <path>       JSONL output path (default: bench/results/run-<ts>.jsonl)',
      '  --fixture <id>         Run only the fixture with this id',
      '  --tmp-root <dir>       Temp root for per-run workdirs (default: os tmpdir)',
      '  --keep                 Keep per-run temp workdirs for inspection',
      '  --dry-run              Use a no-op fixApply (verifies harness without invoking fix())',
      '  --help, -h             Show this help',
      '',
    ].join('\n'),
  );
}

async function buildFixApply(dryRun: boolean): Promise<FixApply> {
  if (dryRun) {
    return async () => ({ cost: 0, waves: [] });
  }
  const { createRealFixApply } = await import('./fixApply.js');
  return createRealFixApply('bench-fixture');
}

export async function runBench(argv: readonly string[]): Promise<number> {
  const opts = parseArgs(argv);
  const fixtures = await loadFixtures(opts.fixturesRoot);
  if (fixtures.length === 0) {
    process.stderr.write(`[bench] no fixtures found under ${join(opts.fixturesRoot, 'fixtures')}\n`);
    return 1;
  }

  const selected = opts.fixtureFilter ? fixtures.filter((f) => f.manifest.id === opts.fixtureFilter) : fixtures;
  if (selected.length === 0) {
    process.stderr.write(`[bench] no fixture matches --fixture ${opts.fixtureFilter ?? ''}\n`);
    return 1;
  }

  await mkdir(dirname(opts.outPath), { recursive: true });
  const fixApply = await buildFixApply(opts.dryRun);
  const results: FixtureRunResult[] = [];

  for (const fixture of selected) {
    process.stdout.write(`[bench] running ${fixture.manifest.id} ...\n`);
    const result = await runFixture(fixture, {
      fixApply,
      ...(opts.tmpRoot !== undefined ? { tmpRoot: opts.tmpRoot } : {}),
      keep: opts.keep,
    });
    await appendResult(opts.outPath, result);
    results.push(result);
    process.stdout.write(
      `[bench]   ${result.passed ? 'PASS' : 'FAIL'} (${result.durationMs}ms, $${result.cost.toFixed(4)})\n`,
    );
  }

  const summary = summarize(results);
  process.stdout.write('\n');
  process.stdout.write(formatSummary(summary));
  process.stdout.write(`\nResults JSONL: ${opts.outPath}\n`);
  return summary.failed === 0 ? 0 : 1;
}

// Entry point when invoked directly via `node dist-bench/index.js`.
// The compiled file lives at dist-bench/index.js; we compare resolved
// paths (with file: URL) to detect the "run as main script" case
// without relying on `import.meta.main` (Node 22+ only).
const invokedDirectly = (() => {
  if (typeof process === 'undefined' || !process.argv[1]) return false;
  const entry = process.argv[1];
  const here = new URL(import.meta.url).pathname;
  return entry === here || here.endsWith(entry) || entry.endsWith('/dist-bench/index.js');
})();

if (invokedDirectly) {
  runBench(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[bench] error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exit(1);
    },
  );
}
