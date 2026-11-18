import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkWorkflow } from './workflow.ts';

function hits(text: string, rel = '.github/workflows/ci.yml'): Array<[string, number]> {
  return checkWorkflow({ rel, text, read: () => undefined }).map((h) => [h.rule, h.line]);
}

const cases: Array<[string, string, Array<[string, number]>]> = [
  ['workflow レベルの env の secrets を報告する', 'on: push\nenv:\n  TOKEN: ${{ secrets.TOKEN }}\njobs: {}\n', [['ci/secrets-wide-env', 3]]],
  [
    'job レベルの env の secrets を報告する',
    'jobs:\n  build:\n    runs-on: ubuntu-latest\n    env:\n      NAME: x\n      TOKEN: ${{ secrets.TOKEN }}\n    steps: []\n',
    [['ci/secrets-wide-env', 6]],
  ],
  [
    'step レベルの env は報告しない',
    'jobs:\n  build:\n    steps:\n      - name: deploy\n        env:\n          TOKEN: ${{ secrets.TOKEN }}\n        run: ./deploy.sh\n',
    [],
  ],
  [
    'services の env は報告しない',
    'jobs:\n  build:\n    services:\n      db:\n        env:\n          PASSWORD: ${{ secrets.DB }}\n',
    [],
  ],
  [
    'env のブロックを抜けた後の secrets は env として扱わない',
    'jobs:\n  build:\n    env:\n      NAME: x\n    steps:\n      - uses: ./a\n        with:\n          token: ${{ secrets.TOKEN }}\n',
    [],
  ],
  ['run の npm install を報告する', 'jobs:\n  b:\n    steps:\n      - run: |\n          npm install\n', [['lockfile/not-frozen', 5]]],
];

describe('checkWorkflow', () => {
  for (const [name, text, expected] of cases) {
    it(name, () => assert.deepEqual(hits(text), expected));
  }
  it('workflow 以外の YAML は見ない', () => assert.deepEqual(hits('env:\n  T: ${{ secrets.T }}\n', '.github/labeler.yml'), []));
});
