// Runs the mod against the engine: which session runs the inbox, what a
// subagent may do in each, and what the pane and the band draw. A tree a
// surface refuses fails here, before anyone has to look at it.
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { Finding, Review } from '../types'

const KEY = 'acme/widgets#12'
const SHA = 'a'.repeat(40)
const HOUR = 60 * 60 * 1000
const DATA = '/Users/me/.cache/pr-review-inbox'
const SAVED = `${DATA}/results/acme/widgets/12/${SHA}`
const DIFF_PATH = `${DATA}/diffs/acme/widgets/12/${SHA}.diff`
const CONFIG_PATH = '/Users/me/.config/pr-review-inbox/config.json'
const CONFIG_TEXT = JSON.stringify({ repos: { 'acme/widgets': '~/src/widgets' } })
const PANE = {
  plugin: 'pr-review-inbox',
  component: 'Pane',
  requestId: 'review-inbox',
  props: {
    title: 'PR レビュー',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const
const BAND = {
  plugin: 'pr-review-inbox',
  component: 'AbovePrompt',
  surface: 'desktop',
  props: { hasSurvey: false },
} as never

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: 'f1',
  severity: 'blocker',
  isUnsure: false,
  file: 'web/src/components/orders/order-list.tsx',
  line: 11,
  reason: '合計の丸め方が表示側と合わない',
  comment: '丸めを 1 か所に寄せるのはどうでしょうか',
  source: 'criteria',
  criteriaId: 'R-1',
  isAdopted: true,
  ...over,
})

const review = (over: Partial<Review> = {}): Review => ({
  key: KEY,
  title: '注文一覧に絞り込みを追加',
  url: 'https://github.com/acme/widgets/pull/12',
  headSha: SHA,
  baseRefName: 'main',
  files: [],
  status: 'done',
  verdict: 'needs-fix',
  findings: [finding()],
  humanReview: ['観点 1', '観点 2', '観点 3'],
  skipped: [],
  isRead: false,
  ...over,
})

const DIFF = [
  'diff --git a/x b/x',
  '--- a/web/src/components/orders/order-list.tsx',
  '+++ b/web/src/components/orders/order-list.tsx',
  '@@ -10,2 +10,2 @@',
  ' const a = 1',
  '+const b = 2',
].join('\n')

/**
 * The engine beneath the mod: a Monday 11:00 JST, a store holding `reviews`,
 * and a gh whose search lists every stored review at its stored head.
 */
