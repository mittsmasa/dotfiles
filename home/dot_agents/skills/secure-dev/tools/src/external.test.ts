import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeGitleaks, normalizeZizmor } from './external.ts';

describe('normalizeZizmor', () => {
  it('Primary の位置を 1 始まりの行番号で返す', () => {
    const json = [
      {
        ident: 'secrets-inherit',
        desc: 'secrets unconditionally inherited by called workflow',
        determinations: { severity: 'Medium' },
        locations: [
          { symbolic: { key: { Local: { verbatim_path: '.github/workflows/a.yml' } }, kind: 'Related' }, concrete: { location: { start_point: { row: 20 } } } },
          {
            symbolic: { key: { Local: { verbatim_path: '.github/workflows/a.yml' } }, kind: 'Primary', annotation: 'this reusable workflow' },
            concrete: { location: { start_point: { row: 9 } } },
          },
        ],
      },
    ];
    assert.deepEqual(normalizeZizmor(json), [
      {
        source: 'zizmor',
        rule: 'secrets-inherit',
        severity: 'Medium',
        file: '.github/workflows/a.yml',
        line: 10,
        message: 'secrets unconditionally inherited by called workflow（this reusable workflow）',
      },
    ]);
  });
});

describe('normalizeGitleaks', () => {
  const finding = (File: string) => ({ RuleID: 'generic-api-key', Description: 'Detected a key', File, StartLine: 3, Match: 'REDACTED', Secret: 'REDACTED', Line: 'REDACTED' });

  it('値の欄を持ち出さず、root からの相対パスにする', () => {
    assert.deepEqual(normalizeGitleaks([finding('/repo/src/config.ts')], '/repo'), [
      { source: 'gitleaks', rule: 'generic-api-key', severity: 'High', file: 'src/config.ts', line: 3, message: 'Detected a key' },
    ]);
  });

  it('別の checkout や node_modules の結果を落とす', () => {
    const json = ['/repo/.worktrees/x/a.ts', '/repo/.claude/worktrees/y/a.ts', '/repo/node_modules/p/a.js'].map(finding);
    assert.deepEqual(normalizeGitleaks(json, '/repo'), []);
  });
});
