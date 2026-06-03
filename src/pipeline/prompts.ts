// Prompt loader — reads wave prompts from prompts/ directory.
// Prompts are markdown files, one per wave.
// Custom tools are appended to impl/quality prompts when configured.
// Per-repo custom prompts override defaults when prompts_dir is configured.
// Skills (issue #298) are appended via formatSkillsForPrompt, gated per wave.

import { formatSkillsForPrompt, type Skill } from '@earendil-works/pi-coding-agent';
import { fs, path } from 'zx';
import type { CustomTool, SkillWaveName } from '../types/index.js';
import type { ProjectContext } from './project-context.js';

const PROMPTS_DIR = path.join(import.meta.dirname, '..', '..', 'prompts');

const DEFAULT_PROMPT_PLACEHOLDER = '{{DEFAULT_PROMPT}}';

const FALLBACK_PROMPTS: Record<string, string> = {
  assess: `You are assessing a GitHub issue for feasibility.

Analyze the issue and the codebase to determine:
1. Surface area: which files need to change, how many lines, which modules
2. Risk level: test coverage in affected areas, external dependencies, breaking changes
3. Grade (A-F): A=1-3 files clear criteria, B=3-8 files mostly clear, C=8-15 needs research, D=15+ vague, F=needs breakdown

Read the relevant code files before making your assessment.
Output your assessment as structured JSON.`,

  spec: `You are decomposing a GitHub issue into independently testable pieces.

For each piece:
- Name and description
- Specific files to modify/create
- Testable acceptance criteria
- Wiring needed (imports, exports, build system)

Rules:
- 2-4 pieces ideal, max 6
- Each piece must be independently testable
- List dependency order between pieces
- Do NOT write code — only specify what needs to change`,

  test: `You are writing failing tests (TDD red phase).

Read the spec and existing code. Write tests that:
- Cover each acceptance criterion
- Follow the project's existing test patterns
- Will FAIL against the current code (they test new behavior)
- Use the project's test framework

Run the tests after writing them to confirm they fail.`,

  impl: `You are implementing code to make failing tests pass (TDD green phase).

Rules:
- Read the failing tests FIRST
- Write MINIMAL code to pass tests
- Wire everything (imports, exports, build system entries)
- Run tests after implementation to verify they pass
- If tests still fail, read the error output and adjust

Escalation: if tests fail after 2 attempts, output a DIAGNOSIS explaining what's wrong.`,

  quality: `You are running quality gates on the codebase.

Run these checks in order. If any fail, FIX the issue and re-run:
1. Lint (detect from project: eslint, biome, clippy, ruff, golangci-lint)
2. Typecheck (tsc --noEmit, cargo check, go vet, mypy)
3. Tests (full test suite)
4. Coverage (report percentage)

For each gate: run it, if it fails read the output, fix the code, retry (max 2 retries per gate).
Report final status of all gates.`,

  review: `You are reviewing code changes for quality, security, and correctness.

Review dimensions:
1. Security — injection, auth gaps, secrets
2. Correctness — edge cases, error handling, race conditions
3. Performance — N+1 queries, unnecessary allocations
4. Testing — coverage of new code, edge cases

Categorize findings as:
- NEEDS_NEW_TESTS: behavioral gap requiring new tests
- MECHANICAL_FIX: code quality issue fixable without new tests

Output structured JSON with verdict (pass/needs_fixes) and findings.`,

  ship: `You are preparing to ship changes.

1. Stage all modified files (git add)
2. Create a conventional commit message
3. Push the branch

Do NOT merge. Do NOT create the PR (the orchestrator handles that).`,

  brainstorm: `You are analyzing a codebase to identify improvements.

Read key files (README, config, entry points, core modules, tests).
Identify bugs, security issues, performance problems, tech debt, and enhancements.

For each issue provide:
- Clear title (imperative mood)
- Description with file paths and context
- Labels, priority (critical/high/medium/low), and category

Output structured JSON matching the provided schema.`,
};

/**
 * Load the default (built-in) prompt for a wave.
 * Reads from the prompts/ directory, falls back to embedded strings.
 */
