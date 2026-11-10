import { isBuiltin } from 'node:module';
import { posix } from 'node:path';
import type { ImportResolution } from './ir.ts';

/** `package.json` of the project root or of a workspace package. */
export interface PackageInfo {
  /** Root-relative directory, `''` for the root. */
  dir: string;
  name: string | null;
  /** Names in dependencies, devDependencies and peerDependencies. */
  dependencies: string[];
  /** Subpath (`.` / `./components` / `./panda/*`) to a path relative to `dir`. */
  exports: Record<string, string>;
}

export interface TsconfigInfo {
  /** Root-relative directory of the tsconfig.json. */
  dir: string;
  paths: Record<string, string[]>;
}

export interface Project {
  /** Every file on disk under the root, root-relative with `/` separators. */
  files: ReadonlySet<string>;
  tsconfigs: TsconfigInfo[];
  packages: PackageInfo[];
  /** Directory names whose contents are generated and may be missing on disk. */
  generatedDirectories: string[];
}

export interface Resolution {
  target: string | null;
  resolution: ImportResolution;
}

const CODE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];
const CODE_FILE = /\.(d\.ts|[cm]?[jt]sx?)$/;
const HAS_EXTENSION = /\.[a-z0-9]+$/i;

const UNRESOLVED: Resolution = { target: null, resolution: 'unresolved' };

function isInside(dir: string, file: string): boolean {
  return dir === '' || file.startsWith(`${dir}/`);
}

/** The entries whose directory contains `file`, nearest first. */
function ancestors<T extends { dir: string }>(entries: T[], file: string): T[] {
  return entries
    .filter((entry) => isInside(entry.dir, file))
    .sort((a, b) => b.dir.length - a.dir.length);
}

/** Finds the file a path without (or with) an extension points at. */
function findFile(path: string, files: ReadonlySet<string>): string | null {
  if (files.has(path)) return path;
  for (const extension of CODE_EXTENSIONS) {
    if (files.has(path + extension)) return path + extension;
  }
  for (const index of INDEX_FILES) {
    const candidate = path === '' ? index : `${path}/${index}`;
    if (files.has(candidate)) return candidate;
  }
  return null;
}

/**
 * A path that some rule (relative, `paths`, workspace exports) mapped the
 * specifier to. A path with a non-code extension is an asset whether or not
 * it exists. A missing code file is `generated` inside a generated directory
 * and `unresolved` anywhere else.
 */
function resolvePath(path: string, project: Project): Resolution {
  const { files } = project;
  const normalized = posix.normalize(path).replace(/\/$/, '');
  const clean = normalized === '.' ? '' : normalized;
  const found = clean.startsWith('..') ? null : findFile(clean, files);
  if (found) {
    return {
      target: found,
      resolution: CODE_FILE.test(found) ? 'internal' : 'asset',
    };
  }
  if (HAS_EXTENSION.test(clean) && !CODE_FILE.test(clean)) {
    return { target: null, resolution: 'asset' };
  }
  const segments = clean.split('/');
  if (project.generatedDirectories.some((name) => segments.includes(name))) {
    return { target: null, resolution: 'generated' };
  }
  return UNRESOLVED;
}

/** Substitutes the `*` of a `paths` / `exports` pattern. Null when it does not match. */
function matchPattern(pattern: string, value: string): string | null {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === value ? '' : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (
    value.length < prefix.length + suffix.length ||
    !value.startsWith(prefix) ||
    !value.endsWith(suffix)
  ) {
    return null;
  }
  return value.slice(prefix.length, value.length - suffix.length);
}

function resolveByPaths(
  specifier: string,
  importer: string,
  project: Project,
): Resolution | null {
  const tsconfig = ancestors(project.tsconfigs, importer)[0];
  if (!tsconfig) return null;
  for (const [pattern, substitutions] of Object.entries(tsconfig.paths)) {
    const matched = matchPattern(pattern, specifier);
    if (matched === null) continue;
    let result = UNRESOLVED;
    for (const substitution of substitutions) {
      const path = posix.join(tsconfig.dir, substitution.replace('*', matched));
      result = resolvePath(path, project);
      if (result.resolution !== 'unresolved') return result;
    }
    return result;
  }
  return null;
}

function resolveByWorkspace(
  specifier: string,
  project: Project,
): Resolution | null {
  for (const pkg of project.packages) {
    if (pkg.name === null) continue;
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
    const subpath = `.${specifier.slice(pkg.name.length)}`;
    for (const [pattern, target] of Object.entries(pkg.exports)) {
      const matched = matchPattern(pattern, subpath);
      if (matched === null) continue;
      const path = posix.join(pkg.dir, target.replace('*', matched));
      return resolvePath(path, project);
    }
    return UNRESOLVED;
  }
  return null;
}

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Resolves a module specifier written in `importer`.
 *
 * Handles relative paths, tsconfig `paths` of the nearest tsconfig.json,
 * workspace packages through their `exports`, Node builtins, and packages
 * declared in a package.json above the importer. Anything else is
 * `unresolved`, so a missed resolution never hides among externals.
 */
export function resolveSpecifier(
  specifier: string,
  importer: string,
  project: Project,
): Resolution {
  const path = specifier.replace(/[?#].*$/, '');
  if (path === '.' || path === '..' || /^\.\.?\//.test(path)) {
    return resolvePath(posix.join(posix.dirname(importer), path), project);
  }
  const byPaths = resolveByPaths(path, importer, project);
  if (byPaths) return byPaths;
  const byWorkspace = resolveByWorkspace(path, project);
  if (byWorkspace) return byWorkspace;
  if (isBuiltin(path)) return { target: null, resolution: 'external' };
  const name = packageName(path);
  const declared = ancestors(project.packages, importer).some((pkg) =>
    pkg.dependencies.includes(name),
  );
  return declared ? { target: null, resolution: 'external' } : UNRESOLVED;
}

/**
 * Removes `//` and block comments and trailing commas from JSON text, leaving
 * string literals untouched. Node has no JSONC parser in its standard library
 * (checked: util and globals documentation).
 */
export function stripJsonComments(text: string): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === '\\' ? 2 : 1;
      }
      output += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && next === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      output += char;
      index += 1;
    }
  }
  return output.replace(/,(\s*[}\]])/g, '$1');
}

/** Reads `compilerOptions.paths` from the text of a tsconfig.json. */
export function readTsconfigPaths(text: string): Record<string, string[]> {
  const config = JSON.parse(stripJsonComments(text));
  return config?.compilerOptions?.paths ?? {};
}

/** Picks the file of one `exports` entry: a string, or its `default` / `import` / `types` condition. */
function exportTarget(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const conditions = entry as Record<string, unknown>;
    const target = conditions.default ?? conditions.import ?? conditions.types;
    return typeof target === 'string' ? target : null;
  }
  return null;
}

/** Reads the parts of a package.json that resolution needs. */
export function readPackageInfo(text: string, dir: string): PackageInfo {
  const json = JSON.parse(text);
  const exports: Record<string, string> = {};
  const entries: [string, unknown][] =
    typeof json.exports === 'string'
      ? [['.', json.exports]]
      : Object.entries(json.exports ?? {});
  for (const [subpath, entry] of entries) {
    const target = exportTarget(entry);
    if (target !== null) exports[subpath] = target;
  }
  return {
    dir,
    name: typeof json.name === 'string' ? json.name : null,
    dependencies: Object.keys({
      ...json.dependencies,
      ...json.devDependencies,
      ...json.peerDependencies,
    }),
    exports,
  };
}
