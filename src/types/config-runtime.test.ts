import { describe, expect, it } from 'vitest';
import { RepoConfigSchema } from './config.js';

/* ------------------------------------------------------------------ */
/*  RepoConfigSchema — runtime field (issue #407)                       */
/* ------------------------------------------------------------------ */

describe('RepoConfigSchema — runtime', () => {
  it("parses config with runtime: 'pi'", () => {
    const result = RepoConfigSchema.safeParse({ path: '/opt/repo', runtime: 'pi' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe('pi');
    }
  });

  it("parses config with runtime: 'claude-cli'", () => {
    const result = RepoConfigSchema.safeParse({ path: '/opt/repo', runtime: 'claude-cli' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe('claude-cli');
    }
  });

  it("defaults runtime to 'pi' when omitted", () => {
    const result = RepoConfigSchema.safeParse({ path: '/opt/repo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.runtime).toBe('pi');
    }
  });

  it('rejects unknown runtime values', () => {
    const result = RepoConfigSchema.safeParse({ path: '/opt/repo', runtime: 'openai' });
    expect(result.success).toBe(false);
  });
});
