import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkContainer, shellHits } from './container.ts';

function hits(rel: string, text: string): Array<[string, number]> {
  return checkContainer({ rel, text, read: () => undefined }).map((h) => [h.rule, h.line]);
}

const DIGEST = '@sha256:0000000000000000000000000000000000000000000000000000000000000000';

const dockerfiles: Array<[string, string, Array<[string, number]>]> = [
  ['digest で固定し、非 root で動くイメージは報告しない', `FROM node:24${DIGEST}\nUSER node\n`, []],
  ['digest の無い FROM と、USER の無い最終 stage を報告する', 'FROM node:24\nRUN echo hi\n', [['docker/unpinned-base', 1], ['docker/root-user', 1]]],
  [
    '前段の stage 名と scratch は固定を求めない',
    `FROM node:24${DIGEST} AS build\nRUN echo hi\nFROM build AS test\nFROM scratch\nUSER 1000\n`,
    [],
  ],
  ['最後の USER が root なら報告する', `FROM node:24${DIGEST}\nUSER node\nUSER root\n`, [['docker/root-user', 3]]],
  ['前の stage の USER は最終 stage に引き継がない', `FROM node:24${DIGEST} AS a\nUSER node\nFROM node:24${DIGEST}\n`, [['docker/root-user', 3]]],
  ['URL からの ADD を報告する', `FROM node:24${DIGEST}\nADD https://example.test/x.tgz /x\nUSER node\n`, [['docker/remote-add', 2]]],
  [
    '継続行をつないだ RUN を、開始行の番号で報告する',
    `FROM node:24${DIGEST}\nRUN apt-get update && \\\n    curl -fsSL https://example.test/i.sh | bash\nUSER node\n`,
    [['shell/pipe-to-shell', 2]],
  ],
  [
    'イメージのビルドでは pnpm install に --frozen-lockfile を求める',
    `FROM node:24${DIGEST}\nRUN pnpm install --prod\nRUN pnpm install --frozen-lockfile\nUSER node\n`,
    [['lockfile/not-frozen', 2]],
  ],
];

describe('checkContainer: Dockerfile', () => {
  for (const [name, text, expected] of dockerfiles) {
    it(name, () => assert.deepEqual(hits('apps/api/Dockerfile', text), expected));
  }
});

const manifests: Array<[string, string, string, Array<[string, number]>]> = [
  ['k8s の privileged と hostPath を報告する', 'k8s/pod.yaml', 'spec:\n  containers:\n    - securityContext:\n        privileged: true\n  volumes:\n    - hostPath:\n        path: /\n', [['container/host-access', 4], ['container/host-access', 6]]],
  ['compose の Docker socket マウントを報告する', 'compose.yaml', 'services:\n  app:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n', [['container/host-access', 4]]],
  ['privileged: false は報告しない', 'k8s/pod.yaml', 'privileged: false\nrunAsUser: 1000\n', []],
  ['.github 配下の YAML は見ない（zizmor の担当）', '.github/workflows/ci.yml', 'privileged: true\n', []],
];

describe('checkContainer: マニフェスト', () => {
  for (const [name, rel, text, expected] of manifests) {
    it(name, () => assert.deepEqual(hits(rel, text), expected));
  }
});

const commands: Array<[string, string, 'docker' | 'ci' | 'none', string[]]> = [
  ['CI の npm install を報告する', 'npm install', 'ci', ['lockfile/not-frozen']],
  ['npm ci は報告しない', 'npm ci', 'ci', []],
  ['グローバルなツールの install は lockfile と関係ないので報告しない', 'npm install -g pnpm@10', 'ci', []],
  ['CI の pnpm install は既定で frozen なので報告しない', 'pnpm install', 'ci', []],
  ['手元のスクリプトの install は見ない', 'npm install', 'none', []],
  ['手元のスクリプトでも pipe-to-shell は報告する', 'curl -sSL https://example.test/x | sudo sh', 'none', ['shell/pipe-to-shell']],
];

describe('shellHits', () => {
  for (const [name, command, where, expected] of commands) {
    it(name, () => assert.deepEqual(shellHits(command, 1, where).map((h) => h.rule), expected));
  }
});