async function loadDefaultPrompt(wave: string): Promise<string> {
  const filePath = path.join(PROMPTS_DIR, `${wave}.md`);
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    const fallback = FALLBACK_PROMPTS[wave];
    if (fallback) {
      return fallback;
    }
    throw new Error(`No prompt found for wave: ${wave}`);
  }
}

/** Default waves that receive the skills XML block when skills are configured but
 *  the user has not specified `enabled_waves`. Mirrors the default in
 *  `SkillsConfigSchema` — kept in sync via the matching `enabled_waves` default
 *  in `src/types/config.ts`. The two lists are intentionally duplicated rather
 *  than imported: the schema default is the source of truth for *user config*,
 *  and this constant is the source of truth for *direct loadPrompt callers*
 *  (tests, future-runtime code) that don't go through the config schema. */
export const DEFAULT_SKILL_ENABLED_WAVES: readonly SkillWaveName[] = [
  'assess',
  'spec',
  'impl',
  'quality',
  'review',
  'brainstorm',
];

/** Skills injection option for loadPrompt (issue #298). */
export interface PromptSkillsOption {
  /** Skills discovered via {@link loadWaveSkills} (or any other source). */
  skills: readonly Skill[];
  /** Waves whose system prompt receives the skills block. Defaults to
   *  {@link DEFAULT_SKILL_ENABLED_WAVES} when omitted. */
  enabledWaves?: readonly SkillWaveName[];
}

export interface LoadPromptOptions {
  /** A/B test variant name for this wave. When set, loads {wave}.{variant}.md from promptsDir. */
  abTestVariant?: string | undefined;
  /** Skills to inject into the system prompt (issue #298). When undefined or
   *  the skill list is empty, the prompt is returned unchanged. */
  skills?: PromptSkillsOption | undefined;
}

export async function loadPrompt(
  wave: string,
  customTools?: readonly CustomTool[],
  projectContextOrPromptsDir?: ProjectContext | string,
  promptsDirOrProjectContext?: string | ProjectContext,
  options?: LoadPromptOptions,
): Promise<string> {
  // Resolve overloaded arguments: callers may pass (ProjectContext, promptsDir) or (promptsDir, ProjectContext)
  let projectContext: ProjectContext | undefined;
  let promptsDir: string | undefined;
  for (const arg of [projectContextOrPromptsDir, promptsDirOrProjectContext]) {
    if (arg == null) continue;
    if (typeof arg === 'string') {
      promptsDir = arg;
    } else {
      projectContext = arg;
    }
  }

  let prompt: string;

  if (promptsDir && options?.abTestVariant) {
    // A/B test variant: load {wave}.{variant}.md from promptsDir
    const variantFile = `${wave}.${options.abTestVariant}.md`;
    const variantPath = path.join(promptsDir, variantFile);
    try {
      const variantContent = await fs.readFile(variantPath, 'utf-8');
      if (variantContent.includes(DEFAULT_PROMPT_PLACEHOLDER)) {
        const defaultPrompt = await loadDefaultPrompt(wave);
        prompt = variantContent.replaceAll(DEFAULT_PROMPT_PLACEHOLDER, defaultPrompt);
      } else {
        prompt = variantContent;
      }
    } catch {
      // Variant file doesn't exist — fall back to standard custom/default loading
      prompt = await loadCustomOrDefault(wave, promptsDir);
    }
  } else if (promptsDir) {
    prompt = await loadCustomOrDefault(wave, promptsDir);
  } else {
    prompt = await loadDefaultPrompt(wave);
  }

  // Template variable substitution — replace {{VAR}} with project context values
  prompt = substituteTemplateVars(prompt, projectContext);

  // Append custom tools section for impl/quality waves
  if (customTools && customTools.length > 0 && (wave === 'impl' || wave === 'quality')) {
    prompt += `\n\n${buildCustomToolsSection(customTools)}`;
  }

  // Append skills block when configured for this wave (issue #298). Gated so
  // pure-mechanical waves (test by default, ship always) don't get the noise.
  prompt = appendSkillsSection(prompt, wave, options?.skills);

  return prompt;
}

/** Append the formatted skills block to a wave's system prompt when the wave is
 *  in `enabledWaves` and there are visible (non-model-disabled) skills.
 *  Returns the original prompt unchanged when no skills should be injected —
 *  this is the load-bearing fallback behavior the acceptance criteria require. */
