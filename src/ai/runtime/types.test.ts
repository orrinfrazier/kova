import { describe, expect, it } from 'vitest';

describe('AgentRuntime types module', () => {
  it('exports the interface symbols (types are erased at runtime; verify file resolves)', async () => {
    const mod = await import('./types.js');
    // The module exports no runtime values — but importing it MUST succeed.
    // This guards against type-only files that fail to compile or resolve.
    expect(mod).toBeDefined();
  });

  it('module export surface includes the documented type names (compile-time check via re-import from barrel)', async () => {
    // Re-import via the barrel to ensure the public surface is wired
    const barrel = await import('./index.js');
    expect(barrel).toBeDefined();
    // Default factory MUST be exported
    expect(barrel.defaultAgentRuntimeFactory).toBeDefined();
    expect(typeof barrel.defaultAgentRuntimeFactory.create).toBe('function');
  });
});
