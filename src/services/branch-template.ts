/**
 * Branch-name template renderer for `repos.yaml` `branch_name_template`.
 *
 * Borrowed from claude-code-action `branch_name_template`
 * (oss/claude-code-action/action.yml:26-29). Supports seven variables:
 *
 *   {{prefix}}        — caller-supplied prefix (e.g. "kova/")
 *   {{entityType}}    — "issue" | "pr" | etc.
 *   {{entityNumber}}  — N as a string
 *   {{timestamp}}     — caller-supplied timestamp (no format constraint)
 *   {{sha}}           — short SHA (caller-supplied)
 *   {{label}}         — caller-supplied label or ""
 *   {{description}}   — first N words of title, kebab-case, lowercased
 *
 * Default kova template is `kova/fix-{{entityNumber}}` — backward-compatible
 * with every existing branch.
 */

export interface BranchTemplateVars {
  prefix: string;
  entityType: string;
  entityNumber: number | string;
  timestamp: string;
  sha: string;
  label: string;
  description: string;
}

/**
 * Slug-ify the first `wordCount` words of `title` into a kebab-case
 * branch-safe description. Non-alphanumeric characters are replaced with
 * hyphens; consecutive hyphens are collapsed; leading/trailing hyphens are
 * trimmed.
 */
export function kebabDescription(title: string, wordCount = 5): string {
  if (!title) return '';
  // Split on whitespace, take first N words, lowercase, replace non-alphanumeric
  // ASCII with hyphens, collapse hyphens, trim.
  const words = title.trim().split(/\s+/).slice(0, wordCount).join(' ').toLowerCase();
  return words
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Sanitize the final branch ref to git-safe characters. Git rejects refs
 * containing: spaces, `~`, `^`, `:`, `?`, `*`, `[`, `\\`, ASCII control chars,
 * and a few other patterns. We're more conservative: keep only
 * `[A-Za-z0-9/_\\-.]`, collapse runs of hyphens introduced by the strip, and
 * trim leading/trailing hyphens or slashes from each path segment.
 */
function sanitizeRef(ref: string): string {
  const cleaned = ref.replace(/[^A-Za-z0-9/_\-.]+/g, '-');
  // Per-segment cleanup so we don't introduce empty segments.
  const segments = cleaned.split('/').map((seg) => seg.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, ''));
  return segments.filter((s) => s.length > 0).join('/');
}

/**
 * Render `template` with the seven supported `{{name}}` variables, then
 * sanitize the result so it's a valid git ref.
 *
 * Unknown variables render as empty strings (claude-code-action behavior).
 * Whitespace inside the braces is tolerated: `{{ entityNumber }}` works.
 */
export function renderBranchTemplate(template: string, vars: BranchTemplateVars): string {
  const lookup: Record<string, string> = {
    prefix: vars.prefix,
    entityType: vars.entityType,
    entityNumber: String(vars.entityNumber),
    timestamp: vars.timestamp,
    sha: vars.sha,
    label: vars.label,
    description: vars.description,
  };

  const rendered = template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (_match, name: string) => {
    return Object.hasOwn(lookup, name) ? (lookup[name] ?? '') : '';
  });

  return sanitizeRef(rendered);
}

/**
 * Default kova branch template — preserves the historical `kova/fix-{N}`
 * pattern. Exported so worktree.ts can call `renderBranchTemplate` uniformly
 * (with or without a user-supplied template).
 */
export const DEFAULT_BRANCH_TEMPLATE = 'kova/fix-{{entityNumber}}';
