import { posix } from 'node:path';
import { type FileCtx, matchLines, type RuleHit, yamlBlock } from '../walk.ts';

const MIN_AGE_MINUTES = 7 * 24 * 60;
const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];
const RENOVATE_FILES = new Set([
  'renovate.json',
  'renovate.json5',
  '.renovaterc',
  '.renovaterc.json',
  '.renovaterc.json5',
  '.github/renovate.json',
  '.github/renovate.json5',
  '.gitlab/renovate.json',
  '.gitlab/renovate.json5',
]);
/** pnpm が .npmrc から読むキー（auth、registry、TLS、proxy、local-address） */
const PNPM_NPMRC_KEYS =
  /^(registry|_auth|_authToken|_password|username|email|always-auth|tokenHelper|ca|cafile|cert|key|strict-ssl|proxy|https-proxy|http-proxy|no-proxy|noproxy|local-address)$/;
const REMOVED_BUILD_KEYS = /^(onlyBuiltDependencies|onlyBuiltDependenciesFile|neverBuiltDependencies|ignoredBuiltDependencies|ignoreDepScripts):/;

function pnpmWorkspace(ctx: FileCtx): RuleHit[] {
  const hits: RuleHit[] = [];
  const age = matchLines(ctx.text, /^minimumReleaseAge:\s*(\d+)/)[0];
  if (!age) {
    hits.push({ rule: 'cooldown/pnpm-missing', kind: 'symptom', line: 1, message: 'minimumReleaseAge が無い（pnpm の既定は 1440 分 = 1 日）。10080（7 日）以上にする' });
  } else if (Number(age.match[1]) < MIN_AGE_MINUTES) {
    hits.push({ rule: 'cooldown/pnpm-missing', kind: 'symptom', line: age.line, message: `minimumReleaseAge が ${age.match[1]} 分。10080（7 日）以上にする` });
  }
  const excluded = yamlBlock(ctx.text, 'minimumReleaseAgeExclude').filter((item) => /^\s*-/.test(item.text));
  if (excluded.length > 0) {
    const names = excluded.map((item) => item.text.trim().replace(/^-\s*/, ''));
    const shown = names.length > 5 ? `${names.slice(0, 5).join(', ')} ほか ${names.length - 5} 件` : names.join(', ');
    hits.push({ rule: 'cooldown/pnpm-exclude', kind: 'candidate', line: excluded[0].line, message: `クールダウンの例外 ${names.length} 件（${shown}）。理由と期限が残っているかを見る` });
  }
  for (const { line } of matchLines(ctx.text, /^dangerouslyAllowAllBuilds:\s*true\b/)) {
    hits.push({ rule: 'scripts/allow-all', kind: 'symptom', line, message: '依存の install script をすべて許可している' });
  }
  for (const { line } of matchLines(ctx.text, /^strictDepBuilds:\s*false\b/)) {
    hits.push({ rule: 'scripts/allow-all', kind: 'symptom', line, message: 'strictDepBuilds を切っている。未確認の install script があっても install が通る' });
  }
  for (const item of yamlBlock(ctx.text, 'allowBuilds')) {
    const m = item.text.match(/^\s+(['"]?)(.+?)\1:\s*true\b/);
    if (m) hits.push({ rule: 'scripts/allowed', kind: 'candidate', line: item.line, message: `install script を許可: ${m[2]}。何をする script かを確かめる` });
  }
  for (const { line, match } of matchLines(ctx.text, REMOVED_BUILD_KEYS)) {
    hits.push({ rule: 'scripts/allowed', kind: 'candidate', line, message: `${match[1]} は pnpm v11 で削除され allowBuilds に置き換わった。使っている pnpm の版を確かめる` });
  }
  return hits;
}

function renovate(ctx: FileCtx): RuleHit[] {
  // コメント行に書かれた例（`// minimumReleaseAge: "3 days" を打ち消す` など）は拾わない
  const ages = matchLines(ctx.text, /^(?!\s*(\/\/|#|\*))[^\n]*?["']?(minimumReleaseAge|stabilityDays)["']?\s*:\s*["']?([^"',}]+)/);
  if (ages.length === 0) {
    return [{ rule: 'cooldown/renovate-missing', kind: 'symptom', line: 1, message: 'minimumReleaseAge が無い。"7 days" 以上にする' }];
  }
  return ages.flatMap(({ line, match }) => {
    const days = toDays(match[2] === 'stabilityDays' ? `${match[3]} days` : match[3]);
    return days !== undefined && days < 7
      ? [{ rule: 'cooldown/renovate-missing', kind: 'symptom' as const, line, message: `minimumReleaseAge が ${match[3].trim()}。7 日以上にする（パッケージルールごとの値なら対象を確かめる）` }]
      : [];
  });
}

function toDays(value: string): number | undefined {
  const m = value.trim().match(/^(\d+)\s*(minutes?|m|hours?|h|days?|d|weeks?|w)$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase()[0];
  return unit === 'w' ? n * 7 : unit === 'd' ? n : unit === 'h' ? n / 24 : n / 1440;
}

function npmrc(ctx: FileCtx): RuleHit[] {
  const dir = posix.dirname(ctx.rel);
  const isPnpm = ['pnpm-lock.yaml', 'pnpm-workspace.yaml'].some((f) => ctx.read(posix.join(dir, f)) !== undefined);
  if (!isPnpm) return [];
  return matchLines(ctx.text, /^\s*([^#;\s=][^=]*?)\s*=/).flatMap(({ line, match }) => {
    const key = match[1];
    if (key.startsWith('//') || /^@[^:]+:registry$/.test(key) || PNPM_NPMRC_KEYS.test(key)) return [];
    return [{ rule: 'npmrc/pnpm-ignored-key', kind: 'symptom' as const, line, message: `${key} は pnpm が .npmrc から読まない。pnpm-workspace.yaml に書く` }];
  });
}

function npmLock(ctx: FileCtx): RuleHit[] {
  const rc = ctx.read(posix.join(posix.dirname(ctx.rel), '.npmrc'));
  if (rc !== undefined && /^\s*ignore-scripts\s*=\s*true\b/m.test(rc)) return [];
  return [{ rule: 'scripts/npm-not-ignored', kind: 'symptom', line: 1, message: '隣の .npmrc に ignore-scripts=true が無い。依存の install script が無条件に走る' }];
}

function packageJson(ctx: FileCtx): RuleHit[] {
  if (!/"(dependencies|devDependencies|optionalDependencies)"\s*:/.test(ctx.text)) return [];
  let dir = posix.dirname(ctx.rel);
  for (;;) {
    if (LOCKFILES.some((f) => ctx.read(posix.join(dir, f)) !== undefined)) return [];
    if (dir === '.') break;
    dir = posix.dirname(dir);
  }
  return [{ rule: 'lockfile/missing', kind: 'symptom', line: 1, message: 'この package.json から <root> まで遡っても lockfile が無い' }];
}

export function checkPackageManager(ctx: FileCtx): RuleHit[] {
  const base = posix.basename(ctx.rel);
  if (base === 'pnpm-workspace.yaml') return pnpmWorkspace(ctx);
  if (RENOVATE_FILES.has(ctx.rel) || RENOVATE_FILES.has(base)) return renovate(ctx);
  if (base === '.npmrc') return npmrc(ctx);
  if (base === 'package-lock.json') return npmLock(ctx);
  if (base === 'package.json') return packageJson(ctx);
  return [];
}
