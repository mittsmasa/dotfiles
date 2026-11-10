/**
 * Intermediate representation shared by the facts rule (extraction), the
 * graph (resolution) and the checks.
 */

/** Decided from the file name: `*.test.*` / `*.spec.*`, `*.stories.*`, other. */
export type FileKind = 'test' | 'story' | 'source';

/**
 * How a module specifier appears in a file.
 * - `import`: `import ... from 'x'`
 * - `reexport`: `export ... from 'x'`
 * - `dynamic`: `import('x')` with a string literal
 * - `mock`: `vi.mock('x')` / `vi.doMock('x')`
 */
export type ImportVia = 'import' | 'reexport' | 'dynamic' | 'mock';

export type ExportKind = 'function' | 'type' | 'value';

export interface RawImport {
  source: string;
  /**
   * Names taken from the target module: an exported name, `default`, or `*`
   * (namespace import, `export *`, dynamic import). Empty for a side-effect
   * import and for a mock.
   */
  names: string[];
  typeOnly: boolean;
  via: ImportVia;
  /** Only for `reexport` of a single name: the name it is exported under. */
  exportedAs?: string;
}

export interface ExportFact {
  /** Exported name; `default` for a default export. Re-exports are not listed. */
  name: string;
  kind: ExportKind;
}

/** What the facts rule reports for one file (the file path comes from the diagnostic). */
export interface FileFacts {
  kind: FileKind;
  imports: RawImport[];
  exports: ExportFact[];
  jsx: boolean;
  /** True when the file has a value import from `react` or `react-dom`. */
  importsReact: boolean;
  /** Number of `useXxx(...)` calls. Checks only ask whether it is zero. */
  hookCalls: number;
  /** Number of `play` functions in a story file. */
  plays: number;
}

/**
 * - `internal`: a code file of the project
 * - `generated`: a path inside a generated directory whose file is not on disk
 *   (codegen has not run in this checkout)
 * - `external`: a Node builtin or a package declared in a package.json
 * - `asset`: a non-code file
 * - `unresolved`: none of the above; a missed resolution or a broken import
 */
export type ImportResolution =
  | 'internal'
  | 'generated'
  | 'external'
  | 'asset'
  | 'unresolved';

/** An import after resolution. A named import is split so that it has one name. */
export interface ResolvedImport extends RawImport {
  /** Root-relative path of the file that defines the name, or null. */
  target: string | null;
  resolution: ImportResolution;
}

export interface FileRecord extends Omit<FileFacts, 'imports'> {
  /** Root-relative path with `/` separators. */
  file: string;
  imports: ResolvedImport[];
}

export interface Ir {
  files: FileRecord[];
  stats: {
    parseFailures: number;
    imports: Record<ImportResolution, number>;
  };
}

export interface Candidates {
  /** Pure-logic modules that no test file imports directly. */
  c1: { file: string; reach: 'story' | 'test' | 'none' }[];
  /** Components imported directly by a test and by a story that has `play`. */
  c2: { file: string; testFiles: string[]; storyFiles: string[] }[];
  /** Internal modules that are mocked, with the test files that mock them. */
  c3: { target: string; testFiles: string[] }[];
  /** Components that no story reaches. */
  c4: { file: string }[];
}