function world(
  on: On,
  reviews: Review[],
  more: Record<string, unknown> = {},
  // The mod's data folder, path to text. Left out, every file exists and reads as DIFF.
  files?: Record<string, string>,
  // The config file's text; null for no config file.
  config: string | null = CONFIG_TEXT,
) {
  const store = new Map<string, unknown>(
    Object.entries({ inbox: { reviews, lastFetchedAt: '2026-11-09T01:17:00.000Z' }, ...more }),
  )
  const calls = {
    search: 0,
    run: 0,
    register: 0,
    spawn: 0,
    open: [] as unknown[],
    writes: [] as string[],
    argv: [] as (readonly string[])[],
  }
  const clock = mock.clock(on, { now: Date.UTC(2026, 10, 9, 2, 0) })
  mock.env(on, { HOME: '/Users/me' })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)

    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-a' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'review-inbox' } }))
  on('agent.register', () => {
    calls.register += 1

    return { value: { agent: 'pr-review-inbox:reviewer' } }
  })
  on('ui.open', (_, e) => {
    calls.open.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  // Counts the reviewers asked for. The kit hands a mod no agentId for a spawn,
  // so a review started here ends as failed; what a result does once accepted
  // is covered by the pure functions in reviews.test.ts.
  on('agent.spawn', () => {
    calls.spawn += 1

    return { model: 'test', agentId: `reviewer-${calls.spawn}` }
  })
  on('turn.complete', () => ({ text: '' }) as never)
  on('fs.exists', (_, e) => ({ value: !files || !e.path.startsWith(DATA) || e.path in files }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', isLink: false, realPath: e.path } }) as never)
  on('fs.read', (_, e) => {
    if (e.path === CONFIG_PATH) {
      if (config === null) throw new Error('ENOENT')

      return { value: config }
    }
    if (!files) return { value: DIFF }
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', (_, e) => {
    calls.writes.push(e.path)

    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_, e) => {
    calls.run += 1
    const argv = (e as { argv?: readonly string[] }).argv ?? []
    calls.argv.push(argv)
    // rm really forgets a file, so what is read afterwards is what was left.
    if (files && argv[0] === 'rm') for (const path of argv.slice(2)) delete files[path]
    if (argv.includes('search')) calls.search += 1
    const stdout = argv.includes('search')
      ? JSON.stringify(
          reviews.map(one => ({
            number: Number(one.key.split('#')[1]),
            title: one.title,
            url: one.url,
            repository: { nameWithOwner: one.key.split('#')[0] },
          })),
        )
      : argv.includes('view')
        ? JSON.stringify({
            headRefOid: SHA,
            baseRefName: 'main',
            files: [],
            // Each pull request's own description, as stored.
            body: reviews.find(one => one.key === `${argv[5]}#${argv[3]}`)?.body ?? null,
          })
        : argv.includes('get-url')
          ? 'git@github.com:acme/widgets.git'
          : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { clock, calls, store }
}

type Engine = Parameters<TestBody>[0]

async function load($: Engine) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

/** Types /review-inbox in this session and lets the first fetch run. */
async function begin($: Engine, clock: { advance: (ms: number) => Promise<void> }) {
  await load($)
  await $.command.run({ command: 'review-inbox', args: '' } as never)
  await clock.advance(1000)
}

const subagentBash = (agentId: string) => ({ tool: 'Bash', command: 'ls', agentId }) as never

// ---- which session runs the inbox ----

test('a session that only loaded the mod does nothing', async ($, on) => {
  const { clock, calls } = world(on, [review()])
  await load($)
  await clock.advance(2 * HOUR)

  expect(calls.run).toBe(0)
  expect(calls.register).toBe(0)
  expect(calls.open).toEqual([])

  const band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'open-pane' })).toBe(undefined)
  await band.unmount()
})

test('a session that only loaded the mod leaves subagents alone', async ($, on) => {
  world(on, [review()])
  await load($)

  expect((await $.tool.call(subagentBash('someone-elses-agent'))).deny).toBe(undefined)
})

test('typing /review-inbox makes this session the one running the inbox', async ($, on) => {
  const { clock, calls, store } = world(on, [review()], { owner: { sessionId: 'session-b' } })
  await begin($, clock)

  expect(store.get('owner')).toEqual({ sessionId: 'session-a' })
  expect(calls.register).toBe(1)
  expect(calls.open.length).toBe(1)
  expect(calls.search).toBe(1)
})

test('typing /review-inbox again starts nothing twice', async ($, on) => {
  const { clock, calls } = world(on, [review()])
  await begin($, clock)
  await $.command.run({ command: 'review-inbox', args: '' } as never)
  await clock.advance(1000)

  expect(calls.register).toBe(1)
  expect(calls.search).toBe(1)
  // One hourly timer, not two.
  await clock.advance(HOUR)
  expect(calls.search).toBe(2)
})

test('a session picks the inbox up again when it starts while marked as running it', async ($, on) => {
  const { clock, calls } = world(on, [review()])
  await begin($, clock)
  const opened = calls.open.length

  await load($)
  await clock.advance(1000)

  expect(calls.open.length).toBe(opened + 1)
  expect(calls.register).toBe(1)
  await clock.advance(HOUR)
  expect(calls.search).toBe(2)
})

test('a session stops by itself once another has taken the inbox', async ($, on) => {
  const { clock, calls, store } = world(on, [review()])
  await begin($, clock)
  store.set('owner', { sessionId: 'session-b' })

  await clock.advance(HOUR)
  expect(calls.search).toBe(1)
  await clock.advance(HOUR)
  expect(calls.search).toBe(1)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /#12/ })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /受付をしていません/ })).toBeDefined()
  await pane.unmount()
  const band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'open-pane' })).toBe(undefined)
  await band.unmount()
})

test('taking the inbox over cuts off the review the last session left running', async ($, on) => {
  const left = review({ status: 'reviewing', agentId: 'reviewer-of-b', findings: [], verdict: undefined })
  const waiting = review({ key: 'acme/widgets#13', status: 'queued', findings: [], verdict: undefined })
  const { clock } = world(on, [left, waiting], { owner: { sessionId: 'session-b' } })
  await begin($, clock)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /失敗: 中断/ })).toBeDefined()
  // The queue moved on: the one that was waiting is no longer waiting.
  expect(await pane.find({ type: 'Text', text: /待機中/ })).toBe(undefined)
  await pane.unmount()
})

