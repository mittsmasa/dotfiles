import { expect, test } from 'claude-code/testing'

import {
  expandArgv,
  failureOf,
  globToRegExp,
  parseProfile,
  pickViewpointFiles,
  resolveViewpoints,
  summarizeChecks,
  warningLine,
} from './profile'
import type { Check, ViewpointFs } from './profile'

const HOME = '/Users/me'

test('with no review section, the reviewer gets no viewpoint files, the generic guide and no checks', () => {
  const { profile, warnings } = parseProfile(undefined, HOME)

  expect(profile.viewpoints).toEqual([])
  expect(profile.guide).toEqual({ kind: 'generic' })
  expect(profile.checks).toEqual([])
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

  expect(profile.guide).toEqual({ kind: 'generic' })
  expect(profile.viewpoints).toEqual([])
  expect(profile.commentStyle).toBe(undefined)
  expect(profile.checks).toEqual([])
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

/**
 * A file system made from a list of file paths; `links` maps a link's path
 * to the directory it points at.
 */
function fakeFs(filePaths: readonly string[], links: Record<string, string> = {}): ViewpointFs {
  const real = (path: string) => {
    for (const [link, target] of Object.entries(links)) {
      if (path === link || path.startsWith(`${link}/`)) return target + path.slice(link.length)
    }

    return path
  }
  const isDir = (path: string) => filePaths.some(file => file.startsWith(`${path}/`))

  return {
    list: async dir => {
      const inside = real(dir)
      const names = new Set<string>()
      for (const file of filePaths) if (file.startsWith(`${inside}/`)) names.add(file.slice(inside.length + 1).split('/')[0] as string)
      for (const link of Object.keys(links)) if (link.startsWith(`${dir}/`) && !link.slice(dir.length + 1).includes('/')) names.add(link.slice(dir.length + 1))

      return [...names].map(name => {
        const path = `${dir}/${name}`
        if (path in links) return { name, kind: 'other' as const, isLink: true }

        return { name, kind: isDir(`${inside}/${name}`) ? ('dir' as const) : ('file' as const), isLink: false }
      })
    },
    stat: async path => {
      const target = real(path)
      if (filePaths.includes(target)) return { kind: 'file' }
      if (isDir(target)) return { kind: 'dir' }
      throw new Error('ENOENT')
    },
  }
}

const skill = [
  '/s/testable-design/SKILL.md',
  '/s/testable-design/references/test-quality.md',
  '/s/testable-design/references/frontend-testing.md',
  '/s/testable-design/tools/bin/testable-scan.ts',
  '/s/testable-design/.cache/old.md',
  '/s/review/SKILL.md',
]

test('a glob reads every matching file under a skill, references included, in path order', async () => {
  const { files, warnings } = await resolveViewpoints(['/s/testable-design/**/*.md'], fakeFs(skill))

  expect(files).toEqual([
    '/s/testable-design/SKILL.md',
    '/s/testable-design/references/frontend-testing.md',
    '/s/testable-design/references/test-quality.md',
  ])
  expect(warnings).toEqual([])
})

test('plain paths and globs keep the config order, and a file named twice stays where it first appears', async () => {
  const { files } = await resolveViewpoints(
    ['/s/review/SKILL.md', '/s/testable-design/SKILL.md', '/s/testable-design/**/*.md'],
    fakeFs(skill),
  )

  expect(files).toEqual([
    '/s/review/SKILL.md',
    '/s/testable-design/SKILL.md',
    '/s/testable-design/references/frontend-testing.md',
    '/s/testable-design/references/test-quality.md',
  ])
})

test('* and {a,b} stay inside one segment', async () => {
  const fs = fakeFs(skill)

  expect((await resolveViewpoints(['/s/*/SKILL.md'], fs)).files).toEqual(['/s/review/SKILL.md', '/s/testable-design/SKILL.md'])
  expect((await resolveViewpoints(['/s/testable-design/references/{test-quality,missing}.md'], fs)).files).toEqual([
    '/s/testable-design/references/test-quality.md',
  ])
})

test('a glob reaches files through a linked skill directory', async () => {
  const fs = fakeFs(skill, { '/home/.claude/skills/testable-design': '/s/testable-design' })
  const { files } = await resolveViewpoints(['/home/.claude/skills/*/references/*.md'], fs)

  expect(files).toEqual([
    '/home/.claude/skills/testable-design/references/frontend-testing.md',
    '/home/.claude/skills/testable-design/references/test-quality.md',
  ])
})

test('a glob that matches nothing is named; a plain directory is still refused', async () => {
  const { files, warnings } = await resolveViewpoints(['/s/nothing/**/*.md', '/s/review'], fakeFs(skill))

  expect(files).toEqual([])
  expect(warnings).toEqual([
    'review.viewpoints の /s/nothing/**/*.md に合うファイルが無い',
    'review.viewpoints の /s/review はファイルではない',
  ])
})

test('globToRegExp: ** spans directories, including none', () => {
  const matcher = globToRegExp('/a/**/*.md')

  expect(matcher.test('/a/x.md')).toBe(true)
  expect(matcher.test('/a/b/c/x.md')).toBe(true)
  expect(matcher.test('/a/b/x.ts')).toBe(false)
  expect(matcher.test('/ab/x.md')).toBe(false)
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

const absolute: Check = { name: 'oxlint', argv: ['oxlint', '{files}'], outputs: [] }
const relative: Check = { name: 'scan', argv: ['scan', '{worktree}', '{relativeFiles}'], outputs: [] }
const whole: Check = { name: 'secure-scan', argv: ['node', 'secure-scan.ts', '{worktree}', '--out', '{outDir}'], outputs: ['findings.json'] }

test('with no script to check, a check handed {files} or {relativeFiles} is left out and one given only {worktree} runs', () => {
  expect(checksToRun([absolute, whole, relative], 0)).toEqual({
    run: [whole],
    skipped: ['oxlint（対象の JS / TS ファイルなし）', 'scan（対象の JS / TS ファイルなし）'],
  })
})

test('with a script to check, every check runs in the order set', () => {
  expect(checksToRun([absolute, whole, relative], 1)).toEqual({ run: [absolute, whole, relative], skipped: [] })
})

test('a check that ran fails only when an output it names is missing, whatever its exit code', () => {
  // A lint that found something: non-zero, output written.
  expect(failureOf({ exitCode: 1, stderr: '' }, [])).toBe(undefined)
  expect(failureOf({ exitCode: 0, stderr: '' }, ['candidates.json'])).toBe('出力が無い: candidates.json')
  expect(failureOf({ exitCode: 2, stderr: 'Error: no tsconfig\n  at x' }, ['ir.json'])).toBe('Error: no tsconfig')
})
