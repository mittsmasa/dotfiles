#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runChecks } from '../src/scan/checks.ts';
import { excludeCandidates } from '../src/scan/exclude.ts';
import { buildGraph, buildIr } from '../src/scan/graph.ts';
import type { FileFacts } from '../src/scan/ir.ts';
import {
  type PackageInfo,
  type Project,
  readPackageInfo,
  readTsconfigPaths,
  type TsconfigInfo,
} from '../src/scan/resolve.ts';

const USAGE = `Usage: testable-scan <root> [paths...] --out <dir> [--exclude <glob>]...

  <root>            project directory; tsconfig.json and package.json are read from here
  [paths...]        what to scan, relative to <root> (default: all of <root>)
  --out <dir>       where ir.json and candidates.json are written
  --exclude <glob>  leave matching files out of the candidates; repeatable.
                    The glob is matched against paths relative to <root>.
                    Excluded files stay in the import graph.`;
const FACTS_CODE = 'testable(facts)';
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'storybook-static',
  'coverage',
]);

const toPosix = (path: string): string => path.split(sep).join('/');

/** Every file under `root`, root-relative with `/` separators. */
function listFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) pending.push(path);
      } else {
        files.push(toPosix(relative(root, path)));
      }
    }
  }
  return files;
}

/** Runs the facts rule and returns one record per linted file. */
function collectFacts(
  root: string,
  targets: string[],
  config: string,
): { facts: Map<string, FileFacts>; parseFailures: number } {
  const result = spawnSync('oxlint', ['-c', config, '-f', 'json', ...targets], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
  });
  // oxlint exits with 1 when it reports diagnostics; that is the expected path.
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `oxlint failed (status ${result.status}): ${result.error?.message ?? result.stderr}`,
    );
  }
  const output: { diagnostics: { code: string; filename: string; message: string }[] } =
    JSON.parse(result.stdout);
  const facts = new Map<string, FileFacts>();
  let parseFailures = 0;
  for (const diagnostic of output.diagnostics) {
    if (diagnostic.code !== FACTS_CODE) continue;
    try {
      facts.set(
        toPosix(relative(root, diagnostic.filename)),
        JSON.parse(diagnostic.message),
      );
    } catch {
      parseFailures += 1;
    }
  }
  return { facts, parseFailures };
}

// Directory names from ignore patterns that ignore a whole directory at any
// depth, written as two stars, the name, two stars, separated by slashes.
function ignoredDirectories(config: string): string[] {
  const { ignorePatterns = [] }: { ignorePatterns?: string[] } = JSON.parse(
    readFileSync(config, 'utf8'),
  );
  return ignorePatterns.flatMap((pattern) => {
    const match = /^\*\*\/([^/*]+)\/\*\*$/.exec(pattern);
    return match ? [match[1]] : [];
  });
}

function readProject(root: string, generatedDirectories: string[]): Project {
  const files = listFiles(root);
  const tsconfigs: TsconfigInfo[] = [];
  const packages: PackageInfo[] = [];
  for (const file of files) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (name !== 'tsconfig.json' && name !== 'package.json') continue;
    const dir = file === name ? '' : dirname(file);
    const text = readFileSync(join(root, file), 'utf8');
    try {
      if (name === 'tsconfig.json') {
        tsconfigs.push({ dir, paths: readTsconfigPaths(text) });
      } else {
        packages.push(readPackageInfo(text, dir));
      }
    } catch (error) {
      console.error(`skipped ${file}: ${(error as Error).message}`);
    }
  }
  return { files: new Set(files), tsconfigs, packages, generatedDirectories };
}

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      exclude: { type: 'string', multiple: true },
    },
  });
  if (positionals.length === 0 || !values.out) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const root = resolve(positionals[0]);
  const paths = positionals.length > 1 ? positionals.slice(1) : ['.'];
  const targets = paths.map((path) => resolve(root, path));

  const config = join(
    dirname(fileURLToPath(import.meta.url)),
    '../facts.oxlintrc.json',
  );
  const { facts, parseFailures } = collectFacts(root, targets, config);
  // Files the facts rule ignores as generated may be absent until codegen runs.
  const project = readProject(root, ignoredDirectories(config));
  const ir = buildIr(facts, project, parseFailures);
  const globs = values.exclude ?? [];
  const { candidates, excluded } = excludeCandidates(
    runChecks(ir, buildGraph(ir)),
    globs,
  );

  mkdirSync(values.out, { recursive: true });
  writeFileSync(join(values.out, 'ir.json'), `${JSON.stringify(ir, null, 1)}\n`);
  writeFileSync(
    join(values.out, 'candidates.json'),
    `${JSON.stringify(candidates, null, 1)}\n`,
  );

  const { imports } = ir.stats;
  console.log(`files: ${ir.files.length} (parse failures: ${parseFailures})`);
  console.log(
    `imports: internal ${imports.internal}, generated ${imports.generated}, external ${imports.external}, asset ${imports.asset}, unresolved ${imports.unresolved}`,
  );
  console.log(
    `candidates: c1 ${candidates.c1.length}, c2 ${candidates.c2.length}, c3 ${candidates.c3.length}, c4 ${candidates.c4.length}`,
  );
  if (globs.length > 0) {
    console.log(
      `excluded: c1 ${excluded.c1}, c2 ${excluded.c2}, c3 ${excluded.c3}, c4 ${excluded.c4}`,
    );
  }
}

main();
