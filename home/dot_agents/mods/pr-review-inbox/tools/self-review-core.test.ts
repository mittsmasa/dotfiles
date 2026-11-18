import { expect, test } from 'claude-code/testing'

import type { Finding } from '../types'
import {
  countLine,
  defaultBranchOf,
  fixList,
  fullNameOf,
  gateDecision,
  isCovered,
  parsePrCreate,
  shellWords,
} from './self-review-core'
import type { GateFacts } from './self-review-core'

// ---- reading the command ----

test('a lone gh pr create is read with its base and repository, in each way gh takes a flag', () => {
  expect(parsePrCreate('gh pr create --base main --title "a; b"')).toEqual({ base: 'main', createsNothing: false })
  expect(parsePrCreate('gh pr create --base=develop')).toEqual({ base: 'develop', createsNothing: false })
  expect(parsePrCreate('gh pr create -B release -R org/app')).toEqual({ base: 'release', repo: 'org/app', createsNothing: false })
  expect(parsePrCreate('gh pr create -Bmain --repo=org/app')).toEqual({ base: 'main', repo: 'org/app', createsNothing: false })
  expect(parsePrCreate('GH_DEBUG=1 gh pr create')).toEqual({ createsNothing: false })
})

test('a gh pr create that creates nothing is marked so', () => {
  expect(parsePrCreate('gh pr create --dry-run')?.createsNothing).toBe(true)
  expect(parsePrCreate('gh pr create --help')?.createsNothing).toBe(true)
})

test('other gh commands, and gh pr create inside a chain, pipe or subshell, are not read as one', () => {
  expect(parsePrCreate('gh pr view 12')).toBe(undefined)
  expect(parsePrCreate('git status')).toBe(undefined)
  expect(parsePrCreate('cd app && gh pr create')).toBe(undefined)
  expect(parsePrCreate('gh pr create | cat')).toBe(undefined)
  expect(parsePrCreate('gh pr create --body "$(cat body.md)" ')).toEqual({ createsNothing: false })
  expect(parsePrCreate('gh pr create --body $(cat body.md)')).toBe(undefined)
})

test('quotes and backslashes are undone, and an unclosed quote reads as no command', () => {
  expect(shellWords(`a 'b c' "d \\"e\\"" f\\ g`)).toEqual(['a', 'b c', 'd "e"', 'f g'])
  expect(shellWords(`a ''`)).toEqual(['a', ''])
  expect(shellWords(`a "b`)).toBe(undefined)
})

// ---- which repository ----

test('the owner and name come out of ssh, scp-like and https remotes', () => {
  expect(fullNameOf('git@github.com:org/app.git')).toBe('org/app')
  expect(fullNameOf('https://github.com/org/app\n')).toBe('org/app')
  expect(fullNameOf('ssh://git@github.com/org/app.js.git')).toBe('org/app.js')
  expect(fullNameOf('/local/bare')).toBe('local/bare')
  expect(fullNameOf('not a url')).toBe(undefined)
})

test('a repository is covered by its owner or by its full name, and by nothing else', () => {
  expect(isCovered('org/app', ['org'])).toBe(true)
  expect(isCovered('org/app', ['other', 'org/app'])).toBe(true)
  expect(isCovered('org/app', ['org/web'])).toBe(false)
  expect(isCovered('orgx/app', ['org'])).toBe(false)
})

test('the default branch is read from origin/HEAD, and nothing from another remote', () => {
  expect(defaultBranchOf('origin/main\n')).toBe('main')
  expect(defaultBranchOf('upstream/main')).toBe(undefined)
  expect(defaultBranchOf('origin/')).toBe(undefined)
})

// ---- the gate ----

const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  pr: { createsNothing: false },
  fullName: 'org/app',
  sources: ['org'],
  base: 'main',
  commits: ['c3', 'c2', 'c1'],
  marked: [],
  invoke: 'node self-review.ts',
  ...over,
})

test('a branch with no result is stopped, and the reason says how to pre-read it against its base', () => {
  const decision = gateDecision(facts())

  expect(decision.kind).toBe('deny')
  expect(decision.kind === 'deny' && decision.reason).toContain('node self-review.ts prepare --base main')
  expect(decision.kind === 'deny' && decision.reason).toContain('skip --reason')
})

test('a result for HEAD, or for a commit before it on the branch, lets the pull request through', () => {
  expect(gateDecision(facts({ marked: ['c3'] }))).toEqual({ kind: 'pass' })
  expect(gateDecision(facts({ marked: ['c1'] }))).toEqual({ kind: 'pass' })
})

test('a result for a commit already in the base does not count', () => {
  expect(gateDecision(facts({ marked: ['c0'] })).kind).toBe('deny')
})

test('other commands, commands that create nothing, and repositories outside the sources pass', () => {
  expect(gateDecision(facts({ pr: undefined }))).toEqual({ kind: 'pass' })
  expect(gateDecision(facts({ pr: { createsNothing: true } }))).toEqual({ kind: 'pass' })
  expect(gateDecision(facts({ fullName: 'me/dotfiles' }))).toEqual({ kind: 'pass' })
  expect(gateDecision(facts({ fullName: undefined }))).toEqual({ kind: 'pass' })
})

test('a branch with nothing over its base passes: gh reports that itself', () => {
  expect(gateDecision(facts({ commits: [] }))).toEqual({ kind: 'pass' })
})

test('with no base to diff against, the gate stops and asks for one', () => {
  const noBase = gateDecision(facts({ base: undefined }))
  const noRef = gateDecision(facts({ commits: undefined }))

  expect(noBase.kind === 'deny' && noBase.reason).toContain('prepare --base <base>')
  expect(noRef.kind === 'deny' && noRef.reason).toContain('git fetch origin main')
})

// ---- the list of fixes ----

const finding = (over: Partial<Finding>): Finding => ({
  id: 'f1',
  severity: 'recommended',
  isUnsure: false,
  file: 'src/a.ts',
  line: 3,
  reason: 'r',
  comment: 'c',
  source: 'behavior',
  isAdopted: true,
  ...over,
})

test('the count line names every severity in order, zero included', () => {
  expect(countLine([finding({ severity: 'suggestion' }), finding({})])).toBe('blocker 0 / recommended 1 / suggestion 1')
})

test('the list puts blockers first and marks what the reviewer could not settle', () => {
  const text = fixList({
    key: 'org/app#self',
    headSha: 'abcdef0123',
    findings: [
      finding({ severity: 'suggestion', file: 'b.ts', line: undefined, reason: 'same', comment: 'same' }),
      finding({ severity: 'blocker', isUnsure: true, reason: 'breaks', comment: 'add a guard' }),
    ],
    humanReview: ['spec'],
    checked: [],
    skipped: ['PR の会話と checks（PR 作成前のため無し）'],
  })

  expect(text.indexOf('[blocker] src/a.ts:3（要確認）')).toBeLessThan(text.indexOf('[suggestion] b.ts'))
  expect(text).toContain('直し方: add a guard')
  expect(text).not.toContain('直し方: same')
  expect(text).toContain('## 人が見るべき点')
  expect(text).not.toContain('## 確かめたこと')
  expect(text).toContain('PR 作成前のため無し')
})

test('a clean result says there is nothing to fix', () => {
  const text = fixList({ key: 'org/app#self', headSha: 'abc', findings: [], humanReview: [], checked: [], skipped: [] })

  expect(text).toContain('blocker 0 / recommended 0 / suggestion 0')
  expect(text).toContain('指摘はありません。')
})
