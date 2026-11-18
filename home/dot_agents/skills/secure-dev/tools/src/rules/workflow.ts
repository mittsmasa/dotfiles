import { type FileCtx, type RuleHit } from '../walk.ts';
import { shellHits } from './container.ts';

const KEY = /^(\s*)(-\s+)?([\w-]+):(.*)$/;

/**
 * workflow / job レベルの `env:` で `secrets.` を参照している行を返す。
 * step の `env:`、`services` と `container` の `env:` は対象にしない（そこで使う値だけが届くため）。
 * YAML はパースせず、字下げで親のキーを追う
 */
function wideSecretEnv(text: string): RuleHit[] {
  const hits: RuleHit[] = [];
  const stack: Array<{ indent: number; key: string }> = [];
  let envIndent: number | undefined;
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '' || /^\s*#/.test(raw)) return;
    const indent = raw.length - raw.trimStart().length;
    if (envIndent !== undefined) {
      if (indent > envIndent) {
        if (/\$\{\{\s*secrets\./.test(raw)) {
          hits.push({ rule: 'ci/secrets-wide-env', kind: 'candidate', line: i + 1, message: 'workflow / job レベルの env で secrets を渡している。全 step（依存の install を含む）に届く' });
        }
        return;
      }
      envIndent = undefined;
    }
    const m = raw.match(KEY);
    if (!m) return;
    const keyIndent = m[1].length + (m[2]?.length ?? 0);
    while (stack.length > 0 && stack[stack.length - 1].indent >= keyIndent) stack.pop();
    if (m[3] === 'env' && m[4].trim() === '') {
      const parents = stack.map((s) => s.key);
      if (!parents.some((k) => k === 'steps' || k === 'services' || k === 'container')) envIndent = keyIndent;
    }
    stack.push({ indent: keyIndent, key: m[3] });
  });
  return hits;
}

export function checkWorkflow(ctx: FileCtx): RuleHit[] {
  if (!/^\.github\/workflows\/[^/]+\.ya?ml$/.test(ctx.rel)) return [];
  const commands = ctx.text.split('\n').flatMap((l, i) => shellHits(l, i + 1, 'ci'));
  return [...commands, ...wideSecretEnv(ctx.text)];
}
