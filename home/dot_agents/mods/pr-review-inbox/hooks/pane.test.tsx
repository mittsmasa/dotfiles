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
  '@@ -10,1 +10,2 @@',
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
    prompts: [] as string[],
    open: [] as unknown[],
    writes: [] as string[],
    argv: [] as (readonly string[])[],
  }
  // What GitHub says of the review requests: when each named me, and whether it answers at all.
  const github = { requestedAt: [] as string[], isDown: false, isRefusingReviews: false }
  // Set, a read of the saved diff waits for it: what was opened meanwhile is decided first.
  const disk = { hold: undefined as Promise<void> | undefined }
  // This session's agents as `$.agent.list()` reports them.
  const agents: { id: string; status: string }[] = []
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
  // Stands for the engine's own drawing, for what the mod leaves to it (`next(e)`).
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })
  // Counts the reviewers asked for. The kit hands a mod no agentId for a spawn,
  // so a review started here ends as failed; what a result does once accepted
  // is covered by the pure functions in reviews.test.ts.
  on('agent.spawn', (_, e) => {
    calls.spawn += 1
    calls.prompts.push((e as { prompt?: string }).prompt ?? '')

    return { model: 'test', agentId: `reviewer-${calls.spawn}` }
  })
  on('agent.list', () => ({ value: agents.map(one => ({ ...one, description: '', type: 'pr-review-inbox:reviewer' })) }) as never)
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
    if (disk.hold && e.path === DIFF_PATH) return disk.hold.then(() => ({ value: text }))

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
          : argv.includes('graphql')
            ? JSON.stringify({
                data: {
                  viewer: { login: 'me' },
                  repository: {
                    pullRequest: {
                      timelineItems: {
                        nodes: github.requestedAt.map(createdAt => ({
                          createdAt,
                          requestedReviewer: { __typename: 'User', login: 'me' },
                        })),
                      },
                    },
                  },
                },
              })
            : ''
    const isRefused = argv.includes('POST') && github.isRefusingReviews
    const isFailing = (argv.includes('graphql') && github.isDown) || isRefused

    return {
      value: {
        exitCode: isFailing ? 1 : 0,
        stdout: isFailing ? '' : stdout,
        stderr: isRefused ? 'HTTP 422' : isFailing ? 'HTTP 502' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  // What the surface takes: the prompt box, the clipboard. The desktop app draws
  // its own composer, so it refuses the fill.
  const surface = { isFilled: true, isCopied: true, filled: [] as string[], copied: [] as string[], toasts: [] as string[] }
  on('prompt.fill', (_, e) => {
    if (surface.isFilled) surface.filled.push(e.text)

    return surface.isFilled ? { isFilled: true } : { isFilled: false, refusal: 'no_composer' }
  })
  on('ui.copy', (_, e) => {
    if (surface.isCopied) surface.copied.push(e.text)

    return { value: surface.isCopied ? { isCopied: true } : { isCopied: false, reason: 'no-clipboard' } } as never
  })
  on('ui.toast', (_, e) => {
    surface.toasts.push((e as { text: string }).text)

    return { value: undefined } as never
  })

  return { clock, calls, store, agents, github, disk, surface }
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
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
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
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
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

// ---- a reviewer the mod cannot stop ----

const WORKTREE_12 = '/Users/me/src/widgets/.claude/worktrees/review-12'
const removals = (argv: readonly (readonly string[])[]) =>
  argv.filter(one => one.includes('remove') && one.includes(WORKTREE_12)).length

test('a reload takes up the reviewer still at work instead of cutting it off', async ($, on) => {
  const left = review({
    status: 'reviewing',
    agentId: 'reviewer-x',
    reviewStartedAt: '2026-11-09T01:55:00.000Z',
    findings: [],
    verdict: undefined,
  })
  const waiting = review({ key: 'acme/widgets#13', status: 'queued', findings: [], verdict: undefined })
  const running = {
    key: KEY,
    agentId: 'reviewer-x',
    repo: '/Users/me/src/widgets',
    worktree: WORKTREE_12,
    resultPath: `${SAVED}.json`,
    allowedRoots: [WORKTREE_12],
  }
  const { clock, calls, agents } = world(on, [left, waiting], { running, reviewerAgentIds: ['reviewer-x'] })
  agents.push({ id: 'reviewer-x', status: 'running' })
  await begin($, clock)

  expect(removals(calls.argv)).toBe(0)
  // One at a time still: the waiting one waits.
  expect(calls.spawn).toBe(0)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /中断/ })).toBe(undefined)
  await pane.unmount()
  // Its checkout and result file are still its own.
  const read = { tool: 'Read', file_path: `${WORKTREE_12}/a.ts`, agentId: 'reviewer-x' } as never
  expect((await $.tool.call(read)).deny).toBe(undefined)
  const write = { tool: 'Write', file_path: `${SAVED}.json`, content: '{}', agentId: 'reviewer-x' } as never
  expect((await $.tool.call(write)).deny).toBe(undefined)
})

