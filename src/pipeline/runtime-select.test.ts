import { describe, expect, it } from 'vitest';
import { claudeCliRuntimeFactory, defaultAgentRuntimeFactory } from '../ai/runtime/index.js';
import { buildRuntimeFactory, resolveRuntimeKind } from './runtime-select.js';

/* ------------------------------------------------------------------ */
/*  Issue #407 — resolution precedence (option > config > 'pi')        */
/* ------------------------------------------------------------------ */

describe('resolveRuntimeKind', () => {
  it("returns 'pi' when both option and config are undefined", () => {
    expect(resolveRuntimeKind(undefined, undefined)).toBe('pi');
  });

  it('returns config when option is undefined', () => {
    expect(resolveRuntimeKind(undefined, 'claude-cli')).toBe('claude-cli');
    expect(resolveRuntimeKind(undefined, 'pi')).toBe('pi');
  });

  it('option always wins over config', () => {
    expect(resolveRuntimeKind('pi', 'claude-cli')).toBe('pi');
    expect(resolveRuntimeKind('claude-cli', 'pi')).toBe('claude-cli');
  });
});

describe('buildRuntimeFactory (no MCP wrap)', () => {
  it("returns defaultAgentRuntimeFactory for kind='pi'", () => {
    const factory = buildRuntimeFactory('pi');
    expect(factory).toBe(defaultAgentRuntimeFactory);
  });

  it("returns claudeCliRuntimeFactory for kind='claude-cli' when no MCP servers supplied", () => {
    const factory = buildRuntimeFactory('claude-cli');
    expect(factory).toBe(claudeCliRuntimeFactory);
  });

  it("wraps claudeCliRuntimeFactory when mcpServers supplied for kind='claude-cli'", () => {
    const factory = buildRuntimeFactory('claude-cli', { foo: { command: 'foo' } });
    expect(factory).not.toBe(claudeCliRuntimeFactory);
    expect(typeof factory.create).toBe('function');
  });

  it("ignores mcpServers for kind='pi' (no wrap)", () => {
    const factory = buildRuntimeFactory('pi', { foo: { command: 'foo' } });
    expect(factory).toBe(defaultAgentRuntimeFactory);
  });
});
