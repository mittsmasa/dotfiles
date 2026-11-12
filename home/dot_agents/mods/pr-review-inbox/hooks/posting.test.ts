import { expect, test } from 'claude-code/testing'

import type { Finding, Review } from '../types'
import {
  actionsOf,
  addHumanComment,
  buildReviewPayload,
  canApprove,
  canComment,
  editComment,
  headArgs,
  parseDiffLines,
  parsePlace,
  postArgs,
  primaryOf,
  toggleAdopted,
} from './posting'

const SHA = 'a'.repeat(40)

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f1',
  severity: 'recommended',
  isUnsure: false,
  file: 'src/a.ts',
  line: 11,
  reason: 'cleanup が無い',
  comment: 'cleanup を足すのはどうでしょうか',
  source: 'criteria',
  isAdopted: true,
  ...over,
})

const review = (over: Partial<Review> = {}): Review => ({
  key: 'acme/widgets#12',
  title: 'Add a filter',
  url: 'https://github.com/acme/widgets/pull/12',
  headSha: SHA,
  baseRefName: 'main',
  files: ['src/a.ts'],
  status: 'done',
  findings: [finding()],
  humanReview: [],
  skipped: [],
  isRead: false,
  ...over,
})

// src/a.ts shows right-side lines 10, 11 (added), 12; old line 11 is removed.
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 111..222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,3 +10,3 @@ function a() {',
  ' const x = 1',
  '-const old = 2',
  '+const y = 2',
  ' return x',
  'diff --git a/src/gone.ts b/src/gone.ts',
  'deleted file mode 100644',
  '--- a/src/gone.ts',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-const a = 1',
  '-const b = 2',
  'diff --git a/src/new.ts b/src/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/new.ts',
  '@@ -0,0 +1,2 @@',
  '+export const a = 1',
  '+++ b/not-a-header.ts',
].join('\n')
const LINES = parseDiffLines(DIFF)

test('the diff gives the right-side lines of added and context rows only', async () => {
  expect(LINES).toEqual({ 'src/a.ts': [10, 11, 12], 'src/new.ts': [1, 2] })
})

test('a finding taken out is not sent, and comes back when put back', async () => {
  const out = toggleAdopted(review(), 'f1')
  expect(buildReviewPayload(out, LINES, 'APPROVE').comments).toEqual([])
  expect(buildReviewPayload(toggleAdopted(out, 'f1'), LINES, 'COMMENT').comments.length).toBe(1)
})

test('an edited comment is sent as written; an empty edit changes nothing', async () => {
  const edited = editComment(review(), 'f1', 'ここ、cleanup が要りそうです')
  expect(buildReviewPayload(edited, LINES, 'COMMENT').comments[0]?.body).toBe(
    '[recommended] ここ、cleanup が要りそうです',
  )
  expect(editComment(review(), 'f1', '   ')).toEqual(review())
})

test('a finding on a line the diff shows goes inline, on the right side of the head commit', async () => {
  const payload = buildReviewPayload(review(), LINES, 'COMMENT')
  expect(payload.commit_id).toBe(SHA)
  expect(payload.comments).toEqual([
    { path: 'src/a.ts', line: 11, side: 'RIGHT', body: 'cleanup を足すのはどうでしょうか' },
  ])
  expect(payload.body?.includes('cleanup')).toBe(false)
})

test('a finding off the diff goes into the body with its place first', async () => {
  const off = review({
    findings: [
      finding({ id: 'f1', line: 99, comment: '行が diff の外' }),
      finding({ id: 'f2', file: 'src/other.ts', line: 1, comment: 'ファイルが diff の外' }),
      finding({ id: 'f3', file: 'constructor', line: 1, comment: '名前が紛らわしいファイル' }),
    ],
  })
  const payload = buildReviewPayload(off, LINES, 'COMMENT')
  expect(payload.comments).toEqual([])
  expect(payload.body).toBe(
    'src/a.ts:99 行が diff の外\n\nsrc/other.ts:1 ファイルが diff の外\n\nconstructor:1 名前が紛らわしいファイル',
  )
})

