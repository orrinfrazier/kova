import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EpisodicMemoryConfig, FixState, WaveResult } from '../types/config.js';
import { buildEpisodeRecord, type EpisodeRecord, recordEpisode } from './vectordb.js';

/* ------------------------------------------------------------------ */
/*  Mock fetch                                                         */
/* ------------------------------------------------------------------ */

const mockFetch = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const ENDPOINT = 'http://localhost:8100/query';

function makeEpisodeConfig(overrides?: Partial<EpisodicMemoryConfig>): EpisodicMemoryConfig {
  return { enabled: true, endpoint: ENDPOINT, max_episodes: 3, ...overrides };
}

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeWaveResult(wave: string, artifact: unknown, overrides?: Partial<WaveResult>): WaveResult {
  return {
    wave: wave as WaveResult['wave'],
    success: true,
    artifact,
    duration: 1000,
    cost: 0.05,
    turns: 5,
    ...overrides,
  };
}

function makeFixState(overrides?: Partial<FixState>): FixState {
  return {
    issue: { number: 42, title: 'Fix login bug', body: 'body', labels: ['bug', 'auth'], url: 'https://example.com/42' },
    repo: 'test-repo',
    repoPath: '/tmp/test',
    startedAt: '2026-04-07T10:00:00.000Z',
    completedWaves: ['assess', 'spec', 'test', 'impl', 'quality', 'review', 'ship'],
    waveResults: {
      assess: makeWaveResult('assess', {
        grade: 'A',
        surface_area: { files: ['src/auth.ts'], estimated_lines: 20, modules_affected: ['auth'] },
        risk: 'low',
        reasoning: 'simple fix',
        should_proceed: true,
      }),
      spec: makeWaveResult('spec', {
        summary: 'Add TTL check in auth middleware',
        pieces: [
          { name: 'TTL check', description: 'desc', files: ['src/auth.ts'], acceptance_criteria: ['AC1'], wiring: [] },
        ],
        dependency_order: [[0]],
        constraints: [],
      }),
      impl: makeWaveResult('impl', {
        files_modified: ['src/auth.ts'],
        files_created: ['src/auth.test.ts'],
        tests_passing: true,
      }),
      quality: makeWaveResult('quality', {
        lint: 'pass',
        typecheck: 'pass',
        tests: 'pass',
        coverage: 85,
        audit: 'pass',
        all_passing: true,
      }),
      review: makeWaveResult('review', {
        verdict: 'pass',
        findings: [{ category: 'mechanical_fix', file: 'src/auth.ts', severity: 'low', description: 'unused import' }],
        summary: 'looks good',
      }),
      ship: makeWaveResult(
        'ship',
        { prUrl: 'https://github.com/test/repo/pull/1' },
        { cost: 0, turns: 0, duration: 500 },
      ),
    },
    status: 'completed',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  buildEpisodeRecord                                                 */
/* ------------------------------------------------------------------ */

describe('buildEpisodeRecord', () => {
  it('extracts issue metadata from state', () => {
    const record = buildEpisodeRecord(makeFixState());
    expect(record.issue_number).toBe(42);
    expect(record.issue_title).toBe('Fix login bug');
    expect(record.labels).toEqual(['bug', 'auth']);
    expect(record.repo).toBe('test-repo');
  });

  it('extracts approach from spec summary', () => {
    expect(buildEpisodeRecord(makeFixState()).approach).toBe('Add TTL check in auth middleware');
  });

  it('extracts files changed from impl artifact', () => {
    expect(buildEpisodeRecord(makeFixState()).files_changed).toEqual(['src/auth.ts', 'src/auth.test.ts']);
  });

  it('extracts quality gate results', () => {
    expect(buildEpisodeRecord(makeFixState()).quality_gates).toEqual({
      lint: 'pass',
      typecheck: 'pass',
      tests: 'pass',
      coverage: 85,
      audit: 'pass',
      all_passing: true,
    });
  });

  it('extracts review findings', () => {
    const record = buildEpisodeRecord(makeFixState());
    expect(record.review_findings).toHaveLength(1);
    expect(record.review_findings[0]).toEqual({
      category: 'mechanical_fix',
      file: 'src/auth.ts',
      severity: 'low',
      description: 'unused import',
    });
  });

  it('sets outcome to pr_created when ship has prUrl', () => {
    expect(buildEpisodeRecord(makeFixState()).outcome).toBe('pr_created');
  });

  it('sets outcome to failed when state.status is failed', () => {
    const record = buildEpisodeRecord(
      makeFixState({
        status: 'failed',
        completedWaves: ['assess', 'spec'],
        waveResults: { assess: makeFixState().waveResults.assess!, spec: makeFixState().waveResults.spec! },
      }),
    );
    expect(record.outcome).toBe('failed');
    expect(record.failed_at_wave).toBe('test');
  });

  it('sets outcome to skipped when assess says should_not_proceed', () => {
    const record = buildEpisodeRecord(
      makeFixState({
        status: 'completed',
        completedWaves: ['assess'],
        waveResults: {
          assess: makeWaveResult('assess', {
            grade: 'D',
            surface_area: { files: [], estimated_lines: 500, modules_affected: [] },
            risk: 'high',
            reasoning: 'too complex',
            should_proceed: false,
          }),
        },
      }),
    );
    expect(record.outcome).toBe('skipped');
  });

  it('aggregates cost, duration, and turns across waves', () => {
    const record = buildEpisodeRecord(makeFixState());
    expect(record.total_cost).toBeCloseTo(0.05 * 5 + 0, 4);
    expect(record.total_turns).toBe(5 * 5 + 0);
  });

  it('handles missing quality artifact gracefully', () => {
    const state = makeFixState();
    delete state.waveResults.quality;
    expect(buildEpisodeRecord(state).quality_gates).toBeNull();
  });

  it('handles missing review artifact gracefully', () => {
    const state = makeFixState();
    delete state.waveResults.review;
    expect(buildEpisodeRecord(state).review_findings).toEqual([]);
  });

  it('handles missing spec artifact gracefully', () => {
    const state = makeFixState();
    delete state.waveResults.spec;
    expect(buildEpisodeRecord(state).approach).toBe('');
  });

  it('failed_at_wave is null for successful fixes', () => {
    expect(buildEpisodeRecord(makeFixState()).failed_at_wave).toBeNull();
  });

  it('failed_at_wave points to wave after last completed on failure', () => {
    const record = buildEpisodeRecord(
      makeFixState({
        status: 'failed',
        completedWaves: ['assess', 'spec', 'test', 'impl'],
        waveResults: {
          assess: makeFixState().waveResults.assess!,
          spec: makeFixState().waveResults.spec!,
          test: makeFixState().waveResults.test!,
          impl: makeFixState().waveResults.impl!,
        },
      }),
    );
    expect(record.failed_at_wave).toBe('quality');
  });
});

/* ------------------------------------------------------------------ */
/*  recordEpisode                                                      */
/* ------------------------------------------------------------------ */

describe('recordEpisode', () => {
  const sampleRecord: EpisodeRecord = {
    issue_number: 42,
    issue_title: 'Fix login bug',
    labels: ['bug'],
    repo: 'test-repo',
    approach: 'Add TTL check',
    files_changed: ['src/auth.ts'],
    quality_gates: { lint: 'pass', typecheck: 'pass', tests: 'pass', coverage: 85, audit: 'pass', all_passing: true },
    review_findings: [],
    outcome: 'pr_created',
    failed_at_wave: null,
    total_cost: 0.48,
    total_duration: 20000,
    total_turns: 32,
    timestamp: '2026-04-07T10:05:00.000Z',
  };

  it('sends PUT request with episode record', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ ok: true }));
    const result = await recordEpisode(makeEpisodeConfig(), sampleRecord);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('PUT');
    const body = JSON.parse(init.body as string) as EpisodeRecord;
    expect(body.issue_number).toBe(42);
    expect(body.outcome).toBe('pr_created');
  });

  it('returns false when disabled', async () => {
    const result = await recordEpisode(makeEpisodeConfig({ enabled: false }), sampleRecord);
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns false when endpoint is missing', async () => {
    const result = await recordEpisode(makeEpisodeConfig({ endpoint: undefined }), sampleRecord);
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns false on network error (graceful degradation)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await recordEpisode(makeEpisodeConfig(), sampleRecord)).toBe(false);
  });

  it('returns false on non-200 response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ error: 'fail' }, 500));
    expect(await recordEpisode(makeEpisodeConfig(), sampleRecord)).toBe(false);
  });
});