// ---- what a subagent may do ----

test('a reviewer this mod spawned stays refused in a session not running the inbox', async ($, on) => {
  world(on, [review()], { reviewerAgentIds: ['old-reviewer'] })
  await load($)

  expect(typeof (await $.tool.call(subagentBash('old-reviewer'))).deny).toBe('string')
  expect((await $.tool.call(subagentBash('someone-elses-agent'))).deny).toBe(undefined)
})

test('the session running the inbox refuses every subagent that is not its reviewer', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  expect(typeof (await $.tool.call(subagentBash('someone-elses-agent'))).deny).toBe('string')
  // The main loop is never touched.
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' } as never)).deny).toBe(undefined)
})

// ---- what the pane and the band draw ----

test('the pane lists a review, opens its findings, and offers what it can send', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /#12/ }))?.text).toBe('#12')
    expect((await ui.find({ type: 'Text', text: /要修正/ }))?.text).toBe('要修正')
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  // Closed: the file name and line lead; the text to post is not drawn yet.
  expect((await ui.find({ type: 'Text', text: /order-list\.tsx:11/ }))?.text).toBe('order-list.tsx:11')
  expect(await ui.find({ type: 'Text', text: /丸めを/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /観点 3/ })).toBe(undefined)
  // A blocker is adopted: a comment review can go, an approval cannot.
  expect(await ui.find({ key: 'comment' })).toBeDefined()
  expect(await ui.find({ key: 'approve' })).toBe(undefined)

  await ui.press({ key: 'open:f1' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /丸めを/ }))?.text).toBe('丸めを 1 か所に寄せるのはどうでしょうか')
  expect((await ui.find({ type: 'Text', text: /components\/orders/ }))?.text).toBe('…/components/orders')

  // Taken out: nothing left to comment on, and the approval is offered.
  await ui.press({ key: 'toggle:f1' })
  await clock.settle()
  expect(await ui.find({ key: 'comment' })).toBe(undefined)
  expect(await ui.find({ key: 'approve' })).toBeDefined()

  await ui.press({ key: 'more-points' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /観点 3/ })).toBeDefined()
  await ui.unmount()
})

test('the confirm screen shows the request, and going back sends nothing', async ($, on) => {
  const { clock, calls } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'comment' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /送信の確認/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /COMMENT レビューを送ります/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /丸めを/ }))?.text).toBe(
    '[recommended] 丸めを 1 か所に寄せるのはどうでしょうか',
  )
  expect(await ui.find({ key: 'send' })).toBeDefined()

  await ui.press({ key: 'back' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /送信の確認/ })).toBe(undefined)
  // The request body is written only when it is sent.
  expect(calls.writes.filter(path => path.includes('/payloads/'))).toEqual([])
  await ui.unmount()
})

test('pressing the band opens the pane', async ($, on) => {
  const { clock, calls } = world(on, [review()])
  await begin($, clock)
  const before = calls.open.length

  const ui = await $.ui.mount(BAND)
  await ui.press({ key: 'open-pane' })
  await clock.settle()

  expect(calls.open.length).toBe(before + 1)
  expect((calls.open.at(-1) as { id?: string; focus?: boolean }).id).toBe('review-inbox')
  expect((calls.open.at(-1) as { id?: string; focus?: boolean }).focus).toBe(true)
  await ui.unmount()
})

// ---- reusing a result, and keeping what was sent ----

const waiting = () => review({ status: 'queued', findings: [], verdict: undefined, humanReview: [] })
const result = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    key: KEY,
    headSha: SHA,
    findings: [{ severity: 'blocker', reason: '基準が合わない', comment: '直すのはどうでしょうか' }],
    humanReview: [],
    ...over,
  })
const isWorktreeAdd = (argv: readonly string[]) => argv.includes('worktree') && argv.includes('add')
const RM_SAVED = ['rm', '-f', `${SAVED}.json`, `${SAVED}.accepted.json`, `${SAVED}.posted.json`]

