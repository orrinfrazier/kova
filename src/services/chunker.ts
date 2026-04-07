// Chunking utilities — splits source text into overlapping or boundary-aligned chunks.

export interface Chunk {
  text: string;
  startLine: number;
  endLine: number;
}

const DEFAULT_MAX_CHARS = 2000;
const DEFAULT_OVERLAP = 200;

/**
 * Count the number of newlines before a character offset in a string,
 * returning the 1-based line number.
 */
function lineAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source[i] === '\n') line++;
  }
  return line;
}

/**
 * Splits source into fixed-size chunks with optional overlap.
 * Defaults: maxChars=2000, overlap=200.
 * Returns empty array for empty/whitespace-only input.
 */
export function chunkFixedSize(source: string, maxChars = DEFAULT_MAX_CHARS, overlap = DEFAULT_OVERLAP): Chunk[] {
  if (source.trim().length === 0) return [];

  const chunks: Chunk[] = [];
  const step = maxChars - overlap;
  let start = 0;

  while (start < source.length) {
    const end = Math.min(start + maxChars, source.length);
    const text = source.slice(start, end);
    const startLine = lineAtOffset(source, start);
    const endLine = lineAtOffset(source, end - 1);
    chunks.push({ text, startLine, endLine });
    if (end === source.length) break;
    start += step;
  }

  return chunks;
}

/**
 * Find all boundary line indices (0-based) in the source for a given language.
 */
function findBoundaryLines(lines: string[], language: string): number[] {
  const langPatterns: Record<string, RegExp[]> = {
    typescript: [/^(?:export\s+)?(?:function|class)\s+\w+/, /^(?:(?:export|default)\s+)*(?:async\s+)?function\s+\w+/],
    javascript: [/^(?:export\s+)?(?:function|class)\s+\w+/, /^(?:(?:export|default)\s+)*(?:async\s+)?function\s+\w+/],
    rust: [/^(?:pub\s+)?(?:fn|impl|struct|enum|trait)\s+\w+/],
    python: [/^(?:def|class)\s+\w+/],
    go: [/^func\s+\w+/],
  };

  const pats = langPatterns[language];
  if (!pats) return [];

  const boundaries: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (pats.some((p) => p.test(line))) {
      boundaries.push(i);
    }
  }
  return boundaries;
}

/**
 * Splits source text into chunks at language-specific boundaries (functions, classes, etc.).
 * Falls back to fixed-size chunking for unknown languages or if no boundaries are found.
 * Returns empty array for empty/whitespace-only input.
 */
export function chunkByBoundary(source: string, language: string): Chunk[] {
  if (source.trim().length === 0) return [];

  const lines = source.split('\n');
  const boundaries = findBoundaryLines(lines, language);

  // Fall back to fixed-size for unknown languages or no detected boundaries
  if (boundaries.length === 0) {
    return chunkFixedSize(source);
  }

  const chunks: Chunk[] = [];

  for (let i = 0; i < boundaries.length; i++) {
    const boundaryLine = boundaries[i] ?? 0;
    const nextBoundaryLine = boundaries[i + 1] ?? lines.length;

    // Include a small context window before the boundary (up to 2 lines)
    const contextStart = Math.max(0, i === 0 ? 0 : boundaryLine);
    const chunkLines = lines.slice(contextStart, nextBoundaryLine);

    // Remove trailing empty lines
    while (chunkLines.length > 0 && (chunkLines[chunkLines.length - 1]?.trim() ?? '') === '') {
      chunkLines.pop();
    }

    if (chunkLines.length === 0) continue;

    const text = chunkLines.join('\n');
    const startLine = contextStart + 1; // 1-based
    const endLine = contextStart + chunkLines.length; // 1-based

    chunks.push({ text, startLine, endLine });
  }

  return chunks;
}

/** Maps file extensions to language names. */
const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.rs': 'rust',
  '.py': 'python',
  '.go': 'go',
};

/**
 * Chunks a file's source text, selecting the strategy based on file extension.
 * Known code extensions → boundary chunking; unknown → fixed-size.
 * Returns empty array for empty/whitespace-only input.
 */
export function chunkFile(source: string, filePath: string): Chunk[] {
  if (source.trim().length === 0) return [];

  const dotIndex = filePath.lastIndexOf('.');
  const ext = dotIndex !== -1 ? filePath.slice(dotIndex) : '';
  const language = EXT_TO_LANGUAGE[ext];

  if (language) {
    return chunkByBoundary(source, language);
  }

  return chunkFixedSize(source);
}
