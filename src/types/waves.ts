import { z } from 'zod';

// Structured output schemas for each wave — Zod → JSON Schema draft-07 for Agent SDK

export const AssessResultSchema = z.object({
  grade: z.enum(['A', 'B', 'C', 'D', 'F']),
  surface_area: z.object({
    files: z.array(z.string()),
    estimated_lines: z.number(),
    modules_affected: z.array(z.string()),
  }),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  reasoning: z.string(),
  should_proceed: z.boolean(),
});
export type AssessResult = z.infer<typeof AssessResultSchema>;

export const SpecPieceSchema = z.object({
  name: z.string(),
  description: z.string(),
  files: z.array(z.string()),
  acceptance_criteria: z.array(z.string()),
  wiring: z.array(z.string()),
});

export type SpecPiece = z.infer<typeof SpecPieceSchema>;

export const SpecResultSchema = z.object({
  summary: z.string(),
  pieces: z.array(SpecPieceSchema),
  dependency_order: z.array(z.array(z.number())),
  constraints: z.array(z.string()),
});
export type SpecResult = z.infer<typeof SpecResultSchema>;

export const TestResultSchema = z.object({
  test_files_created: z.array(z.string()),
  test_count: z.number(),
  all_failing: z.boolean(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const DiagnosisCategorySchema = z.enum(['SPEC_WRONG', 'APPROACH_WRONG', 'MISSING_CONTEXT', 'STUCK']);
export type DiagnosisCategory = z.infer<typeof DiagnosisCategorySchema>;

export const ImplDiagnosisSchema = z.object({
  category: DiagnosisCategorySchema,
  tests_still_failing: z.array(z.string()),
  approaches_tried: z.array(z.string()),
  failure_pattern: z.enum(['COMPILATION', 'WRONG_OUTPUT', 'TEST_MISMATCH', 'MISSING_DEP']),
  theory: z.string(),
});
export type ImplDiagnosis = z.infer<typeof ImplDiagnosisSchema>;

export const ImplResultSchema = z.object({
  files_modified: z.array(z.string()),
  files_created: z.array(z.string()),
  tests_passing: z.boolean(),
  approach_notes: z.string(),
  diagnosis: ImplDiagnosisSchema.optional(),
});
export type ImplResult = z.infer<typeof ImplResultSchema>;

export const QualityResultSchema = z.object({
  lint: z.enum(['pass', 'fail', 'skip']),
  typecheck: z.enum(['pass', 'fail', 'skip']),
  tests: z.enum(['pass', 'fail', 'skip']),
  coverage: z.number().optional(),
  audit: z.enum(['pass', 'fail', 'skip']),
  all_passing: z.boolean(),
});
export type QualityResult = z.infer<typeof QualityResultSchema>;

export const ReviewFindingSchema = z.object({
  category: z.enum(['needs_new_tests', 'mechanical_fix']),
  file: z.string(),
  line: z.number().optional(),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  test_code: z.string().optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewResultSchema = z.object({
  verdict: z.enum(['pass', 'needs_fixes']),
  findings: z.array(ReviewFindingSchema),
  summary: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResultSchema>;

export const BrainstormIssueSchema = z.object({
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  priority: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.enum(['bug', 'security', 'performance', 'tech-debt', 'enhancement']),
  confidence: z.number().min(0).max(1),
  dependencies: z.array(z.string()).optional(),
});
export type BrainstormIssue = z.infer<typeof BrainstormIssueSchema>;

export const BrainstormResultSchema = z.object({
  issues: z.array(BrainstormIssueSchema),
  summary: z.string(),
});
export type BrainstormResult = z.infer<typeof BrainstormResultSchema>;
