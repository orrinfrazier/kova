// Build kova CLI arguments from GitHub Action inputs.

const VALID_MODES = ['fix', 'auto', 'brainstorm'] as const;
type Mode = (typeof VALID_MODES)[number];

export interface ActionInputs {
  mode: Mode;
  issue_number?: string;
  all?: boolean;
  filter?: string;
  max_issues?: string;
  config?: string;
  budget?: string;
  force?: boolean;
  focus?: string;
}

export function validateInputs(inputs: ActionInputs): void {
  if (!VALID_MODES.includes(inputs.mode)) {
    throw new Error(`Invalid mode: "${inputs.mode}". Must be one of: ${VALID_MODES.join(', ')}`);
  }

  if (inputs.mode === 'fix' && !inputs.issue_number && !inputs.all) {
    throw new Error('issue_number is required for fix mode (or set all: true)');
  }
}

export function buildKovaArgs(inputs: ActionInputs): string[] {
  const globalArgs: string[] = [];
  const args: string[] = [];

  // Global options (before subcommand)
  if (inputs.config) {
    globalArgs.push('--config', inputs.config);
  }

  switch (inputs.mode) {
    case 'fix': {
      args.push('fix');
      if (inputs.all) {
        args.push('--all');
      } else if (inputs.issue_number) {
        args.splice(1, 0, inputs.issue_number);
      }
      if (inputs.filter) args.push('--filter', inputs.filter);
      if (inputs.max_issues) args.push('--max', inputs.max_issues);
      if (inputs.budget) args.push('--budget', inputs.budget);
      if (inputs.force) args.push('--force');
      break;
    }
    case 'auto': {
      args.push('auto');
      if (inputs.filter) args.push('--filter', inputs.filter);
      if (inputs.max_issues) args.push('--max', inputs.max_issues);
      if (inputs.force) args.push('--force');
      break;
    }
    case 'brainstorm': {
      args.push('brainstorm', '--yes');
      if (inputs.focus) args.push('--focus', inputs.focus);
      break;
    }
  }

  return [...globalArgs, ...args];
}
