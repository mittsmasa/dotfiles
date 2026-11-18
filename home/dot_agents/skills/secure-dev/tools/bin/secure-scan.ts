#!/usr/bin/env node
// secure-dev の確認項目のうち、ファイルの中身から拾えるものを候補として洗い出す。判定はしない。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runExternal, type ExternalFinding, type Skipped } from '../src/external.ts';
import { checkAgentConfig, inventoryOf, type InventoryKind } from '../src/rules/agent-config.ts';
import { checkContainer } from '../src/rules/container.ts';
import { checkPackageManager } from '../src/rules/package-manager.ts';
import { checkWorkflow } from '../src/rules/workflow.ts';
import { type FileCtx, makeReader, walk } from '../src/walk.ts';

type Finding = { source: 'secure-scan'; rule: string; kind: 'symptom' | 'candidate'; file: string; line: number; message: string } | ExternalFinding;

type Output = {
  root: string;
  paths: string[];
  generatedAt: string;
  ran: string[];
  skipped: Skipped[];
  counts: Record<string, number>;
  findings: Finding[];
  inventory: Array<{ kind: InventoryKind; path: string }>;
};

const USAGE = `usage: node secure-scan.ts <root> [paths...] --out <dir>

  <root>      プロジェクトの基準ディレクトリ。出力のパスはここからの相対
  [paths...]  調べる対象（<root> からの相対）。省略すると <root> 全体
  --out <dir> findings.json を書く場所

zizmor と gitleaks が PATH にあれば一緒に走らせる。無ければ skipped に記録する。`;

const RULES = [checkPackageManager, checkContainer, checkWorkflow, checkAgentConfig];

function parseArgs(argv: string[]): { root: string; paths: string[]; out: string } | undefined {
  const positional: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help' || argv[i] === '-h') return undefined;
    if (argv[i] === '--out') out = argv[++i];
    else positional.push(argv[i]);
  }
  const [root, ...paths] = positional;
  if (!root || !out) return undefined;
  return { root: resolve(root), paths, out: resolve(out) };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log(USAGE);
    return process.argv.includes('--help') || process.argv.includes('-h') ? 0 : 2;
  }
  const { root, paths, out } = args;
  const files = walk(root, paths);
  const read = makeReader(root);

  const findings: Finding[] = [];
  const inventory = new Map<string, InventoryKind>();
  for (const rel of files) {
    const inv = inventoryOf(rel);
    if (inv) inventory.set(inv.path, inv.kind);
    const text = read(rel);
    if (text === undefined || text.includes('\u0000')) continue;
    const ctx: FileCtx = { rel, text, read };
    for (const rule of RULES) {
      for (const hit of rule(ctx)) findings.push({ source: 'secure-scan', file: rel, ...hit });
    }
  }

  const external = runExternal(root, files, paths, out);
  findings.push(...external.findings);
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const counts: Record<string, number> = {};
  for (const f of findings) {
    const key = `${f.source}:${f.rule}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }

  const output: Output = {
    root,
    paths,
    generatedAt: new Date().toISOString(),
    ran: ['secure-scan', ...external.ran],
    skipped: external.skipped,
    counts,
    findings,
    inventory: [...inventory].map(([path, kind]) => ({ kind, path })).sort((a, b) => a.path.localeCompare(b.path)),
  };
  mkdirSync(out, { recursive: true });
  const file = join(out, 'findings.json');
  writeFileSync(file, `${JSON.stringify(output, null, 1)}\n`);

  console.log(`secure-scan: ${files.length} files, ${findings.length} findings, ${output.inventory.length} inventory -> ${file}`);
  for (const [key, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${key}`);
  for (const s of external.skipped) console.log(`  skipped ${s.tool}: ${s.reason}`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error(`secure-scan: ${(e as Error).stack ?? e}`);
  process.exitCode = 1;
}