test('a reload cuts off a review whose reviewer has ended', async ($, on) => {
  const left = review({ status: 'reviewing', agentId: 'reviewer-x', findings: [], verdict: undefined })
  const running = { key: KEY, agentId: 'reviewer-x', repo: '', worktree: WORKTREE_12, resultPath: '', allowedRoots: [] }
  const { clock, calls, agents } = world(on, [left], { running })
  agents.push({ id: 'reviewer-x', status: 'completed' })
  await begin($, clock)

  expect(removals(calls.argv)).toBeGreaterThan(0)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /失敗: 中断/ })).toBeDefined()
  await pane.unmount()
})

// The kit's spawn hands back no agentId, so a reviewer at work is set up as
// one a reload took up, started `minutesAgo` before the mocked now.
function reviewerAtWork(on: On, minutesAgo: number, more: Review[] = []) {
  const started = new Date(Date.UTC(2026, 10, 9, 2, 0) - minutesAgo * 60 * 1000).toISOString()
  const left = review({ status: 'reviewing', agentId: 'reviewer-x', reviewStartedAt: started, findings: [], verdict: undefined })
  const running = { key: KEY, agentId: 'reviewer-x', repo: '', worktree: WORKTREE_12, resultPath: '', allowedRoots: [] }
  const made = world(on, [left, ...more], { running, reviewerAgentIds: ['reviewer-x'] })
  made.agents.push({ id: 'reviewer-x', status: 'running' })

  return made
}

test('a reviewer past the timeout but still at work keeps its worktree, and none other starts', async ($, on) => {
  const waiting = review({ key: 'acme/widgets#13', status: 'queued', findings: [], verdict: undefined })
  const { clock, calls, agents } = reviewerAtWork(on, 10, [waiting])
  await begin($, clock)

  // Past the 15 minutes, and on to 40.
  await clock.advance(30 * 60 * 1000)
  expect(removals(calls.argv)).toBe(0)
  expect(calls.spawn).toBe(0)

  // Once it has ended, the review fails as timed out and the queue moves on.
  agents[0] = { id: 'reviewer-x', status: 'completed' }
  await clock.advance(5 * 60 * 1000)
  expect(removals(calls.argv)).toBe(1)
  expect(calls.spawn).toBe(1)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /失敗: タイムアウト/ })).toBeDefined()
  await pane.unmount()
})

