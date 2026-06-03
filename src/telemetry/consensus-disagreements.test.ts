// Tests for the consensus-disagreement JSONL log (#262).
//
// The log captures every adjudicator decision where the reconciled artifact
// rejected the consensus/majority of the pool — the signal /reflect consumes
// to surface which models drifted from the rest of the group.

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendConsensusDisagreement,
  type ConsensusDisagreementRecord,
  ConsensusDisagreementRecordSchema,
  consensusDisagreementsPath,
  readConsensusDisagreements,
} from './consensus-disagreements.js';

let tmpRepoPath: string;

beforeEach(async () => {
  tmpRepoPath = await mkdtemp(join(tmpdir(), 'kova-consensus-disagreements-'));
});

afterEach(async () => {
  // Best-effort cleanup; tmpdir entries are bounded.
  try {
    const { rm } = await import('node:fs/promises');
    await rm(tmpRepoPath, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function makeRecord(overrides: Partial<ConsensusDisagreementRecord> = {}): ConsensusDisagreementRecord {
  return {
    timestamp: '2026-06-03T00:00:00.000Z',
    wave: 'review',
    agreement: 'majority',
    adjudicator_model: 'anthropic:claude-opus-4-7',
    pool_size: 3,
    rejected_count: 2,
    degraded: false,
    rejected_models: ['anthropic:claude-sonnet-4-6', 'google:gemini-2-5-pro'],
    adjudicator_artifact_hash: 'sha256:adj',
    pool_artifact_hashes: ['sha256:adj', 'sha256:other', 'sha256:other'],
    ...overrides,
  };
}

describe('appendConsensusDisagreement', () => {
  it('writes a JSONL line at .kova/consensus_disagreements.jsonl', async () => {
    const record = makeRecord();
    await appendConsensusDisagreement(tmpRepoPath, record);

    const filePath = consensusDisagreementsPath(tmpRepoPath);
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toEqual(record);
    // The trailing newline is required so a follow-up append starts on its own line.
    expect(content.endsWith('\n')).toBe(true);
  });

  it('appends — does not overwrite existing records', async () => {
    await appendConsensusDisagreement(tmpRepoPath, makeRecord({ wave: 'spec' }));
    await appendConsensusDisagreement(tmpRepoPath, makeRecord({ wave: 'review' }));
    await appendConsensusDisagreement(tmpRepoPath, makeRecord({ wave: 'impl' }));

    const records = await readConsensusDisagreements(tmpRepoPath);
    expect(records.map((r) => r.wave)).toEqual(['spec', 'review', 'impl']);
  });

  it('creates the .kova directory when missing', async () => {
    // No .kova directory yet — appendConsensusDisagreement must mkdir -p it.
    await appendConsensusDisagreement(tmpRepoPath, makeRecord());
    const records = await readConsensusDisagreements(tmpRepoPath);
    expect(records).toHaveLength(1);
  });

  it('rejects records that fail schema validation', async () => {
    const bad = { ...makeRecord(), rejected_count: -1 };
    await expect(appendConsensusDisagreement(tmpRepoPath, bad as ConsensusDisagreementRecord)).rejects.toThrow();
  });
});

describe('readConsensusDisagreements', () => {
  it('returns [] when the file does not exist', async () => {
    const records = await readConsensusDisagreements(tmpRepoPath);
    expect(records).toEqual([]);
  });

  it('skips malformed lines without throwing', async () => {
    const filePath = consensusDisagreementsPath(tmpRepoPath);
    await mkdir(join(tmpRepoPath, '.kova'), { recursive: true });
    const valid = makeRecord({ wave: 'spec' });
    await writeFile(
      filePath,
      [
        JSON.stringify(valid),
        'not-json',
        // Valid JSON but schema fails (missing required fields):
        JSON.stringify({ wave: 'spec' }),
        JSON.stringify(makeRecord({ wave: 'impl' })),
        '',
      ].join('\n'),
    );

    const records = await readConsensusDisagreements(tmpRepoPath);
    expect(records.map((r) => r.wave)).toEqual(['spec', 'impl']);
  });
});

describe('ConsensusDisagreementRecordSchema', () => {
  it('validates a well-formed record', () => {
    expect(() => ConsensusDisagreementRecordSchema.parse(makeRecord())).not.toThrow();
  });

  it('rejects unknown agreement values', () => {
    const bad = { ...makeRecord(), agreement: 'whatever' };
    expect(() => ConsensusDisagreementRecordSchema.parse(bad)).toThrow();
  });

  it('requires rejected_count >= 0', () => {
    const bad = { ...makeRecord(), rejected_count: -1 };
    expect(() => ConsensusDisagreementRecordSchema.parse(bad)).toThrow();
  });

  it('requires pool_size >= 2', () => {
    const bad = { ...makeRecord(), pool_size: 1 };
    expect(() => ConsensusDisagreementRecordSchema.parse(bad)).toThrow();
  });
});
