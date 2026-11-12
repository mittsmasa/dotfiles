import { type DependencyOptions, dependencyChecks } from './dependencies.ts';
import type { Graph } from './graph.ts';
import type { C1Candidate, C4Candidate, Candidates, FileRecord, Ir } from './ir.ts';

/** Next.js route files. A story is not expected to reach these. */
const ROUTE_FILE =
  /(^|\/)(page|layout|error|loading|not-found|template|default|global-error)\.[jt]sx?$/;

/** Node builtins whose import means the module does I/O by itself. */
const IO_BUILTINS = new Set(['fs', 'child_process', 'net', 'http', 'https']);

/** Environment variables that switch the whole framework, not one dependency. */
const DEFAULT_ENV_IGNORE = ['NODE_ENV'];

/** C5 lists a pair of tests only when they share at least this many literals. */
const MIN_SHARED_LITERALS = 2;

export interface CheckOptions extends DependencyOptions {
  /** Environment variables left out of C3 `touches` and C6, besides `NODE_ENV`. */
  envIgnore?: readonly string[];
}

function exportsFunction(record: FileRecord, name: RegExp): boolean {
  return record.exports.some(
    (fact) => fact.kind === 'function' && name.test(fact.name),
  );
}

/** A source file with JSX that exports a capitalized or default function. */
export function isComponent(record: FileRecord): boolean {
  return (
    record.kind === 'source' &&
    record.jsx &&
    exportsFunction(record, /^([A-Z]|default$)/)
  );
}

/** A source file that exports a function and touches neither React nor JSX. */
export function isPureLogic(record: FileRecord): boolean {
  return (
    record.kind === 'source' &&
    !record.jsx &&
    !record.importsReact &&
    record.hookCalls === 0 &&
    exportsFunction(record, /./)
  );
}

/** A value import of an internal file, narrowed to the file that defines the name. */
function valueImports(record: FileRecord): { target: string; module: string; name: string }[] {
  return record.imports.flatMap((entry) =>
    entry.via === 'import' &&
    !entry.typeOnly &&
    entry.resolution === 'internal' &&
    entry.target !== null
      ? entry.names.map((name) => ({
          target: entry.target!,
          module: entry.module ?? entry.target!,
          name,
        }))
      : [],
  );
}

/** Internal modules a test file mocks; with `realOnly`, partial mocks are left out. */
function mockedModules(record: FileRecord, realOnly: boolean): Set<string> {
  const mocked = new Set<string>();
  for (const entry of record.imports) {
    if (entry.via !== 'mock' || entry.resolution !== 'internal' || entry.target === null) {
      continue;
    }
    if (realOnly && entry.partial) continue;
    mocked.add(entry.target);
  }
  return mocked;
}

function memoize<T>(compute: (key: string) => T): (key: string) => T {
  const cache = new Map<string, T>();
  return (key) => {
    if (!cache.has(key)) cache.set(key, compute(key));
    return cache.get(key)!;
  };
}

const storyStem = (file: string): string => file.replace(/\.stories\.[cm]?[jt]sx?$/, '');
const sourceStem = (file: string): string => file.replace(/\.[cm]?[jt]sx?$/, '');

/**
 * Produces the candidates of checks C1 to C8.
 *
 * These are candidates, not verdicts: an import shows that a test or story
 * touches a module, not which behavior it verifies.
 */