test('a waiting review takes the result accepted for the same commit, with no reviewer', async ($, on) => {
  const { clock, calls } = world(on, [waiting()], {}, {
    [`${SAVED}.accepted.json`]: result(),
    [DIFF_PATH]: DIFF,
  })
  await begin($, clock)
  await clock.settle()

  expect(calls.spawn).toBe(0)
  expect(calls.argv.filter(isWorktreeAdd)).toEqual([])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /要修正/ }))?.text).toBe('要修正')
  await pane.unmount()
})

test('a result that was sent comes back as sent', async ($, on) => {
  const { clock, calls } = world(on, [waiting()], {}, {
    [`${SAVED}.accepted.json`]: result({ findings: [] }),
    [`${SAVED}.posted.json`]: JSON.stringify({ postedAt: '2026-11-09T01:00:00.000Z', postedEvent: 'APPROVE' }),
    [DIFF_PATH]: DIFF,
  })
  await begin($, clock)
  await clock.settle()

  expect(calls.spawn).toBe(0)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `row:${KEY}` })
  await clock.settle()
  expect(await pane.find({ key: 'approve' })).toBe(undefined)
  expect(await pane.find({ key: 'comment' })).toBe(undefined)
  await pane.unmount()
})

test("a reviewer's own file is never reused: only the accepted copy is", async ($, on) => {
  const { clock, calls } = world(on, [waiting()], {}, { [`${SAVED}.json`]: result(), [DIFF_PATH]: DIFF })
  await begin($, clock)
  await clock.settle()

  expect(calls.spawn).toBe(1)
})

test('an accepted copy for another commit is not reused', async ($, on) => {
  const { clock, calls } = world(on, [waiting()], {}, {
    [`${SAVED}.accepted.json`]: result({ headSha: 'b'.repeat(40) }),
    [DIFF_PATH]: DIFF,
  })
  await begin($, clock)
  await clock.settle()

  expect(calls.spawn).toBe(1)
})

test('an accepted copy without its diff is not reused', async ($, on) => {
  const { clock, calls } = world(on, [waiting()], {}, { [`${SAVED}.accepted.json`]: result() })
  await begin($, clock)
  await clock.settle()

  expect(calls.spawn).toBe(1)
})

test('やり直す forgets the saved results before reviewing again', async ($, on) => {
  const failed = review({ status: 'failed', failReason: 'タイムアウト', findings: [], verdict: undefined })
  const { clock, calls } = world(on, [failed], {}, { [`${SAVED}.accepted.json`]: result(), [DIFF_PATH]: DIFF })
  await begin($, clock)
  await clock.settle()
  expect(calls.spawn).toBe(0)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `row:${KEY}` })
  await clock.settle()
  await pane.press({ key: 'retry' })
  await clock.settle()
  await pane.unmount()

  expect(calls.argv.filter(argv => argv[0] === 'rm' && argv.length === 5)).toEqual([RM_SAVED])
  // Back in the queue and picked up: the old copy was not what filled it.
  expect(calls.spawn).toBe(1)
})

test('再レビュー forgets the saved results before reviewing again', async ($, on) => {
  // Done, with the diff gone: the pane offers 再レビュー in place of sending.
  const { clock, calls } = world(on, [review()], {}, { [`${SAVED}.accepted.json`]: result() })
  await begin($, clock)
  await clock.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `row:${KEY}` })
  await clock.settle()
  await pane.press({ key: 'rereview' })
  await clock.settle()
  await pane.unmount()

  expect(calls.argv.filter(argv => argv[0] === 'rm' && argv.length === 5)).toEqual([RM_SAVED])
  expect(calls.spawn).toBe(1)
})

test('sending a review leaves a note beside its result', async ($, on) => {
  const { clock, calls } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)
  const notes = () => calls.writes.filter(path => path.endsWith('.posted.json'))

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `row:${KEY}` })
  await clock.settle()
  await pane.press({ key: 'comment' })
  await clock.settle()
  expect(notes()).toEqual([])

  await pane.press({ key: 'send' })
  await clock.settle()
  expect(notes()).toEqual([`${SAVED}.posted.json`])
  expect(await pane.find({ key: 'comment' })).toBe(undefined)
  await pane.unmount()
})

// ---- sending takes an approved review off the list ----

/** Selects the review, presses one send control, and sends what the confirm screen shows. */
async function sendFrom(
  ui: { press: (target: { key: string }) => Promise<unknown> },
  clock: { settle: () => Promise<void> },
  control: string,
) {
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: control })
  await clock.settle()
  await ui.press({ key: 'send' })
  await clock.settle()
}