test('a comment a person adds lands inline with a place on the diff, in the body without one', async () => {
  const placed = addHumanComment(review({ findings: [] }), { place: 'src/new.ts:2', body: 'ここ好きです' })
  const loose = addHumanComment(review({ findings: [] }), { place: '', body: '全体として読みやすいです\n2 行目' })
  if ('error' in placed || 'error' in loose) throw new Error('expected both to be added')

  expect(buildReviewPayload(placed.review, LINES, 'COMMENT').comments).toEqual([
    { path: 'src/new.ts', line: 2, side: 'RIGHT', body: 'ここ好きです' },
  ])
  const payload = buildReviewPayload(loose.review, LINES, 'COMMENT')
  expect(payload.comments).toEqual([])
  expect(payload.body).toBe('全体として読みやすいです\n2 行目')
  expect(loose.review.findings[0]?.source).toBe('human')
})

test('a comment needs a body, and a place is path:line or nothing', async () => {
  expect(addHumanComment(review(), { place: '', body: '  ' })).toEqual({ error: '本文を入力してください' })
  expect(addHumanComment(review(), { place: 'src/a.ts', body: 'x' })).toEqual({
    error: '場所は path:line の形で入力してください',
  })
  expect(parsePlace('src/a.ts:0')).toBe('invalid')
  expect(parsePlace(' src/a.ts:12 ')).toEqual({ file: 'src/a.ts', line: 12 })
  expect(parsePlace('')).toBe(undefined)
})

test('the event sent is the one asked for', async () => {
  expect(buildReviewPayload(review(), LINES, 'COMMENT').event).toBe('COMMENT')
  expect(buildReviewPayload(review(), LINES, 'APPROVE').event).toBe('APPROVE')
})

test('a comment review always has a body; an approval with nothing to say has none', async () => {
  expect(buildReviewPayload(review(), LINES, 'COMMENT').body).toBe('インラインコメントを参照してください。')
  expect('body' in buildReviewPayload(review(), LINES, 'APPROVE')).toBe(false)
  expect('body' in buildReviewPayload(review({ findings: [] }), LINES, 'APPROVE')).toBe(false)
})

test('approving is offered only with no blocker still adopted', async () => {
  const blocked = review({ findings: [finding({ severity: 'blocker' })] })
  expect(canApprove(blocked)).toBe(false)
  expect(canApprove(toggleAdopted(blocked, 'f1'))).toBe(true)
  expect(canApprove(review({ findings: [] }))).toBe(true)
  expect(canApprove(review())).toBe(true)
  expect(canApprove(review({ status: 'reviewing' }))).toBe(false)
  expect(canApprove(review({ postedAt: '2026-11-09T01:00:00.000Z', postedEvent: 'COMMENT' }))).toBe(false)
})

test('a comment review is offered only with something adopted', async () => {
  expect(canComment(review())).toBe(true)
  expect(canComment(toggleAdopted(review(), 'f1'))).toBe(false)
  expect(canComment(review({ findings: [] }))).toBe(false)
  expect(canComment(review({ status: 'failed' }))).toBe(false)
})

test('the send controls follow what the review can still do', async () => {
  expect(actionsOf(review(), true)).toEqual(['comment', 'approve'])
  expect(actionsOf(review({ findings: [finding({ severity: 'blocker' })] }), true)).toEqual(['comment'])
  // Nothing adopted: nothing to comment, but an approval can still go.
  expect(actionsOf(review({ findings: [] }), true)).toEqual(['approve'])
  expect(actionsOf(review(), false)).toEqual(['rereview'])
  expect(actionsOf(review({ status: 'queued' }), true)).toEqual([])
  const sent = { postedAt: '2026-11-09T01:00:00.000Z' }
  expect(actionsOf(review({ ...sent, postedEvent: 'COMMENT' }), true)).toEqual(['posted'])
  expect(actionsOf(review({ ...sent, postedEvent: 'APPROVE' }), true)).toEqual(['approved'])
  expect(actionsOf(review({ ...sent, postedEvent: 'APPROVE' }), false)).toEqual(['approved'])
})

test('one control is the main one: commenting before approving', async () => {
  expect(primaryOf(['comment', 'approve'])).toBe('comment')
  expect(primaryOf(['approve'])).toBe('approve')
  expect(primaryOf(['rereview'])).toBe(undefined)
  expect(primaryOf([])).toBe(undefined)
})

test('the request goes to the pull request the key names', async () => {
  expect(postArgs('acme/widgets#12', '/data/p.json')).toEqual([
    'gh', 'api', '--method', 'POST', 'repos/acme/widgets/pulls/12/reviews', '--input', '/data/p.json',
  ])
  expect(headArgs('acme/widgets#12')).toEqual([
    'gh', 'pr', 'view', '12', '-R', 'acme/widgets', '--json', 'headRefOid',
  ])
  expect(postArgs('not a key', '/data/p.json')).toBe(undefined)
})