function appendSkillsSection(prompt: string, wave: string, opt: PromptSkillsOption | undefined): string {
  if (!opt || opt.skills.length === 0) return prompt;
  const enabled = opt.enabledWaves ?? DEFAULT_SKILL_ENABLED_WAVES;
  if (!enabled.includes(wave as SkillWaveName)) return prompt;
  const section = formatSkillsForPrompt([...opt.skills]);
  // formatSkillsForPrompt returns '' when every skill has disableModelInvocation=true,
  // matching the same "empty → no-op" contract.
  if (!section) return prompt;
  // formatSkillsForPrompt already prepends "\n\n", so just concatenate.
  return prompt + section;
}

/** Load a custom prompt from promptsDir, falling back to built-in default. */
async function loadCustomOrDefault(wave: string, promptsDir: string): Promise<string> {
  const customPath = path.join(promptsDir, `${wave}.md`);
  try {
    const customContent = await fs.readFile(customPath, 'utf-8');
    if (customContent.includes(DEFAULT_PROMPT_PLACEHOLDER)) {
      const defaultPrompt = await loadDefaultPrompt(wave);
      return customContent.replaceAll(DEFAULT_PROMPT_PLACEHOLDER, defaultPrompt);
    }
    return customContent;
  } catch {
    // Custom file doesn't exist for this wave — fall back to default
    return loadDefaultPrompt(wave);
  }
}

const TEMPLATE_VARS: Record<string, keyof ProjectContext> = {
  '{{CLAUDE_MD}}': 'claudeMd',
  '{{STYLE_CONFIG}}': 'styleConfig',
  '{{CI_CONFIG}}': 'ciConfig',
};

function substituteTemplateVars(prompt: string, context?: ProjectContext): string {
  let result = prompt;
  for (const [placeholder, key] of Object.entries(TEMPLATE_VARS)) {
    const value = context?.[key] ?? '';
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

/**
 * Build a prompt section describing custom tools available to the agent.
 * Each tool is listed with its name, description, and the command it runs.
 */
export function buildCustomToolsSection(tools: readonly CustomTool[]): string {
  const toolEntries = tools.map((t) => `- **${t.name}**: ${t.description}\n  Command: \`${t.command}\``).join('\n');

  return [
    '## Custom Tools',
    '',
    'The following repo-specific tools are available. Call them by name when needed:',
    '',
    toolEntries,
    '',
    'These tools run as shell commands in the working directory. Use them when their purpose matches what you need to do.',
  ].join('\n');
}

/**
 * Resolve a prompts_dir config value to an absolute path.
 * Relative paths are resolved against the repo root.
 */
export function resolvePromptsDir(repoPath: string, promptsDir: string | undefined): string | undefined {
  if (!promptsDir) return undefined;
  if (path.isAbsolute(promptsDir)) return promptsDir;
  return path.join(repoPath, promptsDir);
}

/** Returns the path to the built-in default prompts directory. */
export function getDefaultPromptsDir(): string {
  return PROMPTS_DIR;
}

export interface ExportPromptsResult {
  exported: string[];
  skipped: string[];
}

/**
 * Export all built-in prompt files to a target directory.
 * By default, existing files are skipped; pass force=true to overwrite.
 */
export async function exportPrompts(outputDir: string, force?: boolean): Promise<ExportPromptsResult> {
  await fs.mkdir(outputDir, { recursive: true });

  const entries = await fs.readdir(PROMPTS_DIR);
  const mdFiles = entries.filter((f: string) => f.endsWith('.md'));

  const exported: string[] = [];
  const skipped: string[] = [];

  for (const file of mdFiles) {
    const dest = path.join(outputDir, file);

    if (!force) {
      try {
        await fs.access(dest);
        // File exists and force is not set — skip
        skipped.push(file);
        continue;
      } catch {
        // File doesn't exist — proceed with copy
      }
    }

    let content = await fs.readFile(path.join(PROMPTS_DIR, file), 'utf-8');
    // Strip template variables so exported files match loadPrompt() output
    content = substituteTemplateVars(content);
    await fs.writeFile(dest, content);
    exported.push(file);
  }

  return { exported, skipped };
}