test('APPROVE 送信後、その PR が一覧に出ない', async ($, on) => {
  const { clock } = world(on, [review({ findings: [finding({ severity: 'recommended' })], body: '本文です' })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await sendFrom(ui, clock, 'approve')

  expect(await ui.find({ type: 'Text', text: /#12/ })).toBe(undefined)
  // The selection went with it: no detail is drawn.
  expect(await ui.find({ key: 'body' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^概要$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /レビュー待ちはありません/ })).toBeDefined()
  await ui.unmount()
})

test('COMMENT 送信後は一覧に残る', async ($, on) => {
  const { clock } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await sendFrom(ui, clock, 'comment')

  expect((await ui.find({ type: 'Text', text: /#12/ }))?.text).toBe('#12')
  expect((await ui.find({ type: 'Text', text: /送信済み/ }))?.text).toMatch(/^送信済み/)
  await ui.unmount()
})

// ---- what the selected review shows ----

const OTHER = 'acme/widgets#13'
const lines = (count: number) => Array.from({ length: count }, (_, index) => `行 ${index + 1}`).join('\n')

test('選択行の Box に borderStyle があり、未選択行には無い', async ($, on) => {
  const { clock } = world(on, [review(), review({ key: OTHER, url: 'https://github.com/acme/widgets/pull/13' })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ key: `row-box:${KEY}` }))?.props.borderStyle).toBe(undefined)
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect((await ui.find({ key: `row-box:${KEY}` }))?.props.borderStyle).toBe('round')
  expect((await ui.find({ key: `row-box:${OTHER}` }))?.props.borderStyle).toBe(undefined)
  await ui.unmount()
})

test('選択時に概要 Markdown が出る', async ($, on) => {
  const { clock } = world(on, [review({ body: '## 背景\n絞り込みが欲しいという要望' })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'body' })).toBe(undefined)
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  const body = await ui.find({ key: 'body' })
  expect(body?.type).toBe('Markdown')
  expect(body?.props.text).toBe('## 背景\n絞り込みが欲しいという要望')
  expect(await ui.find({ key: 'more-body' })).toBe(undefined)
  await ui.unmount()
})

test('13 行の本文で『続きを表示』が出て、押すと全文が出る', async ($, on) => {
  const { clock } = world(on, [review({ body: lines(13) })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  expect((await ui.find({ key: 'body' }))?.props.text).toBe(lines(12))

  await ui.press({ key: 'more-body' })
  await clock.settle()
  expect((await ui.find({ key: 'body' }))?.props.text).toBe(lines(13))
  expect(await ui.find({ key: 'more-body' })).toBe(undefined)
  await ui.unmount()
})

test('展開後に別の PR を選ぶと折りたたみに戻る', async ($, on) => {
  const { clock } = world(on, [
    review({ body: lines(13) }),
    review({ key: OTHER, url: 'https://github.com/acme/widgets/pull/13', body: lines(20) }),
  ])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'more-body' })
  await clock.settle()
  await ui.press({ key: `row:${OTHER}` })
  await clock.settle()

  expect((await ui.find({ key: 'body' }))?.props.text).toBe(lines(12))
  expect(await ui.find({ key: 'more-body' })).toBeDefined()
  await ui.unmount()
})

test('body が無い PR で『本文なし』が出る', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect(await ui.find({ key: 'body' })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /本文なし/ }))?.text).toBe('本文なし')
  await ui.unmount()
})

test('指摘行のタグに blocker 等の severity が出る', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^blocker/ }))?.text).toBe('blocker · R-1')
  await ui.unmount()
})

test('人間が見る観点の各行が ・ で始まる', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'more-points' })
  await clock.settle()

  const points = await ui.findAll({ type: 'Text', text: /観点 \d/ })
  expect(points.map(one => one.text)).toEqual(['・ 観点 1', '・ 観点 2', '・ 観点 3'])
  await ui.unmount()
})

// ---- the config file ----

test('with no config file, nothing is fetched and the pane says where to set one', async ($, on) => {
  const { clock, calls } = world(on, [review()], {}, undefined, null)
  await begin($, clock)

  expect(calls.search).toBe(0)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /config\.json/ })).toBeDefined()
  await pane.unmount()
})
