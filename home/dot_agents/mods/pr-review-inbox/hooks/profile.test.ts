import { expect, test } from 'claude-code/testing'

import {
  defaultChecks,
  expandArgv,
  failureOf,
  parseProfile,
  pickViewpointFiles,
  SKILL_FILES,
  summarizeChecks,
  warningLine,
} from './profile'
import type { Check } from './profile'

const HOME = '/Users/me'

test('with no review section, the reviewer reads the testable-design files and runs the default checks', () => {
  const { profile, warnings } = parseProfile(undefined, HOME)

  expect(profile.viewpoints).toEqual(SKILL_FILES.map(file => `${HOME}/.agents/skills/testable-design/${file}`))
  expect(profile.guide).toEqual({ kind: 'testable-design' })
  expect(profile.checks).toBe(undefined)
  expect(profile.commentStyle).toBe(undefined)
  expect(warnings).toEqual([])
})

test('viewpoints set without a guide get the generic guide; a guide file wins over it', () => {
  const generic = parseProfile({ viewpoints: ['~/team/a.md'] }, HOME).profile
  expect(generic.viewpoints).toEqual([`${HOME}/team/a.md`])
  expect(generic.guide).toEqual({ kind: 'generic' })
  expect(parseProfile({ viewpoints: ['~/team/a.md'], guide: '~/team/guide.md' }, HOME).profile.guide).toEqual({
    kind: 'file',
    path: `${HOME}/team/guide.md`,
  })
})

test('a broken check is dropped and named on one line; the good one stays', () => {
  const { profile, warnings } = parseProfile(
    {
      checks: [
        { argv: ['echo', '{files}'] },
        { name: 'bad', argv: 'echo {files}' },
        { name: 'echo', argv: ['echo', '{files}'], stdout: 'echo.txt' },
      ],
    },
    HOME,
  )

  expect(profile.checks?.map(check => check.name)).toEqual(['echo'])
  expect(warnings.length).toBe(2)
  const line = warningLine(warnings) ?? ''
  expect(line.startsWith('設定の誤り: ')).toBe(true)
  expect(line.includes('\n')).toBe(false)
})

test('a check may only write plain file names into the output directory', () => {
  const { profile, warnings } = parseProfile(
    { checks: [{ name: 'x', argv: ['x'], stdout: '../../.zshrc' }, { name: 'y', argv: ['y'], outputs: ['a/b.json'] }] },
    HOME,
  )

  expect(profile.checks).toEqual([])
  expect(warnings.length).toBe(2)
})

test('an item of the review section that does not read falls back to its default', () => {
  const { profile, warnings } = parseProfile({ viewpoints: 'SKILL.md', commentStyle: 3, checks: {} }, HOME)

  expect(profile.guide).toEqual({ kind: 'testable-design' })
  expect(profile.viewpoints.length).toBe(SKILL_FILES.length)
  expect(profile.commentStyle).toBe(undefined)
  expect(profile.checks).toBe(undefined)
  expect(warnings.length).toBe(3)
})

test('a viewpoint that is a directory is dropped and named; a missing one is left out quietly', () => {
  const { files, warnings } = pickViewpointFiles([
    { path: '/team/a.md', kind: 'file' },
    { path: '/team/skill', kind: 'dir' },
    { path: '/team/gone.md' },
  ])

  expect(files).toEqual(['/team/a.md'])
  expect(warnings).toEqual(['review.viewpoints の /team/skill はファイルではない'])
})

test('{files} becomes one argument per file and an argument holding a value is never split', () => {
  const argv = expandArgv(['oxlint', '-f', 'json', '{files}', '--out={outDir}/x y'], {
    files: ['/w/src/a b.ts', '/w/src/c.ts'],
    worktree: '/w',
    outDir: '/scan',
  })

  expect(argv).toEqual(['oxlint', '-f', 'json', '/w/src/a b.ts', '/w/src/c.ts', '--out=/scan/x y'])
})

test('{relativeFiles} start with ./, so a file named like an option stays a file', () => {
  const argv = expandArgv(['scan', '{worktree}', '{relativeFiles}'], { files: ['/w/-x.ts', '/w/src/a.ts'], worktree: '/w', outDir: '/o' })

  expect(argv).toEqual(['scan', '/w', './-x.ts', './src/a.ts'])
})

test('the default checks run oxlint and testable-scan from the skill with the binaries given', () => {
  const [oxlint, scan] = defaultChecks({ oxlint: '/bin/oxlint', node: '/bin/node' }, '/skill')

  expect(oxlint).toEqual({
    name: 'oxlint',
    argv: ['/bin/oxlint', '-c', '/skill/tools/oxlintrc.json', '-f', 'json', '{files}'],
    stdout: 'oxlint.json',
    outputs: [],
  })
  expect(scan?.argv).toEqual(['/bin/node', '/skill/tools/bin/testable-scan.ts', '{worktree}', '{relativeFiles}', '--out', '{outDir}'])
  expect(scan?.outputs).toEqual(['candidates.json', 'ir.json'])
})

const lint: Check = { name: 'oxlint', argv: ['oxlint'], stdout: 'oxlint.json', outputs: [] }
const scan: Check = { name: 'testable-scan', argv: ['node'], outputs: ['candidates.json', 'ir.json'] }

test('every check that ran is listed with what it wrote', () => {
  expect(summarizeChecks([{ check: lint }, { check: scan }])).toEqual({
    skipped: [],
    outputs: [
      { name: 'oxlint', files: ['oxlint.json'] },
      { name: 'testable-scan', files: ['candidates.json', 'ir.json'] },
    ],
  })
})

test('a check that failed is named in skipped and only its output leaves the list', () => {
  expect(summarizeChecks([{ check: lint, failure: 'spawn ENOENT' }, { check: scan }])).toEqual({
    skipped: ['oxlint（spawn ENOENT）'],
    outputs: [{ name: 'testable-scan', files: ['candidates.json', 'ir.json'] }],
  })
})

test('a check that ran fails only when an output it names is missing, whatever its exit code', () => {
  // A lint that found something: non-zero, output written.
  expect(failureOf({ exitCode: 1, stderr: '' }, [])).toBe(undefined)
  expect(failureOf({ exitCode: 0, stderr: '' }, ['candidates.json'])).toBe('出力が無い: candidates.json')
  expect(failureOf({ exitCode: 2, stderr: 'Error: no tsconfig\n  at x' }, ['ir.json'])).toBe('Error: no tsconfig')
})
