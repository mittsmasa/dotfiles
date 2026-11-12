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
  /**
   * Only for `mock`: true when a factory is passed (`vi.mock('x', () => ...)`).
   * Without one, Vitest automocks every export, which cuts the real module off
   * just like a factory does.
   */
  factory?: boolean;
  /**
   * Only for `mock`: true when the factory takes the real module back, by
   * calling its first parameter (`importOriginal`) or `vi.importActual`. Only
   * the overridden exports are replaced, so the real module still runs.
   */
  partial?: boolean;
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
  /** Directive prologue of the file, such as `use client` or `use server`. */
  directives: string[];
  /** Names read from `process.env` (`process.env.X`, `process.env['X']`, destructuring), sorted. */
  envReads: string[];
  /**
   * Test files only: string literals of 10 characters or more (after trimming)
   * inside the arguments of a matcher (`expect(...).toXxx(...)`), sorted.
   */
  matcherLiterals: string[];
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
  /**
   * Only for `internal`: the file the specifier resolves to, before following
   * re-exports. Differs from `target` when the import goes through a barrel.
   * A mock replaces this file, so it is what a mock is compared with.
   */
  module?: string;
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

/**
 * How a C1 candidate is reached.
 * - `story`: a story reaches it (decided first)
 * - `test`: a test reaches it without passing a module the test mocks
 * - `test-mocked`: tests reach it only through a mocked module, so the real
 *   code never runs. `mockedAt` lists the mocked modules on the way; `self` is
 *   true when the candidate itself is mocked (also through a mocked barrel
 *   that re-exports it)
 * - `none`: neither reaches it
 */
export type C1Candidate =
  | { file: string; reach: 'story' | 'test' | 'none' }
  | { file: string; reach: 'test-mocked'; mockedAt: string[]; self: boolean };

export interface C4Candidate {
  file: string;
  /** A story file next to the component, named after it, that does not render it. */
  siblingStory?: string;
  /** Names imported from a `use server` file. Such a component cannot be rendered in a story as is. */
  serverActions?: string[];
}

export interface Candidates {
  /** Pure-logic modules that no test file imports directly. */
  c1: C1Candidate[];
  /** Components imported directly by a test and by a story that has `play`. */
  c2: { file: string; testFiles: string[]; storyFiles: string[] }[];
  /**
   * Internal modules that are mocked, with the test files that mock them.
   * `touches` lists what the module (and the files a mocked barrel re-exports)
   * touches directly: I/O builtins such as `fs`, and `process.env.X`.
   * `partial` lists the test files whose mock keeps the real module.
   */
  c3: { target: string; testFiles: string[]; touches: string[]; partial: string[] }[];
  /** Components that no story reaches. */
  c4: C4Candidate[];
  /**
   * Pairs of test files where `direct` imports a module (`subjects`) that
   * `indirect` reaches without mocking it, and both pass the same string
   * literals (2 or more) to matchers. A hint, not a candidate list.
   */
  c5: { direct: string; indirect: string; subjects: string[]; literals: string[] }[];
  /** Groups of 2 or more source files that read the same environment variables. */
  c6: { env: string[]; files: string[] }[];
  /**
   * Import cycles among source files: strongly connected components of 2 or
   * more files, or a file importing itself. Edges are imports that run at load
   * time (`import`, `reexport`; not type-only, `import()` or mocks) and point
   * at `module`, so a cycle through a barrel is kept. `edges` lists the
   * imports inside the component.
   */
  c7: { files: string[]; edges: [string, string][] }[];
  /**
   * Imports against an inferred layer order (`rule`: `layer <lower> -> <higher>`)
   * or between different units of an `--isolate` glob (`rule`: `isolate <glob>`).
   */
  c8: { file: string; target: string; rule: string }[];
}
