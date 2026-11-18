import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

/** どの階層にあっても除外するディレクトリ名 */
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'vendor', '.workflow']);
/** 連続する 2 階層で除外するもの（別の checkout） */
const EXCLUDED_PAIRS = [['.claude', 'worktrees']];
const EXCLUDED_TOP = new Set(['.worktrees']);

/** 1 MB を超えるファイルは読まない（生成物や lockfile の巨大化を避ける） */
const MAX_BYTES = 1024 * 1024;

export function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

/** `<root>` からの相対パス（posix 区切り）が除外対象か */
export function isExcluded(rel: string): boolean {
  const parts = toPosix(rel).split('/');
  for (let i = 0; i < parts.length; i++) {
    if (EXCLUDED_DIRS.has(parts[i])) return true;
    if (EXCLUDED_TOP.has(parts[i])) return true;
    for (const [a, b] of EXCLUDED_PAIRS) {
      if (parts[i] === a && parts[i + 1] === b) return true;
    }
  }
  return false;
}

/** `<root>` 配下の `paths`（省略時は `<root>` 全体）にあるファイルを、`<root>` からの相対パスで返す */
export function walk(root: string, paths: string[]): string[] {
  const out = new Set<string>();
  const visit = (rel: string) => {
    if (rel !== '' && isExcluded(rel)) return;
    const abs = join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(abs)) visit(rel === '' ? name : posix.join(rel, name));
    } else if (st.isFile() && st.size <= MAX_BYTES) {
      out.add(rel);
    }
  };
  for (const p of paths.length > 0 ? paths : ['']) {
    const rel = p === '' ? '' : toPosix(relative(root, join(root, p)));
    visit(rel === '.' ? '' : rel);
  }
  return [...out].sort();
}

/** ルールに渡す、1 ファイルぶんの文脈 */
export type FileCtx = {
  /** `<root>` からの相対パス（posix 区切り） */
  rel: string;
  text: string;
  /** `<root>` からの相対パスでほかのファイルを読む。無ければ undefined */
  read: (rel: string) => string | undefined;
};

export function makeReader(root: string): (rel: string) => string | undefined {
  return (rel) => {
    try {
      return readFileSync(join(root, rel), 'utf8');
    } catch {
      return undefined;
    }
  };
}

/** ルールが返す 1 件。`symptom` はその行だけで問題と分かるもの、`candidate` は読まないと判断できないもの */
export type RuleHit = { rule: string; kind: 'symptom' | 'candidate'; line: number; message: string };

/** 正規表現に当たる行を 1 始まりの行番号で返す */
export function matchLines(text: string, re: RegExp): Array<{ line: number; match: RegExpMatchArray }> {
  const hits: Array<{ line: number; match: RegExpMatchArray }> = [];
  text.split('\n').forEach((l, i) => {
    const m = l.match(re);
    if (m) hits.push({ line: i + 1, match: m });
  });
  return hits;
}

/** `key:` で始まる YAML のトップレベルのブロックについて、配下の行を行番号付きで返す */
export function yamlBlock(text: string, key: string): Array<{ line: number; text: string }> {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*(#.*)?$`).test(l));
  if (start < 0) return [];
  const body: Array<{ line: number; text: string }> = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '' || /^\s*#/.test(l)) continue;
    if (!/^\s/.test(l)) break;
    body.push({ line: i + 1, text: l });
  }
  return body;
}
