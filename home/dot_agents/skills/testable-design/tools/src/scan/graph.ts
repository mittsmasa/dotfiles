import type {
  FileFacts,
  FileRecord,
  ImportResolution,
  Ir,
  RawImport,
  ResolvedImport,
} from './ir.ts';
import { type Project, resolveSpecifier } from './resolve.ts';

type Facts = ReadonlyMap<string, FileFacts>;

/**
 * Follows re-exports from `file` to the file that defines `name`.
 * Returns null when `file` neither defines nor re-exports the name.
 */
function findDefinition(
  file: string,
  name: string,
  facts: Facts,
  project: Project,
  seen: Set<string>,
): string | null {
  const fileFacts = facts.get(file);
  // A file without facts (generated, ignored) is taken as the definer.
  if (!fileFacts) return file;
  if (seen.has(file)) return null;
  seen.add(file);
  if (fileFacts.exports.some((fact) => fact.name === name)) return file;

  for (const record of fileFacts.imports) {
    if (record.via !== 'reexport') continue;
    const isStar = record.names[0] === '*' && record.exportedAs === undefined;
    if (!isStar && record.exportedAs !== name) continue;
    const { target, resolution } = resolveSpecifier(record.source, file, project);
    if (resolution !== 'internal' || target === null) continue;
    // `export * as ns from './x'` exports the module itself under `ns`.
    if (!isStar && record.names[0] === '*') return target;
    const found = findDefinition(
      target,
      isStar ? name : record.names[0],
      facts,
      project,
      seen,
    );
    if (found !== null) return found;
  }
  return null;
}

/** True when the name can be traced through re-exports to one defining file. */
function isTraceable(record: RawImport, name: string): boolean {
  return (
    (record.via === 'import' || record.via === 'reexport') &&
    name !== '*' &&
    name !== 'default'
  );
}

function resolveImport(
  record: RawImport,
  importer: string,
  facts: Facts,
  project: Project,
): ResolvedImport[] {
  const { target, resolution } = resolveSpecifier(record.source, importer, project);
  if (resolution !== 'internal' || target === null) {
    return [{ ...record, target, resolution }];
  }
  if (record.names.length === 0) {
    return [{ ...record, target, module: target, resolution }];
  }
  return record.names.map((name) => ({
    ...record,
    names: [name],
    resolution,
    target: isTraceable(record, name)
      ? (findDefinition(target, name, facts, project, new Set()) ?? target)
      : target,
    module: target,
  }));
}

/**
 * Resolves every import and splits internal named imports so that each record
 * has one name and points at the file that defines it. Imports that are not
 * internal keep their names together.
 */
export function buildIr(
  facts: Facts,
  project: Project,
  parseFailures = 0,
): Ir {
  const counts: Record<ImportResolution, number> = {
    internal: 0,
    generated: 0,
    external: 0,
    asset: 0,
    unresolved: 0,
  };
  const files: FileRecord[] = [];
  for (const [file, fileFacts] of facts) {
    const imports = fileFacts.imports.flatMap((record) =>
      resolveImport(record, file, facts, project),
    );
    for (const record of imports) counts[record.resolution] += 1;
    files.push({ ...fileFacts, file, imports });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { files, stats: { parseFailures, imports: counts } };
}

export interface Graph {
  /** Files that use `file` directly, not counting type-only imports and mocks. */
  importersOf(file: string): string[];
  /**
   * Every file reachable from `starts` through imports, including the starts.
   * With `mocked`, an import whose `module` or `target` is in it is not
   * followed: the real module behind a mock does not run.
   */
  reachableFrom(starts: Iterable<string>, mocked?: ReadonlySet<string>): Set<string>;
  /**
   * Like `reachableFrom` without mocks, but an import also reaches its
   * `module` (a barrel), so that a mocked barrel can be found on the way.
   */
  modulesReachableFrom(starts: Iterable<string>): Set<string>;
  /** `file` and the files it re-exports, transitively. */
  reexportClosure(file: string): Set<string>;
}

/** A use of the target at run time: not a type-only import and not a mock. */
function isUse(record: ResolvedImport): record is ResolvedImport & { target: string } {
  return (
    record.resolution === 'internal' &&
    record.target !== null &&
    !record.typeOnly &&
    record.via !== 'mock'
  );
}

/**
 * Builds the import graph.
 *
 * An import that cannot be narrowed to one name (`import * as x`, a default
 * import, a side-effect import) of a file that re-exports other files counts
 * as a direct use of all of them.
 */
export function buildGraph(ir: Ir): Graph {
  const edges = new Map<string, Set<string>>();
  const moduleEdges = new Map<string, Set<string>>();
  const uses = new Map<string, { target: string; module: string }[]>();
  const reexports = new Map<string, Set<string>>();
  for (const { file, imports } of ir.files) {
    for (const record of imports) {
      if (!isUse(record)) continue;
      const module = record.module ?? record.target;
      if (!edges.has(file)) edges.set(file, new Set());
      edges.get(file)!.add(record.target);
      if (!moduleEdges.has(file)) moduleEdges.set(file, new Set());
      moduleEdges.get(file)!.add(record.target).add(module);
      if (!uses.has(file)) uses.set(file, []);
      uses.get(file)!.push({ target: record.target, module });
      if (record.via === 'reexport') {
        if (!reexports.has(file)) reexports.set(file, new Set());
        reexports.get(file)!.add(record.target);
      }
    }
  }

  function closure(starts: Iterable<string>, graph: Map<string, Set<string>>): Set<string> {
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const next of graph.get(file) ?? []) queue.push(next);
    }
    return seen;
  }

  const importers = new Map<string, Set<string>>();
  for (const { file, imports } of ir.files) {
    for (const record of imports) {
      if (!isUse(record) || record.via === 'reexport') continue;
      const narrowed = record.names.length === 1 && isTraceable(record, record.names[0]);
      const targets = narrowed ? [record.target] : closure([record.target], reexports);
      for (const target of targets) {
        if (!importers.has(target)) importers.set(target, new Set());
        importers.get(target)!.add(file);
      }
    }
  }

  function reachableAvoiding(
    starts: Iterable<string>,
    mocked: ReadonlySet<string>,
  ): Set<string> {
    const seen = new Set<string>();
    const queue = [...starts];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const { target, module } of uses.get(file) ?? []) {
        if (mocked.has(target) || mocked.has(module)) continue;
        queue.push(target);
      }
    }
    return seen;
  }

  return {
    importersOf: (file) => [...(importers.get(file) ?? [])].sort(),
    reachableFrom: (starts, mocked) =>
      mocked && mocked.size > 0 ? reachableAvoiding(starts, mocked) : closure(starts, edges),
    modulesReachableFrom: (starts) => closure(starts, moduleEdges),
    reexportClosure: (file) => closure([file], reexports),
  };
}