test('a reviewer still at work is given up on after the hard limit', async ($, on) => {
  const { clock, calls } = reviewerAtWork(on, 50)
  await begin($, clock)

  await clock.advance(9 * 60 * 1000)
  expect(removals(calls.argv)).toBe(0)
  await clock.advance(2 * 60 * 1000)
  expect(removals(calls.argv)).toBe(1)
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

// The kit gives a hook-answered spawn no agentId, so the review fails right
// after the spawn and the guard cannot be reached here: whether the reviewer
// may read these files is seen on a real pull request (denied.log).
test("a reviewer's prompt names the testable-design files by their real paths", async ($, on) => {
  const { clock, calls } = world(on, [review({ status: 'queued', findings: [], verdict: undefined })])
  await begin($, clock)
  const skill = '/Users/me/.agents/skills/testable-design'

  expect(calls.prompts[0]).toContain(
    [
      `- ${skill}/SKILL.md`,
      `- ${skill}/references/separation-of-concerns.md`,
      `- ${skill}/references/test-quality.md`,
      `- ${skill}/references/mechanical-checks.md`,
    ].join('\n'),
  )
})

// ---- 深掘りする ----

const DEEP_DIVE = 'https://github.com/acme/widgets/pull/12 を別セッションで詳しくレビューして'

async function pressDeepDive($: Engine, clock: { settle: () => Promise<void> }) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'deep-dive' })
  await clock.settle()
  await ui.unmount()
}

test('深掘りするで、依頼文が入力欄に入る', async ($, on) => {
  const { clock, surface } = world(on, [review()])
  await begin($, clock)

  await pressDeepDive($, clock)

  expect(surface.filled).toEqual([DEEP_DIVE])
  expect(surface.copied).toEqual([])
})

test('入力欄が断ると、深掘りの依頼文はクリップボードに入り、toast で知らせる', async ($, on) => {
  const { clock, surface } = world(on, [review()])
  surface.isFilled = false
  await begin($, clock)

  await pressDeepDive($, clock)

  expect(surface.copied).toEqual([DEEP_DIVE])
  expect(surface.toasts).toEqual(['深掘りの依頼文をコピーしました。入力欄に貼って送ってください'])
})

test('入力欄もクリップボードも断ると、toast に深掘りの依頼文そのものが出る', async ($, on) => {
  const { clock, surface } = world(on, [review()])
  surface.isFilled = false
  surface.isCopied = false
  await begin($, clock)

  await pressDeepDive($, clock)

  expect(surface.toasts).toEqual([`入力欄に入れられませんでした。次の文を送ってください: ${DEEP_DIVE}`])
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

test('送るボタンを押すと、一覧と詳細を残したまま確認がその場に出て、戻るでは何も送らない', async ($, on) => {
  const { clock, calls } = world(on, [review({ findings: [finding({ severity: 'recommended' })], body: '本文です' })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'comment' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /送信の確認/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /COMMENT レビューを送ります/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeDefined()
  // Nothing was swapped out: the list, the description and the findings are still drawn.
  expect(await ui.find({ key: `row:${KEY}` })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^概要$/ })).toBeDefined()
  expect(await ui.find({ key: 'body' })).toBeDefined()
  expect(await ui.find({ key: 'open:f1' })).toBeDefined()
  // The confirm block stands where the send controls were.
  expect(await ui.find({ key: 'comment' })).toBe(undefined)
  expect(await ui.find({ key: 'approve' })).toBe(undefined)

  await ui.press({ key: 'back' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /送信の確認/ })).toBe(undefined)
  expect(await ui.find({ key: 'comment' })).toBeDefined()
  // The request body is written only when it is sent.
  expect(calls.writes.filter(path => path.includes('/payloads/'))).toEqual([])
  await ui.unmount()
})

test('確認中、各指摘に送り先が出て、行に付く数はインラインの件数と同じ', async ($, on) => {
  const { clock } = world(on, [
    review({
      findings: [
        // On a line the diff shows, on a file it does not, and taken out.
        finding({ id: 'f1', severity: 'recommended' }),
        finding({ id: 'f2', severity: 'recommended', file: 'docs/guide.md', line: 3 }),
        finding({ id: 'f3', severity: 'suggestion', isAdopted: false }),
      ],
    }),
  ])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /行に付く|本文へ|送らない/ })).toBe(undefined)
  await ui.press({ key: 'comment' })
  await clock.settle()

  expect(await ui.findAll({ type: 'Text', text: /^行に付く$/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /^本文へ$/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /^送らない$/ })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /インライン 1 件 · 本文あり/ })).toBeDefined()
  // What goes into the body is drawn as it will be sent.
  expect(await ui.find({ type: 'Text', text: /^\[recommended\] docs\/guide\.md:3 丸めを/ })).toBeDefined()
  await ui.unmount()
})

