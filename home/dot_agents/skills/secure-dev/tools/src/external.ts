import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExcluded, toPosix } from './walk.ts';

export type ExternalFinding = {
  source: 'zizmor' | 'gitleaks';
  rule: string;
  severity: string;
  file: string;
  line: number;
  message: string;
};
export type Skipped = { tool: string; reason: string };
export type ExternalResult = { findings: ExternalFinding[]; ran: string[]; skipped: Skipped[] };

const GITLEAKS_CONFIG = fileURLToPath(new URL('../gitleaks.toml', import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;

function which(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const p = join(dir, cmd);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // 次の PATH を探す
    }
  }
  return undefined;
}

function tail(text: string): string {
  const lines = text.trim().split('\n');
  return lines.slice(-3).join(' / ').slice(0, 300) || '(出力なし)';
}

type ZizmorLocation = {
  symbolic: { key: { Local?: { verbatim_path?: string } }; kind: string; annotation?: string };
  concrete: { location: { start_point: { row: number } } };
};
type ZizmorFinding = { ident: string; desc: string; determinations: { severity: string }; locations: ZizmorLocation[] };

/** zizmor の JSON（v1）を揃える。行番号は 0 始まりなので 1 を足す */
export function normalizeZizmor(json: ZizmorFinding[]): ExternalFinding[] {
  return json.flatMap((f) => {
    const loc = f.locations.find((l) => l.symbolic.kind === 'Primary') ?? f.locations[0];
    const file = loc?.symbolic.key.Local?.verbatim_path;
    if (!loc || !file) return [];
    const note = loc.symbolic.annotation ? `（${loc.symbolic.annotation}）` : '';
    return [{ source: 'zizmor' as const, rule: f.ident, severity: f.determinations.severity, file, line: loc.concrete.location.start_point.row + 1, message: `${f.desc}${note}` }];
  });
}

type GitleaksFinding = { RuleID: string; Description: string; File: string; StartLine: number };

/** gitleaks の JSON を揃える。値（Match / Secret / Line）は持ち出さない。除外ディレクトリの結果は落とす */
export function normalizeGitleaks(json: GitleaksFinding[], root: string): ExternalFinding[] {
  return json.flatMap((f) => {
    const file = toPosix(isAbsolute(f.File) ? relative(root, f.File) : f.File);
    if (isExcluded(file)) return [];
    return [{ source: 'gitleaks' as const, rule: f.RuleID, severity: 'High', file, line: f.StartLine, message: f.Description }];
  });
}

function runZizmor(root: string, files: string[], result: ExternalResult): void {
  if (files.length === 0) return;
  if (!which('zizmor')) {
    result.skipped.push({ tool: 'zizmor', reason: 'PATH に zizmor が無い' });
    return;
  }
  // 走査先の zizmor.yml と ignore コメントで検出を止められないよう、設定と ignore を読ませない
  const r = spawnSync('zizmor', ['--offline', '--no-config', '--no-ignores', '--no-exit-codes', '--format', 'json', ...files], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  if (r.status !== 0) {
    result.skipped.push({ tool: 'zizmor', reason: `exit ${r.status}: ${tail(r.stderr ?? '')}` });
    return;
  }
  try {
    result.findings.push(...normalizeZizmor(JSON.parse(r.stdout) as ZizmorFinding[]));
    result.ran.push('zizmor');
  } catch (e) {
    result.skipped.push({ tool: 'zizmor', reason: `JSON を読めない: ${(e as Error).message}` });
  }
}

function runGitleaks(root: string, targets: string[], outDir: string, result: ExternalResult): void {
  if (!which('gitleaks')) {
    result.skipped.push({ tool: 'gitleaks', reason: 'PATH に gitleaks が無い' });
    return;
  }
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(outDir, '.gitleaks-'));
  const empty = join(tmp, 'empty');
  mkdirSync(empty);
  // 走査先の .gitleaks.toml、.gitleaksignore、gitleaks:allow、環境変数の設定を読ませない
  const env = { ...process.env };
  delete env.GITLEAKS_CONFIG;
  delete env.GITLEAKS_CONFIG_TOML;
  try {
    for (const [i, target] of targets.entries()) {
      const report = join(tmp, `report-${i}.json`);
      const r = spawnSync(
        'gitleaks',
        ['dir', join(root, target), '--config', GITLEAKS_CONFIG, '--gitleaks-ignore-path', empty, '--ignore-gitleaks-allow', '--redact', '--no-banner', '--log-level', 'error', '--exit-code', '0', '--report-format', 'json', '--report-path', report],
        { cwd: empty, env, encoding: 'utf8', maxBuffer: MAX_BUFFER },
      );
      let parsed: GitleaksFinding[];
      try {
        parsed = JSON.parse(readFileSync(report, 'utf8')) as GitleaksFinding[];
      } catch {
        result.skipped.push({ tool: 'gitleaks', reason: `${target || '.'}: レポートを読めない（exit ${r.status}: ${tail(r.stderr ?? '')}）` });
        return;
      }
      result.findings.push(...normalizeGitleaks(parsed, root));
    }
    result.ran.push('gitleaks');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** zizmor は workflow などのファイル、gitleaks は `paths`（無ければ `<root>`）に当てる */
export function runExternal(root: string, files: string[], paths: string[], outDir: string): ExternalResult {
  const result: ExternalResult = { findings: [], ran: [], skipped: [] };
  const actionsFiles = files.filter(
    (f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) || /(^|\/)action\.ya?ml$/.test(f) || /^\.github\/dependabot\.ya?ml$/.test(f),
  );
  runZizmor(root, actionsFiles, result);
  runGitleaks(root, paths.length > 0 ? paths : [''], outDir, result);
  return result;
}
