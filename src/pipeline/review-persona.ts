// Reviewer persona selection + persona-aware prompt loader.
//
// The review wave defaults to the generalist `review.md` prompt that has shipped
// with kova since day one. Issue #305 adds three specialized personas
// (security / performance / architecture) borrowed from the
// awesome-claude-code-subagents catalog. This module picks one based on the
// issue's labels and the assess wave's modules_affected, then loads the matching
// prompt file from `prompts/review/{persona}.md` (with a graceful fallback to
// the existing `review.md` so unconfigured repos still work).
//
// Selection rules:
//   1. Labels beat modules. Try labels first.
//   2. Label match precedence: security > performance > architecture.
//   3. If no label matches, fall back to a module-name heuristic.
//   4. If neither matches, return 'generalist'.

import { fs, path } from 'zx';
import type { ProjectContext } from '../services/project-context.js';
import type { CustomTool } from '../types/index.js';
import { loadPrompt } from './prompts.js';

export type ReviewerPersona = 'security' | 'performance' | 'architecture' | 'generalist';

interface PersonaSelectionInput {
  /** Issue labels (raw strings, case-insensitive match). */
  labels: readonly string[];
  /** Modules touched by the change, as reported by assess.surface_area.modules_affected. */
  modulesAffected: readonly string[];
}

/**
 * Label vocab per persona — lowercase, exact-match. Keep these narrow on
 * purpose: a fuzzy match here would surprise reviewers and bypass the
 * "generalist is the default" guarantee.
 */
const PERSONA_LABELS: Record<Exclude<ReviewerPersona, 'generalist'>, readonly string[]> = {
  security: ['security', 'auth', 'crypto', 'vulnerability'],
  performance: ['performance', 'perf', 'slow', 'optimization'],
  architecture: ['architecture', 'refactor', 'tech-debt', 'design'],
};

/** Module-path substrings per persona — used only when no label fires. */
const PERSONA_MODULE_HINTS: Record<Exclude<ReviewerPersona, 'generalist'>, readonly string[]> = {
  security: ['auth/', 'security/', 'crypto/', 'secrets/', 'auth.', 'security.'],
  performance: ['perf/', 'cache/', 'pool/', 'query/', 'cache.', 'pool.', 'query.'],
  architecture: [],
};

const PERSONA_ORDER: readonly Exclude<ReviewerPersona, 'generalist'>[] = ['security', 'performance', 'architecture'];

/**
 * Choose the reviewer persona for this issue.
 *
 * Pure function: takes labels + modules, returns a persona literal. No I/O.
 * Defaults to 'generalist' when nothing matches — the existing review.md path.
 */
export function selectReviewerPersona({ labels, modulesAffected }: PersonaSelectionInput): ReviewerPersona {
  const lowerLabels = new Set(labels.map((l) => l.trim().toLowerCase()));

  // Pass 1: labels (case-insensitive, exact match against persona vocab).
  for (const persona of PERSONA_ORDER) {
    for (const keyword of PERSONA_LABELS[persona]) {
      if (lowerLabels.has(keyword)) {
        return persona;
      }
    }
  }

  // Pass 2: module-name heuristics. Modules come from the assess wave and are
  // typically file paths or path prefixes — substring match against known hints.
  const lowerModules = modulesAffected.map((m) => m.toLowerCase());
  for (const persona of PERSONA_ORDER) {
    const hints = PERSONA_MODULE_HINTS[persona];
    if (hints.length === 0) continue;
    if (lowerModules.some((mod) => hints.some((hint) => mod.includes(hint)))) {
      return persona;
    }
  }

  return 'generalist';
}

/**
 * Load the system prompt body for a chosen reviewer persona.
 *
 * Search order — custom promptsDir always wins when set, so per-repo
 * overrides are total (no surprise-blending of custom + built-in personas):
 *
 *   When `promptsDir` is set (per-repo prompt directory):
 *     1. `${promptsDir}/review/${persona}.md`   (custom persona)
 *     2. `${promptsDir}/review.md`              (custom generic review prompt)
 *     3. `<built-in>/prompts/review/${persona}.md` (built-in persona)
 *     4. `<built-in>/prompts/review.md`         (built-in generalist)
 *
 *   When `promptsDir` is unset (default kova install):
 *     1. `<built-in>/prompts/review/${persona}.md` (built-in persona)
 *     2. `<built-in>/prompts/review.md`         (built-in generalist)
 *
 * Template-variable substitution ({{CLAUDE_MD}} etc.) is delegated to
 * `loadPrompt` so the persona files share the same project-context flow as
 * every other wave.
 *
 * Note: review wave does NOT receive customTools (it's read-only), so we pass
 * `undefined` for tools — same as the existing review-wave call site.
 */
export async function loadReviewPersonaPrompt(
  persona: ReviewerPersona,
  customTools: readonly CustomTool[] | undefined,
  projectContext: ProjectContext | undefined,
  promptsDir: string | undefined,
): Promise<string> {
  const personaWave = `review/${persona}`;
  const builtinDir = path.join(import.meta.dirname, '..', '..', 'prompts');

  // Step 1: custom promptsDir wins if set. Try the custom persona file first,
  // then the custom generic review.md. We probe-then-load so we never trip
  // loadPrompt's "no prompt found" throw path.
  if (promptsDir) {
    if (await fileExists(path.join(promptsDir, `${personaWave}.md`))) {
      return loadPrompt(personaWave, customTools, projectContext, promptsDir);
    }
    if (await fileExists(path.join(promptsDir, 'review.md'))) {
      return loadPrompt('review', customTools, projectContext, promptsDir);
    }
  }

  // Step 2: built-in persona file (default behaviour for vanilla installs).
  if (await fileExists(path.join(builtinDir, `${personaWave}.md`))) {
    return loadPrompt(personaWave, customTools, projectContext, promptsDir);
  }

  // Step 3: built-in generalist review.md — the original behaviour. This is
  // the path that unconfigured repos hit when a persona is selected but the
  // persona file is missing (e.g. an old kova install before #305).
  return loadPrompt('review', customTools, projectContext, promptsDir);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