test('確認中は指摘を開いても確認が残り、編集・外す・追加は出ない', async ($, on) => {
  const { clock } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  expect(await ui.find({ key: 'add' })).toBeDefined()
  await ui.press({ key: 'approve' })
  await clock.settle()
  await ui.press({ key: 'open:f1' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /送信の確認/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  expect(await ui.find({ key: 'edit:f1' })).toBe(undefined)
  expect(await ui.find({ key: 'toggle:f1' })).toBe(undefined)
  expect(await ui.find({ key: 'add' })).toBe(undefined)
  expect(await ui.find({ key: 'adopt-all' })).toBe(undefined)
  await ui.unmount()
})

test('送信に失敗すると、確認の中に理由が出て、もう一度送れる', async ($, on) => {
  const { clock, calls, github } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)
  github.isRefusingReviews = true

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await sendFrom(ui, clock, 'comment')

  expect((await ui.find({ type: 'Text', text: /送信できませんでした/ }))?.text).toBe('送信できませんでした: HTTP 422')
  expect(await ui.find({ type: 'Text', text: /送信の確認/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeDefined()
  // Not sent: the review stays on the list, and no note says it went.
  expect(await ui.find({ key: `row:${KEY}` })).toBeDefined()
  expect(calls.writes.filter(path => path.endsWith('.posted.json'))).toEqual([])
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

const SENT_NOTE = JSON.stringify({ postedAt: '2026-11-09T01:00:00.000Z', postedEvent: 'APPROVE' })
const BEFORE_SENT = '2026-11-09T00:30:00Z'
const AFTER_SENT = '2026-11-09T01:30:00Z'
const isRmSaved = (argv: readonly string[]) => argv[0] === 'rm' && argv.length === 5

test('a result that was sent comes back as sent', async ($, on) => {
  const { clock, calls, github } = world(on, [waiting()], {}, {
    [`${SAVED}.accepted.json`]: result({ findings: [] }),
    [`${SAVED}.posted.json`]: SENT_NOTE,
    [DIFF_PATH]: DIFF,
  })
  // Still in the search, but nobody asked again since it was sent.
  github.requestedAt = [BEFORE_SENT]
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

test('a sent review asked for again at the same commit is reviewed from nothing', async ($, on) => {
  const { clock, calls, github } = world(on, [waiting()], {}, {
    [`${SAVED}.accepted.json`]: result({ findings: [] }),
    [`${SAVED}.posted.json`]: SENT_NOTE,
    [DIFF_PATH]: DIFF,
  })
  github.requestedAt = [BEFORE_SENT, AFTER_SENT]
  await begin($, clock)
  await clock.settle()

  expect(calls.argv.filter(isRmSaved)).toEqual([RM_SAVED])
  expect(calls.spawn).toBe(1)
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /承認済み/ })).toBe(undefined)
  await pane.unmount()
})

const SENT_AND_READ = { postedAt: '2026-11-09T01:00:00.000Z', postedEvent: 'COMMENT', isRead: true } as const

test('a sent review still held here is reviewed again once it is asked for again', async ($, on) => {
  const { clock, calls, github } = world(on, [review(SENT_AND_READ)])
  github.requestedAt = [AFTER_SENT]
  await begin($, clock)
  await clock.settle()

  expect(calls.spawn).toBe(1)
})

test('a sent review still in the search, with no new request, is left as sent', async ($, on) => {
  const { clock, calls, github } = world(on, [review(SENT_AND_READ)])
  github.requestedAt = [BEFORE_SENT]
  await begin($, clock)
  await clock.settle()

  expect(calls.argv.filter(isRmSaved)).toEqual([])
  expect(calls.spawn).toBe(0)
})

test('a fetch that cannot read the review requests changes nothing', async ($, on) => {
  const sent = review(SENT_AND_READ)
  const { clock, calls, store, github } = world(on, [sent], {}, {
    [`${SAVED}.accepted.json`]: result(),
    [`${SAVED}.posted.json`]: SENT_NOTE,
    [DIFF_PATH]: DIFF,
  })
  github.isDown = true
  await begin($, clock)
  await clock.settle()

  expect(calls.argv.filter(isRmSaved)).toEqual([])
  expect(calls.spawn).toBe(0)
  expect((store.get('inbox') as { reviews: Review[] }).reviews).toEqual([sent])
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /取得に失敗/ }))?.text).toBe('取得に失敗しました: HTTP 502')
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

// ---- sending takes a review off the list ----

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

test('COMMENT 送信後、その PR が一覧に出ない', async ($, on) => {
  const { clock } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await sendFrom(ui, clock, 'comment')

  expect(await ui.find({ type: 'Text', text: /#12/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /レビュー待ちはありません/ })).toBeDefined()
  await ui.unmount()
})

// ---- what the selected review shows ----

const OTHER = 'acme/widgets#13'
const lines = (count: number) => Array.from({ length: count }, (_, index) => `行 ${index + 1}`).join('\n')

/** What the cell before a row's edge draws: the selection mark, or a blank. */
async function markOf(ui: { find: (query: { key: string }) => Promise<{ children: unknown[] } | undefined> }, key: string) {
  return JSON.stringify((await ui.find({ key: `mark:${key}` }))?.children ?? [])
}

test('選択しても行に枠は付かず、選択行にだけ印が出る', async ($, on) => {
  const { clock } = world(on, [review(), review({ key: OTHER, url: 'https://github.com/acme/widgets/pull/13' })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.findAll({ type: 'Text', text: /▸/ })).toHaveLength(0)
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  // A border would add rows around the selected row and move the ones below it.
  expect((await ui.find({ key: `row-box:${KEY}` }))?.props.borderStyle).toBe(undefined)
  expect((await ui.find({ key: `row-box:${OTHER}` }))?.props.borderStyle).toBe(undefined)
  expect(await ui.findAll({ type: 'Text', text: /▸/ })).toHaveLength(1)
  expect(await markOf(ui, KEY)).toContain('▸')

  await ui.press({ key: `row:${OTHER}` })
  await clock.settle()
  expect(await ui.findAll({ type: 'Text', text: /▸/ })).toHaveLength(1)
  expect(await markOf(ui, OTHER)).toContain('▸')
  await ui.unmount()
})

// ---- the diff under an open finding ----

// Two files, one hunk each: order-list.tsx shows right-side lines 10-11, filter.ts lines 40-41.
const HUNK_ORDERS = ['@@ -10,1 +10,2 @@', ' const a = 1', '+const b = 2'].join('\n')
const HUNK_FILTER = ['@@ -40,1 +40,2 @@', ' const z = 3', '+const w = 4'].join('\n')
const TWO_FILES = [
  'diff --git a/x b/x',
  '--- a/web/src/components/orders/order-list.tsx',
  '+++ b/web/src/components/orders/order-list.tsx',
  HUNK_ORDERS,
  'diff --git a/y b/y',
  '--- a/web/src/filter.ts',
  '+++ b/web/src/filter.ts',
  HUNK_FILTER,
].join('\n')
const inFilter = (over: Partial<Finding> = {}) =>
  finding({ id: 'f2', severity: 'recommended', file: 'web/src/filter.ts', line: 41, ...over })

test('指摘を開くと、その行を含む差分が出て、閉じると消える', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  expect(await ui.find({ type: 'Code' })).toBe(undefined)

  await ui.press({ key: 'open:f1' })
  await clock.settle()
  const code = await ui.findAll({ type: 'Code' })
  expect(code).toHaveLength(1)
  expect(code[0]?.props.format).toBe('diff')
  expect(code[0]?.props.source).toBe(HUNK_ORDERS)

  await ui.press({ key: 'open:f1' })
  await clock.settle()
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.unmount()
})

test('別の指摘に切り替えると、差分もその指摘のものに替わる', async ($, on) => {
  const { clock } = world(on, [review({ findings: [finding(), inFilter()] })], {}, { [DIFF_PATH]: TWO_FILES })
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'open:f1' })
  await clock.settle()
  await ui.press({ key: 'open:f2' })
  await clock.settle()

  const code = await ui.findAll({ type: 'Code' })
  expect(code).toHaveLength(1)
  expect(code[0]?.props.source).toBe(HUNK_FILTER)
  await ui.unmount()
})

test('差分を読んでいる間に別の指摘へ切り替えても、先の指摘の差分は出ない', async ($, on) => {
  const { clock, disk } = world(on, [review({ findings: [finding(), inFilter()] })], {}, { [DIFF_PATH]: TWO_FILES })
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  let release = () => {}
  disk.hold = new Promise<void>(resolve => {
    release = resolve
  })
  // Both reads wait; f1's comes back first, after f2 has been opened.
  await ui.press({ key: 'open:f1' })
  await ui.press({ key: 'open:f2' })
  release()
  await clock.settle()

  const code = await ui.findAll({ type: 'Code' })
  expect(code).toHaveLength(1)
  expect(code[0]?.props.source).toBe(HUNK_FILTER)
  await ui.unmount()
})

test('差分に出ていない行の指摘を開いても、差分は出ない', async ($, on) => {
  const { clock } = world(on, [review({ findings: [finding({ line: 99 })] })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'open:f1' })
  await clock.settle()

  // The finding itself opens; only the diff is left out.
  expect(await ui.find({ type: 'Text', text: /丸めを/ })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.unmount()
})

test('差分の保存が無い PR では、指摘を開いても差分は出ない', async ($, on) => {
  const { clock } = world(on, [review()], {}, {})
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'open:f1' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /丸めを/ })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.unmount()
})

test('別の PR を選ぶと、開いていた指摘の差分は持ち越されない', async ($, on) => {
  // Both reviews hold a finding with the same id, as reviewers number them from f1.
  const { clock } = world(on, [review(), review({ key: OTHER, url: 'https://github.com/acme/widgets/pull/13' })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'open:f1' })
  await clock.settle()
  expect(await ui.find({ type: 'Code' })).toBeDefined()

  await ui.press({ key: `row:${OTHER}` })
  await clock.settle()
  expect(await ui.find({ key: 'open:f1' })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
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

test('すべて外すで全指摘が外れて Approve に変わり、すべて戻すで元に戻る', async ($, on) => {
  const { clock } = world(on, [
    review({ findings: [finding(), finding({ id: 'f2', severity: 'recommended', line: 10 })] }),
  ])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  expect((await ui.find({ key: 'adopt-all' }))?.props.label).toBe('すべて外す')

  await ui.press({ key: 'adopt-all' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /2 件中 0 件を送る/ })).toBeDefined()
  expect(await ui.find({ key: 'comment' })).toBe(undefined)
  expect(await ui.find({ key: 'approve' })).toBeDefined()
  expect((await ui.find({ key: 'adopt-all' }))?.props.label).toBe('すべて戻す')

  await ui.press({ key: 'adopt-all' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /2 件中 2 件を送る/ })).toBeDefined()
  expect(await ui.find({ key: 'comment' })).toBeDefined()
  expect(await ui.find({ key: 'approve' })).toBe(undefined)
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
