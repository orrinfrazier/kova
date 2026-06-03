/**
 * Tests for branch-template.ts — Mustache-style variable substitution for
 * `repos.yaml` `branch_name_template`. Borrowed from claude-code-action
 * `branch_name_template` (oss/claude-code-action/action.yml:26-29).
 *
 * Variables supported:
 *   {{prefix}}        — caller-supplied prefix (e.g. "kova/")
 *   {{entityType}}    — "issue" | "pr" | etc.
 *   {{entityNumber}}  — N as a string
 *   {{timestamp}}     — caller-supplied timestamp (e.g. "20260601")
 *   {{sha}}           — short SHA (caller-supplied)
 *   {{label}}         — caller-supplied label or ""
 *   {{description}}   — first 5 words of title, kebab-case, lowercased
 */

import { describe, expect, it } from 'vitest';
import { kebabDescription, renderBranchTemplate } from './branch-template.js';

describe('kebabDescription', () => {
  it('takes first 5 words and kebab-cases them', () => {
    expect(kebabDescription('fix the login form crash on empty input')).toBe('fix-the-login-form-crash');
  });

  it('strips punctuation and normalizes whitespace', () => {
    expect(kebabDescription('feat: add Dark-Mode toggle, please!')).toBe('feat-add-dark-mode-toggle-please');
  });

  it('lowercases', () => {
    expect(kebabDescription('FEAT: Add Dark Mode TOGGLE Please')).toBe('feat-add-dark-mode-toggle');
  });

  it('handles empty string', () => {
    expect(kebabDescription('')).toBe('');
  });

  it('handles single word', () => {
    expect(kebabDescription('refactor')).toBe('refactor');
  });

  it('handles non-ASCII gracefully', () => {
    // unicode letters are stripped to keep slug stable across systems
    expect(kebabDescription('feat: café résumé builder', 5)).toBe('feat-caf-r-sum-builder');
  });

  it('caps at the requested word count', () => {
    expect(kebabDescription('one two three four five six seven', 3)).toBe('one-two-three');
  });

  it('collapses consecutive non-alphanumeric runs into a single hyphen', () => {
    expect(kebabDescription('foo   bar---baz__qux')).toBe('foo-bar-baz-qux');
  });
});

describe('renderBranchTemplate', () => {
  const baseVars = {
    prefix: 'kova/',
    entityType: 'issue',
    entityNumber: 320,
    timestamp: '20260601',
    sha: 'abc1234',
    label: 'enhancement',
    description: 'borrow-three-more-patterns-from-claude',
  };

  it('renders the claude-code-action default-ish template', () => {
    expect(renderBranchTemplate('{{prefix}}{{entityType}}-{{entityNumber}}-{{description}}', baseVars)).toBe(
      'kova/issue-320-borrow-three-more-patterns-from-claude',
    );
  });

  it('renders the kova legacy default unchanged', () => {
    expect(renderBranchTemplate('kova/fix-{{entityNumber}}', baseVars)).toBe('kova/fix-320');
  });

  it('supports all 7 variables', () => {
    const tpl = '{{prefix}}{{entityType}}-{{entityNumber}}/{{timestamp}}-{{sha}}-{{label}}-{{description}}';
    expect(renderBranchTemplate(tpl, baseVars)).toBe(
      'kova/issue-320/20260601-abc1234-enhancement-borrow-three-more-patterns-from-claude',
    );
  });

  it('leaves unknown variables empty (and sanitizer strips leading hyphens per segment)', () => {
    // Sanitizer strips the leading hyphen of `-end` because git refs can't start with a hyphen.
    expect(renderBranchTemplate('{{prefix}}{{entityNumber}}/{{unknown}}-end', baseVars)).toBe('kova/320/end');
  });

  it('replaces all occurrences of a variable', () => {
    expect(renderBranchTemplate('{{entityNumber}}-{{entityNumber}}', baseVars)).toBe('320-320');
  });

  it('is whitespace-tolerant inside the mustache braces', () => {
    expect(renderBranchTemplate('{{ entityNumber }}-{{   description }}', baseVars)).toBe(
      '320-borrow-three-more-patterns-from-claude',
    );
  });

  it('sanitizes the final result to git-ref-safe characters', () => {
    // a label like "needs:work" must not produce an invalid ref
    const sanitized = renderBranchTemplate('{{prefix}}{{label}}/{{entityNumber}}', {
      ...baseVars,
      label: 'needs:work?',
    });
    // colons and question marks are not allowed in git refs — they get replaced or stripped
    expect(sanitized).not.toContain('?');
    expect(sanitized).not.toMatch(/:[^/]/);
  });
});
