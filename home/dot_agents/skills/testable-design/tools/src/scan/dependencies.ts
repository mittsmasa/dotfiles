import { matchesGlob } from 'node:path/posix';
import type { Candidates, ImportVia, Ir } from './ir.ts';

/**
 * Directory names that mark a layer, from the lowest rank to the highest.
 * Names on the same row share a rank. Inferred from common conventions, not
 * read from the project.
 */
export const LAYERS: readonly (readonly string[])[] = [
  ['types', 'constants'],
  ['lib', 'utils', 'api'],
  ['hooks'],
  ['components'],
  ['features'],
  ['pages', 'app'],
];

const RANK = new Map(
  LAYERS.flatMap((names, rank) => names.map((name) => [name, rank] as const)),
);

export interface DependencyOptions {
  /** Globs such as `features/*`: imports between different matches are reported. */
  isolate?: readonly string[];
}

interface Edge {
  from: string;
  to: string;
  /** True when some import of the pair runs at load time (not only `import()`). */
  eager: boolean;
}

/**
 * Run-time imports between source files, one per pair of files. The edge
 * points at `module`, the file the specifier resolves to: that is what the
 * runtime loads, and a barrel loads what it re-exports through its own
 * `reexport` records.
 */
function sourceEdges(ir: Ir): Edge[] {
  const sources = new Set(
    ir.files.filter((record) => record.kind === 'source').map((record) => record.file),
  );
  const edges = new Map<string, Edge>();
  for (const { file, imports } of ir.files) {
    if (!sources.has(file)) continue;
    for (const record of imports) {
      if (record.resolution !== 'internal' || record.target === null) continue;
      if (record.typeOnly || record.via === 'mock') continue;
      const to = record.module ?? record.target;
      if (!sources.has(to)) continue;
      const key = `${file}\0${to}`;
      const edge = edges.get(key) ?? { from: file, to, eager: false };
      edge.eager ||= isEager(record.via);
      edges.set(key, edge);
    }
  }
  return [...edges.values()];
}

const isEager = (via: ImportVia): boolean => via === 'import' || via === 'reexport';

/**
 * Strongly connected components with 2 or more files, or a file importing
 * itself. Tarjan's algorithm, written with an explicit stack so that long
 * import chains do not overflow the call stack.
 */
function stronglyConnected(next: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of next.keys()) {
    if (index.has(start)) continue;
    const work: { node: string; i: number }[] = [{ node: start, i: 0 }];
    index.set(start, counter);
    low.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);
    while (work.length > 0) {
      const frame = work.at(-1)!;
      const neighbors = next.get(frame.node) ?? [];
      if (frame.i < neighbors.length) {
        const neighbor = neighbors[frame.i];
        frame.i += 1;
        if (!index.has(neighbor)) {
          index.set(neighbor, counter);
          low.set(neighbor, counter);
          counter += 1;
          stack.push(neighbor);
          onStack.add(neighbor);
          work.push({ node: neighbor, i: 0 });
        } else if (onStack.has(neighbor)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, index.get(neighbor)!));
        }
        continue;
      }
      work.pop();
      const parent = work.at(-1);
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) !== index.get(frame.node)) continue;
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== frame.node);
      if (component.length > 1 || neighbors.includes(frame.node)) {
        components.push(component.sort());
      }
    }
  }
  return components;
}

/** C7: cycles among source files through imports that run at load time. */
function cycles(edges: readonly Edge[]): Candidates['c7'] {
  const next = new Map<string, string[]>();
  for (const { from, to, eager } of edges) {
    if (!eager) continue;
    if (!next.has(from)) next.set(from, []);
    next.get(from)!.push(to);
  }
  return stronglyConnected(next)
    .map((files) => {
      const members = new Set(files);
      const inner = edges
        .filter(({ from, to, eager }) => eager && members.has(from) && members.has(to))
        .map(({ from, to }): [string, string] => [from, to])
        .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
      return { files, edges: inner };
    })
    .sort((a, b) => b.files.length - a.files.length || a.files[0].localeCompare(b.files[0]));
}

interface Layer {
  /** Path before the layer directory, so that only files of one package are compared. */
  base: string;
  name: string;
  rank: number;
}

/** The layer of a file: the first directory on its path whose name is in `LAYERS`. */
function layerOf(file: string): Layer | null {
  const directories = file.split('/').slice(0, -1);
  for (const [i, name] of directories.entries()) {
    const rank = RANK.get(name);
    if (rank !== undefined) {
      return { base: directories.slice(0, i).join('/'), name, rank };
    }
  }
  return null;
}

/** For `features/*`, the first two segments of a file under it; null otherwise. */
function unitOf(file: string, glob: string): string | null {
  if (!matchesGlob(file, `${glob}/**`)) return null;
  return file.split('/').slice(0, glob.split('/').length).join('/');
}

/** C8: imports from a lower layer to a higher one, and across isolated units. */
function directions(edges: readonly Edge[], options: DependencyOptions): Candidates['c8'] {
  const found: Candidates['c8'] = [];
  for (const { from, to } of edges) {
    const a = layerOf(from);
    const b = layerOf(to);
    if (a && b && a.base === b.base && a.rank < b.rank) {
      found.push({ file: from, target: to, rule: `layer ${a.name} -> ${b.name}` });
    }
    for (const glob of options.isolate ?? []) {
      const unitA = unitOf(from, glob);
      const unitB = unitOf(to, glob);
      if (unitA !== null && unitB !== null && unitA !== unitB) {
        found.push({ file: from, target: to, rule: `isolate ${glob}` });
      }
    }
  }
  return found.sort(
    (x, y) =>
      x.file.localeCompare(y.file) ||
      x.target.localeCompare(y.target) ||
      x.rule.localeCompare(y.rule),
  );
}

/** C7 and C8: the shape of the import graph among source files. */
export function dependencyChecks(
  ir: Ir,
  options: DependencyOptions = {},
): Pick<Candidates, 'c7' | 'c8'> {
  const edges = sourceEdges(ir);
  return { c7: cycles(edges), c8: directions(edges, options) };
}
