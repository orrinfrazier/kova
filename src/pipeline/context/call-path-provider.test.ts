import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callPathProvider } from './call-path-provider.js';
import { makeAssessResult, makeCtx } from './test-helpers.js';

vi.mock('../../services/codegraph/index.js', () => ({
  openCodegraph: vi.fn(() => ({ close: () => {} })),
}));

vi.mock('../call-path-context.js', () => ({
  resolveCallPaths: vi.fn(() => ''),
}));

import { openCodegraph } from '../../services/codegraph/index.js';
import { resolveCallPaths } from '../call-path-context.js';

describe('callPathProvider', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns undefined when assessResult is missing', async () => {
    const out = await callPathProvider.resolve(makeCtx({ assessResult: undefined }));
    expect(out).toBeUndefined();
    expect(openCodegraph).not.toHaveBeenCalled();
  });

  it('returns undefined when surface_area.files is empty', async () => {
    const out = await callPathProvider.resolve(makeCtx({ assessResult: makeAssessResult([]) }));
    expect(out).toBeUndefined();
    expect(openCodegraph).not.toHaveBeenCalled();
  });

  it('returns undefined when resolveCallPaths yields empty string', async () => {
    const out = await callPathProvider.resolve(makeCtx({ assessResult: makeAssessResult(['src/a.ts']) }));
    expect(out).toBeUndefined();
  });

  it('returns the formatted call-paths when matches exist', async () => {
    vi.mocked(resolveCallPaths).mockReturnValueOnce('### route\nbody');
    const infos: string[] = [];
    const out = await callPathProvider.resolve(
      makeCtx({
        assessResult: makeAssessResult(['src/a.ts']),
        logger: { info: (m) => infos.push(m), warn: () => {} },
      }),
    );
    expect(out).toBe('### route\nbody');
    expect(infos.some((m) => m.includes('call-path-context'))).toBe(true);
  });

  it('gracefully returns undefined when openCodegraph throws', async () => {
    vi.mocked(openCodegraph).mockImplementationOnce(() => {
      throw new Error('no db');
    });
    const warns: string[] = [];
    const out = await callPathProvider.resolve(
      makeCtx({
        assessResult: makeAssessResult(['src/a.ts']),
        logger: { info: () => {}, warn: (m) => warns.push(m) },
      }),
    );
    expect(out).toBeUndefined();
    expect(warns.some((m) => m.includes('call-path-context'))).toBe(true);
  });
});
