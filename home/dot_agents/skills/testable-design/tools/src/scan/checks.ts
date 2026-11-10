import type { Graph } from './graph.ts';
import type { Candidates, FileRecord, Ir } from './ir.ts';

/** Next.js route files. A story is not expected to reach these. */
const ROUTE_FILE =
  /(^|\/)(page|layout|error|loading|not-found|template|default|global-error)\.[jt]sx?$/;

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

/**
 * Produces the candidates of checks C1 to C4.
 *
 * C1, C2 and C4 are candidates, not verdicts: an import shows that a test or
 * story touches a module, not which behavior it verifies.
 */
export function runChecks(ir: Ir, graph: Graph): Candidates {
  const kinds = new Map(ir.files.map((record) => [record.file, record.kind]));
  const plays = new Map(ir.files.map((record) => [record.file, record.plays]));
  const filesOf = (kind: FileRecord['kind']): string[] =>
    ir.files.filter((record) => record.kind === kind).map((record) => record.file);
  const fromStories = graph.reachableFrom(filesOf('story'));
  const fromTests = graph.reachableFrom(filesOf('test'));

  const c1: Candidates['c1'] = [];
  const c2: Candidates['c2'] = [];
  const c4: Candidates['c4'] = [];

  for (const record of ir.files) {
    const { file } = record;
    const importers = graph.importersOf(file);
    const testFiles = importers.filter((importer) => kinds.get(importer) === 'test');

    if (isPureLogic(record) && testFiles.length === 0) {
      c1.push({
        file,
        reach: fromStories.has(file) ? 'story' : fromTests.has(file) ? 'test' : 'none',
      });
    }
    if (isComponent(record)) {
      const storyFiles = importers.filter(
        (importer) => kinds.get(importer) === 'story' && (plays.get(importer) ?? 0) > 0,
      );
      if (testFiles.length > 0 && storyFiles.length > 0) {
        c2.push({ file, testFiles, storyFiles });
      }
      if (!fromStories.has(file) && !ROUTE_FILE.test(file)) {
        c4.push({ file });
      }
    }
  }

  const mockers = new Map<string, Set<string>>();
  for (const { file, imports } of ir.files) {
    for (const record of imports) {
      if (record.via !== 'mock' || record.resolution !== 'internal') continue;
      if (record.target === null) continue;
      if (!mockers.has(record.target)) mockers.set(record.target, new Set());
      mockers.get(record.target)!.add(file);
    }
  }
  const c3 = [...mockers]
    .map(([target, files]) => ({ target, testFiles: [...files].sort() }))
    .sort(
      (a, b) =>
        b.testFiles.length - a.testFiles.length || a.target.localeCompare(b.target),
    );

  return { c1, c2, c3, c4 };
}
