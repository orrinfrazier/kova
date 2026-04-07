import { describe, expect, it } from 'vitest';
import { CustomToolSchema, RepoConfigSchema } from './config.js';

describe('CustomToolSchema', () => {
  it('validates a valid tool definition', () => {
    const result = CustomToolSchema.safeParse({
      name: 'run-migrations',
      description: 'Run database migrations',
      command: 'npm run db:migrate',
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty name', () => {
    const result = CustomToolSchema.safeParse({
      name: '',
      description: 'desc',
      command: 'cmd',
    });
    expect(result.success).toBe(false);
  });

  it('rejects names with spaces or uppercase', () => {
    const invalid = ['My Tool', 'TOOL', 'run migrations', 'tool.name'];
    for (const name of invalid) {
      const result = CustomToolSchema.safeParse({ name, description: 'd', command: 'c' });
      expect(result.success).toBe(false);
    }
  });

  it('accepts names with hyphens and underscores', () => {
    const valid = ['run-migrations', 'seed_data', 'lint-fix', 'my-tool-123'];
    for (const name of valid) {
      const result = CustomToolSchema.safeParse({ name, description: 'd', command: 'c' });
      expect(result.success).toBe(true);
    }
  });

  it('rejects missing description', () => {
    const result = CustomToolSchema.safeParse({ name: 'tool', command: 'cmd' });
    expect(result.success).toBe(false);
  });

  it('rejects missing command', () => {
    const result = CustomToolSchema.safeParse({ name: 'tool', description: 'desc' });
    expect(result.success).toBe(false);
  });
});

describe('RepoConfigSchema tools field', () => {
  it('accepts config without tools (optional)', () => {
    const result = RepoConfigSchema.safeParse({ path: '/tmp/repo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toBeUndefined();
    }
  });

  it('accepts config with empty tools array', () => {
    const result = RepoConfigSchema.safeParse({ path: '/tmp/repo', tools: [] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toEqual([]);
    }
  });

  it('accepts config with valid tools', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/tmp/repo',
      tools: [
        { name: 'run-migrations', description: 'Run DB migrations', command: 'npm run db:migrate' },
        { name: 'seed-data', description: 'Seed test data', command: 'npm run db:seed' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toHaveLength(2);
      expect(result.data.tools?.[0]?.name).toBe('run-migrations');
    }
  });

  it('rejects config with invalid tools', () => {
    const result = RepoConfigSchema.safeParse({
      path: '/tmp/repo',
      tools: [{ name: 'BAD NAME', description: 'desc', command: 'cmd' }],
    });
    expect(result.success).toBe(false);
  });
});