export function runChecks(ir: Ir, graph: Graph, options: CheckOptions = {}): Candidates {
  const envIgnore = new Set([...DEFAULT_ENV_IGNORE, ...(options.envIgnore ?? [])]);
  const byFile = new Map(ir.files.map((record) => [record.file, record]));
  const kinds = new Map(ir.files.map((record) => [record.file, record.kind]));
  const plays = new Map(ir.files.map((record) => [record.file, record.plays]));
  const filesOf = (kind: FileRecord['kind']): string[] =>
    ir.files.filter((record) => record.kind === kind).map((record) => record.file);
  const tests = filesOf('test');
  const fromStories = graph.reachableFrom(filesOf('story'));
  const fromTests = graph.reachableFrom(tests);

  // Per test: what it mocks (keeping the real module for partial mocks) and
  // what runs for real.
  const realMocks = new Map(
    tests.map((test) => [test, mockedModules(byFile.get(test)!, true)]),
  );
  const realReach = new Map(
    tests.map((test) => [test, graph.reachableFrom([test], realMocks.get(test))]),
  );
  const fromTestsForReal = new Set([...realReach.values()].flatMap((files) => [...files]));
  const modulesFrom = memoize((file) => graph.modulesReachableFrom([file]));

  /** Mocked modules that lie between some test and `file`. */
  function mocksOnTheWay(file: string): string[] {
    const found = new Set<string>();
    for (const test of tests) {
      const mocked = realMocks.get(test)!;
      if (mocked.size === 0) continue;
      const forward = modulesFrom(test);
      if (!forward.has(file)) continue;
      for (const module of mocked) {
        if (forward.has(module) && modulesFrom(module).has(file)) found.add(module);
      }
    }
    return [...found].sort();
  }

  function reachOf(file: string): C1Candidate {
    if (fromStories.has(file)) return { file, reach: 'story' };
    if (fromTestsForReal.has(file)) return { file, reach: 'test' };
    if (!fromTests.has(file)) return { file, reach: 'none' };
    const mockedAt = mocksOnTheWay(file);
    const self = mockedAt.some((module) => graph.reexportClosure(module).has(file));
    return { file, reach: 'test-mocked', mockedAt, self };
  }

  const serverFiles = new Set(
    ir.files
      .filter((record) => record.directives.includes('use server'))
      .map((record) => record.file),
  );
  const storiesByStem = new Map(
    filesOf('story').map((story) => [storyStem(story), story]),
  );

  const c1: Candidates['c1'] = [];
  const c2: Candidates['c2'] = [];
  const c4: Candidates['c4'] = [];

  for (const record of ir.files) {
    const { file } = record;
    const importers = graph.importersOf(file);
    const testFiles = importers.filter((importer) => kinds.get(importer) === 'test');

    if (isPureLogic(record) && testFiles.length === 0) {
      c1.push(reachOf(file));
    }
    if (isComponent(record)) {
      const storyFiles = importers.filter(
        (importer) => kinds.get(importer) === 'story' && (plays.get(importer) ?? 0) > 0,
      );
      if (testFiles.length > 0 && storyFiles.length > 0) {
        c2.push({ file, testFiles, storyFiles });
      }
      if (!fromStories.has(file) && !ROUTE_FILE.test(file)) {
        const candidate: C4Candidate = { file };
        const siblingStory = storiesByStem.get(sourceStem(file));
        if (siblingStory !== undefined) candidate.siblingStory = siblingStory;
        const serverActions = [
          ...new Set(
            valueImports(record)
              .filter(({ target, module }) => serverFiles.has(target) || serverFiles.has(module))
              .map(({ name }) => name),
          ),
        ].sort();
        if (serverActions.length > 0) candidate.serverActions = serverActions;
        c4.push(candidate);
      }
    }
  }

  /** What the files behind `module` touch directly: I/O builtins and env reads. */
  function touchesOf(module: string): string[] {
    const touches = new Set<string>();
    for (const file of graph.reexportClosure(module)) {
      const record = byFile.get(file);
      if (!record) continue;
      for (const entry of record.imports) {
        if (entry.resolution !== 'external' || entry.typeOnly || entry.via === 'mock') continue;
        const builtin = entry.source.replace(/^node:/, '').split('/')[0];
        if (IO_BUILTINS.has(builtin)) touches.add(builtin);
      }
      for (const name of record.envReads) {
        if (!envIgnore.has(name)) touches.add(`process.env.${name}`);
      }
    }
    return [...touches].sort();
  }

  const mockers = new Map<string, Set<string>>();
  const partialMockers = new Map<string, Set<string>>();
  for (const { file, imports } of ir.files) {
    for (const record of imports) {
      if (record.via !== 'mock' || record.resolution !== 'internal') continue;
      if (record.target === null) continue;
      if (!mockers.has(record.target)) mockers.set(record.target, new Set());
      mockers.get(record.target)!.add(file);
      if (record.partial) {
        if (!partialMockers.has(record.target)) partialMockers.set(record.target, new Set());
        partialMockers.get(record.target)!.add(file);
      }
    }
  }
  const c3 = [...mockers]
    .map(([target, files]) => ({
      target,
      testFiles: [...files].sort(),
      touches: touchesOf(target),
      partial: [...(partialMockers.get(target) ?? [])].sort(),
    }))
    .sort(
      (a, b) =>
        b.testFiles.length - a.testFiles.length || a.target.localeCompare(b.target),
    );

  return {
    c1,
    c2,
    c3,
    c4,
    c5: sharedExpectations(),
    c6: sharedEnvironment(),
    ...dependencyChecks(ir, options),
  };

  /**
   * C5: test `direct` imports a module that test `indirect` reaches for real
   * without importing it, and both pass the same literals to matchers.
   */
  function sharedExpectations(): Candidates['c5'] {
    const direct = new Map(
      tests.map((test) => [
        test,
        new Set(valueImports(byFile.get(test)!).map(({ target }) => target)),
      ]),
    );
    const literals = new Map(
      tests.map((test) => [test, new Set(byFile.get(test)!.matcherLiterals)]),
    );
    const pairs = new Map<string, Candidates['c5'][number]>();
    for (const a of tests) {
      for (const b of tests) {
        if (a === b) continue;
        const key = [a, b].sort().join('\0');
        if (pairs.has(key)) continue;
        const subjects = [...direct.get(a)!].filter(
          (module) => realReach.get(b)!.has(module) && !direct.get(b)!.has(module),
        );
        if (subjects.length === 0) continue;
        const shared = [...literals.get(a)!].filter((text) => literals.get(b)!.has(text));
        if (shared.length < MIN_SHARED_LITERALS) continue;
        pairs.set(key, {
          direct: a,
          indirect: b,
          subjects: subjects.sort(),
          literals: shared.sort(),
        });
      }
    }
    return [...pairs.values()].sort(
      (x, y) => x.direct.localeCompare(y.direct) || x.indirect.localeCompare(y.indirect),
    );
  }

  /** C6: source files grouped by the environment variables they all read. */
  function sharedEnvironment(): Candidates['c6'] {
    const readers = new Map<string, string[]>();
    for (const record of ir.files) {
      if (record.kind !== 'source') continue;
      for (const name of record.envReads) {
        if (envIgnore.has(name)) continue;
        if (!readers.has(name)) readers.set(name, []);
        readers.get(name)!.push(record.file);
      }
    }
    return groupByFiles(
      [...readers].map(([name, files]) => ({ env: [name], files: files.sort() })),
    );
  }
}

/**
 * Merges groups that have the same files and keeps those with 2 or more files.
 * Shared with candidate exclusion, which removes files from groups.
 */
export function groupByFiles(groups: Candidates['c6']): Candidates['c6'] {
  const merged = new Map<string, Candidates['c6'][number]>();
  for (const { env, files } of groups) {
    if (files.length < 2) continue;
    const key = files.join('\0');
    const group = merged.get(key) ?? { env: [], files };
    group.env = [...new Set([...group.env, ...env])].sort();
    merged.set(key, group);
  }
  return [...merged.values()].sort(
    (a, b) => b.files.length - a.files.length || a.files[0].localeCompare(b.files[0]),
  );
}
