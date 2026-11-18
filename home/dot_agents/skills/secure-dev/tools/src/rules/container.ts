import { posix } from 'node:path';
import { type FileCtx, matchLines, type RuleHit } from '../walk.ts';

const PIPE_TO_SHELL = /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/;
const NPM_INSTALL = /\bnpm\s+(install|i)\b(?![^\n]*\s(-g|--global)\b)/;
const PNPM_INSTALL = /\bpnpm\s+(install|i)\b(?![^\n]*\s(-g|--global|--frozen-lockfile)\b)/;
const YARN_INSTALL = /\byarn(\s+install)?\s*$|\byarn\s+install\b(?![^\n]*\s(--frozen-lockfile|--immutable)\b)/;

/**
 * シェルのコマンド 1 行に当てる判定。Dockerfile の RUN、workflow の run、シェルスクリプトで共通に使う。
 * install の判定は場所で変える
 * - `docker`: CI 環境変数が無いので、pnpm と yarn も既定で lockfile を固定しない
 * - `ci`: pnpm と yarn berry は CI で既定で固定するので、npm だけを見る
 * - `none`: 手元の開発用スクリプト。install は見ない
 */
export function shellHits(command: string, line: number, install: 'docker' | 'ci' | 'none'): RuleHit[] {
  const hits: RuleHit[] = [];
  if (PIPE_TO_SHELL.test(command)) {
    hits.push({ rule: 'shell/pipe-to-shell', kind: 'symptom', line, message: 'ダウンロードしたスクリプトを検証せずにシェルへ渡している' });
  }
  if (install !== 'none' && NPM_INSTALL.test(command)) {
    hits.push({ rule: 'lockfile/not-frozen', kind: 'symptom', line, message: 'npm install は lockfile を書き換えうる。npm ci にする' });
  }
  if (install === 'docker' && PNPM_INSTALL.test(command)) {
    hits.push({ rule: 'lockfile/not-frozen', kind: 'symptom', line, message: 'pnpm install に --frozen-lockfile が無い（CI 環境変数の無いイメージのビルドでは既定で固定されない）' });
  }
  if (install === 'docker' && YARN_INSTALL.test(command)) {
    hits.push({ rule: 'lockfile/not-frozen', kind: 'symptom', line, message: 'yarn install に --frozen-lockfile / --immutable が無い' });
  }
  return hits;
}

/** 継続行（末尾の `\`）をつないだ命令を、開始行の番号付きで返す */
function dockerInstructions(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let cur: { line: number; text: string } | undefined;
  text.split('\n').forEach((raw, i) => {
    if (cur === undefined) {
      if (raw.trim() === '' || /^\s*#/.test(raw)) return;
      cur = { line: i + 1, text: '' };
    } else if (/^\s*#/.test(raw)) {
      return;
    }
    const cont = /\\\s*$/.test(raw);
    cur.text += `${raw.replace(/\\\s*$/, '')} `;
    if (!cont) {
      out.push({ line: cur.line, text: cur.text.trim() });
      cur = undefined;
    }
  });
  if (cur) out.push({ line: cur.line, text: cur.text.trim() });
  return out;
}

function dockerfile(ctx: FileCtx): RuleHit[] {
  const hits: RuleHit[] = [];
  const stages = new Set<string>();
  let lastFrom = 0;
  let lastUser: { line: number; user: string } | undefined;
  for (const ins of dockerInstructions(ctx.text)) {
    const [op, ...rest] = ins.text.split(/\s+/);
    const args = rest.join(' ');
    switch (op.toUpperCase()) {
      case 'FROM': {
        const words = rest.filter((w) => !w.startsWith('--'));
        const image = words[0] ?? '';
        const as = words.findIndex((w) => w.toUpperCase() === 'AS');
        if (as >= 0 && words[as + 1]) stages.add(words[as + 1].toLowerCase());
        lastFrom = ins.line;
        lastUser = undefined;
        if (image === 'scratch' || stages.has(image.toLowerCase()) || image.includes('@sha256:')) break;
        hits.push({ rule: 'docker/unpinned-base', kind: 'symptom', line: ins.line, message: `ベースイメージ ${image} を digest（@sha256:...）で固定していない` });
        break;
      }
      case 'USER':
        lastUser = { line: ins.line, user: args.trim() };
        break;
      case 'ADD':
        if (/(^|\s)https?:\/\//.test(args)) {
          hits.push({ rule: 'docker/remote-add', kind: 'symptom', line: ins.line, message: 'ADD で URL から取得している。チェックサムを確かめる手順が無い' });
        }
        break;
      case 'RUN':
        hits.push(...shellHits(args, ins.line, 'docker'));
        break;
    }
  }
  if (lastFrom > 0 && (lastUser === undefined || /^(root|0)(:|$)/.test(lastUser.user))) {
    hits.push({
      rule: 'docker/root-user',
      kind: 'symptom',
      line: lastUser?.line ?? lastFrom,
      message: lastUser ? '最終 stage が root で動く' : '最終 stage に USER が無く、root で動く（ベースイメージの既定ユーザーを確かめる）',
    });
  }
  return hits;
}

const HOST_ACCESS: Array<[RegExp, string]> = [
  [/^\s*(-\s+)?privileged:\s*true\b/, 'privileged で動かしている'],
  [/^\s*(-\s+)?host(Network|PID|IPC):\s*true\b/, 'ホストの namespace を共有している'],
  [/^\s*(-\s+)?hostPath:/, 'hostPath でホストのファイルシステムをマウントしている'],
  [/docker\.sock/, 'Docker socket をマウントしている（ホストの root 相当）'],
  [/^\s*(-\s+)?allowPrivilegeEscalation:\s*true\b/, '権限昇格を許している'],
  [/^\s*(-\s+)?runAsUser:\s*0\b/, 'root（UID 0）で動かしている'],
  [/^\s*(-\s+)?(network_mode|pid):\s*["']?host\b/, 'ホストの namespace を共有している'],
  [/^\s*(-\s+)?user:\s*["']?(root|0)\b/, 'root で動かしている'],
];

function hostAccess(ctx: FileCtx): RuleHit[] {
  return HOST_ACCESS.flatMap(([re, message]) =>
    matchLines(ctx.text, re).map(({ line }) => ({ rule: 'container/host-access', kind: 'symptom' as const, line, message })),
  );
}

function isDockerfile(base: string): boolean {
  return /^(Dockerfile|Containerfile)(\..+)?$/.test(base) || base.endsWith('.Dockerfile') || /^Dockerfile-/.test(base);
}

export function checkContainer(ctx: FileCtx): RuleHit[] {
  const base = posix.basename(ctx.rel);
  if (isDockerfile(base)) return dockerfile(ctx);
  if (/\.(sh|bash)$/.test(base)) {
    return ctx.text.split('\n').flatMap((l, i) => shellHits(l, i + 1, 'none'));
  }
  const isYaml = /\.ya?ml$/.test(base);
  const skip = ctx.rel.startsWith('.github/') || /^(pnpm-lock|pnpm-workspace)\.yaml$/.test(base);
  return isYaml && !skip ? hostAccess(ctx) : [];
}
