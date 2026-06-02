// Skills loader — wraps pi-mono's loadSkillsFromDir for kova's per-wave skill
// surfacing (issue #298).
//
// Resolves configured dirs (handling `~` expansion + relative-to-cwd) and
// returns a deduped flat Skill[]. First dir wins on name collisions so the
// default `~/.claude/skills` → `.kova/skills` ordering means user-global skills
// take precedence over per-repo overrides unless the user reorders the config.
//
// Missing dirs are silently tolerated (pi-mono's loadSkillsFromDir returns
// empty when the dir does not exist). Diagnostics are logged at debug level
// so wave startup never fails on a stale skill directory.

import { homedir } from 'node:os';
import path from 'node:path';
import { loadSkillsFromDir, type Skill } from '@earendil-works/pi-coding-agent';
import { log } from '../utils/logger.js';

export interface LoadWaveSkillsOptions {
  /** Directories to scan. Order determines collision precedence (first wins). */
  dirs: readonly string[];
  /** Repo root — relative dir paths are resolved against this. */
  cwd: string;
}

/** Expand `~` to $HOME, then resolve the path against `cwd` if it is relative. */
function resolveDir(dir: string, cwd: string): string {
  let resolved = dir;
  if (resolved.startsWith('~')) {
    // ~/foo or ~ alone — replace the leading ~ with $HOME.
    // We do NOT support ~user (per-user home expansion) — pi-mono does not, and
    // kova's threat model expects only the agent's own home.
    resolved = path.join(homedir(), resolved.slice(1).replace(/^[/\\]/, ''));
  }
  return path.isAbsolute(resolved) ? resolved : path.resolve(cwd, resolved);
}

/** Per-dir source label fed to pi-mono. Used for diagnostics + collision logs. */
function sourceLabelFor(dir: string): string {
  if (dir.startsWith('~')) return 'user';
  if (path.isAbsolute(dir)) return 'path';
  return 'project';
}

/**
 * Load skills from the configured directories, deduped by name (first dir wins).
 *
 * Never throws — missing dirs and parse errors are logged at debug level and
 * filtered out. A wave that fails to load skills still gets its fallback
 * prompt unmodified.
 */
export async function loadWaveSkills(options: LoadWaveSkillsOptions): Promise<Skill[]> {
  const { dirs, cwd } = options;
  if (dirs.length === 0) return [];

  const seen = new Map<string, Skill>();
  for (const rawDir of dirs) {
    const resolved = resolveDir(rawDir, cwd);
    try {
      const { skills, diagnostics } = loadSkillsFromDir({
        dir: resolved,
        source: sourceLabelFor(rawDir),
      });
      for (const diag of diagnostics) {
        log.debug(`[skills] ${diag.type}: ${diag.message} (${diag.path ?? resolved})`);
      }
      for (const skill of skills) {
        if (!seen.has(skill.name)) {
          seen.set(skill.name, skill);
        } else {
          // Collision — first wins per documented order.
          log.debug(
            `[skills] name collision: "${skill.name}" already loaded from ${seen.get(skill.name)?.filePath}; ignoring ${skill.filePath}`,
          );
        }
      }
    } catch (err) {
      // Pi-mono should not throw, but guard anyway — never let a stale skill
      // dir bring down wave startup.
      log.debug(`[skills] error scanning ${resolved}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return Array.from(seen.values());
}
