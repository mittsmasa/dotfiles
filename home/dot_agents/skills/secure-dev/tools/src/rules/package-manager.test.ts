import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FileCtx } from '../walk.ts';
import { checkPackageManager } from './package-manager.ts';

function ctx(rel: string, text: string, others: Record<string, string> = {}): FileCtx {
  return { rel, text, read: (r) => (r === rel ? text : others[r]) };
}

/** [説明, ファイル, 中身, ほかのファイル, 期待する [rule, line] の一覧] */
const cases: Array<[string, string, string, Record<string, string>, Array<[string, number]>]> = [
  ['7 日以上のクールダウンは報告しない', 'pnpm-workspace.yaml', 'minimumReleaseAge: 10080\n', {}, []],
  ['クールダウンが無いと 1 行目に報告する', 'pnpm-workspace.yaml', 'packages:\n  - a\n', {}, [['cooldown/pnpm-missing', 1]]],
  ['7 日未満のクールダウンはその行に報告する', 'pnpm-workspace.yaml', 'packages: []\nminimumReleaseAge: 1440\n', {}, [['cooldown/pnpm-missing', 2]]],
  [
    'クールダウンの例外はブロックごとに 1 件にまとめる',
    'pnpm-workspace.yaml',
    'minimumReleaseAge: 10080\nminimumReleaseAgeExclude:\n  # 修正版を急ぐ\n  - foo@1.2.3\n  - bar\n',
    {},
    [['cooldown/pnpm-exclude', 4]],
  ],
  [
    'すべての install script を許す設定と、strictDepBuilds の無効化を報告する',
    'pnpm-workspace.yaml',
    'minimumReleaseAge: 10080\ndangerouslyAllowAllBuilds: true\nstrictDepBuilds: false\n',
    {},
    [['scripts/allow-all', 2], ['scripts/allow-all', 3]],
  ],
  [
    'allowBuilds で true の項目だけを候補にする',
    'pnpm-workspace.yaml',
    "minimumReleaseAge: 10080\nallowBuilds:\n  esbuild: true\n  core-js: false\n  'nx@21.6.5': true\n",
    {},
    [['scripts/allowed', 3], ['scripts/allowed', 5]],
  ],
  ['削除済みの onlyBuiltDependencies を候補にする', 'pnpm-workspace.yaml', 'minimumReleaseAge: 10080\nonlyBuiltDependencies:\n  - esbuild\n', {}, [['scripts/allowed', 2]]],
  ['renovate にクールダウンが無いと報告する', 'renovate.json', '{ "extends": ["config:recommended"] }\n', {}, [['cooldown/renovate-missing', 1]]],
  ['renovate の 7 日以上は報告しない', '.github/renovate.json5', '{\n  minimumReleaseAge: "14 days",\n}\n', {}, []],
  ['renovate の 7 日未満を報告する', 'renovate.json', '{\n  "minimumReleaseAge": "3 days"\n}\n', {}, [['cooldown/renovate-missing', 2]]],
  [
    'renovate のコメント行にある値は拾わない',
    'renovate.json5',
    '{\n  // 既定の minimumReleaseAge: "3 days" を打ち消す\n  minimumReleaseAge: "7 days",\n}\n',
    {},
    [],
  ],
  [
    'pnpm プロジェクトの .npmrc で、pnpm が読まないキーだけを報告する',
    '.npmrc',
    'registry=https://registry.example.test/\n//registry.example.test/:_authToken=${TOKEN}\n@acme:registry=https://npm.example.test/\nauto-install-peers=true\n',
    { 'pnpm-lock.yaml': '' },
    [['npmrc/pnpm-ignored-key', 4]],
  ],
  ['npm プロジェクトの .npmrc は pnpm の判定をしない', '.npmrc', 'save-exact=true\n', { 'package-lock.json': '{}' }, []],
  ['package-lock.json の隣に ignore-scripts が無いと報告する', 'package-lock.json', '{}', {}, [['scripts/npm-not-ignored', 1]]],
  ['ignore-scripts=true があれば報告しない', 'package-lock.json', '{}', { '.npmrc': 'ignore-scripts=true\n' }, []],
  ['依存のある package.json に lockfile が無いと報告する', 'apps/web/package.json', '{ "dependencies": { "a": "1.0.0" } }', {}, [['lockfile/missing', 1]]],
  ['祖先に lockfile があれば報告しない', 'apps/web/package.json', '{ "dependencies": { "a": "1.0.0" } }', { 'pnpm-lock.yaml': '' }, []],
  ['依存の無い package.json は見ない', 'package.json', '{ "name": "x" }', {}, []],
];

describe('checkPackageManager', () => {
  for (const [name, rel, text, others, expected] of cases) {
    it(name, () => {
      const hits = checkPackageManager(ctx(rel, text, others)).map((h) => [h.rule, h.line]);
      assert.deepEqual(hits, expected);
    });
  }
});
