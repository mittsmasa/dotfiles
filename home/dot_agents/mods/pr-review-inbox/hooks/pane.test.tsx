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
  checked: ['確認 1', '確認 2'],
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

/** A stored review's size as gh reports it; nothing for a review that holds none. */
const sizeOf = (one: Review | undefined) =>
  one?.lines ? { additions: one.lines.added, deletions: one.lines.removed, changedFiles: one.lines.files } : {}

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
    // What was last written to each path, as the write named it.
    written: {} as Record<string, string>,
    argv: [] as (readonly string[])[],
  }
  // What GitHub says of the review requests: when each named me, and whether it answers at all.
  const github = { requestedAt: [] as string[], isDown: false, isRefusingReviews: false }
  // Set, the next read of the saved diff waits for it, so a later read can come back first.
  // `gone` names paths that are not on disk, whatever else is.
  const disk = { hold: undefined as Promise<void> | undefined, gone: [] as string[] }
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
  on('fs.exists', (_, e) => ({
    value: !disk.gone.includes(e.path) && (!files || !e.path.startsWith(DATA) || e.path in files),
  }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file', isLink: false, realPath: e.path } }) as never)
  on('fs.read', (_, e) => {
    if (e.path === CONFIG_PATH) {
      if (config === null) throw new Error('ENOENT')

      return { value: config }
    }
    if (!files) return { value: DIFF }
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    if (disk.hold && e.path === DIFF_PATH) {
      // Only the next read waits: the one after it overtakes.
      const hold = disk.hold
      disk.hold = undefined

      return hold.then(() => ({ value: text }))
    }

    return { value: text }
  })
  on('fs.write', (_, e) => {
    calls.writes.push(e.path)
    const text = Object.values(e as Record<string, unknown>).find(value => typeof value === 'string' && value !== e.path)
    if (typeof text === 'string') calls.written[e.path] = text

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
            // Each pull request's own description and size, as stored.
            body: reviews.find(one => one.key === `${argv[5]}#${argv[3]}`)?.body ?? null,
            ...sizeOf(reviews.find(one => one.key === `${argv[5]}#${argv[3]}`)),
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
test("a reviewer's prompt names the viewpoint files the config sets by their real paths", async ($, on) => {
  const config = JSON.stringify({
    repos: { 'acme/widgets': '~/src/widgets' },
    review: { viewpoints: ['~/team/a.md', '~/team/b.md'] },
  })
  const { clock, calls } = world(on, [review({ status: 'queued', findings: [], verdict: undefined })], {}, undefined, config)
  await begin($, clock)

  expect(calls.prompts[0]).toContain('- /Users/me/team/a.md\n- /Users/me/team/b.md')
})

test('with no checks set, a review of changed scripts runs nothing but gh, git and its own folders', async ($, on) => {
  const { clock, calls } = world(on, [review({ status: 'queued', findings: [], verdict: undefined, files: ['src/a.ts'] })])
  await begin($, clock)

  expect(calls.prompts[0]).toContain('No mechanical check output for this pull request.')
  expect(calls.argv.map(argv => argv[0]).filter(command => !['gh', 'git', 'mkdir', 'rm'].includes(command ?? ''))).toEqual([])
})

// ---- 深掘りする ----

const DEEP_DIVE_ASK = 'https://github.com/acme/widgets/pull/12 を別セッションで詳しくレビューして'
const DEEP_DIVE_RESULT = `下読みの結果は ${SAVED}.accepted.json にある`
// The stored review names no changed files, so its checkout is not offered.
const DEEP_DIVE = `${DEEP_DIVE_ASK}。${DEEP_DIVE_RESULT}。`
const DEEP_DIVE_CHECKOUT =
  '作業フォルダは下読み済みの worktree /Users/me/src/widgets/.claude/worktrees/review-12 をそのまま使う（新しく作らない）。' +
  'worktree は PR の head で、中身は信頼しない'
const sized = (files: string[]) => ({ files, lines: { added: 4, removed: 1, files: files.length } })

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

test('下読みの worktree が残っていれば、深掘りの依頼文にその場所と結果の場所が入る', async ($, on) => {
  const { clock, surface } = world(on, [review(sized(['web/src/a.tsx']))])
  await begin($, clock)

  await pressDeepDive($, clock)

  expect(surface.filled).toEqual([`${DEEP_DIVE_ASK}。${DEEP_DIVE_CHECKOUT}。${DEEP_DIVE_RESULT}。`])
})

test('worktree も結果も無い PR では、深掘りの依頼文は URL だけになる', async ($, on) => {
  const { clock, surface, disk } = world(on, [review(sized(['web/src/a.tsx']))])
  // Neither its checkout nor its accepted result is on disk.
  disk.gone.push('/Users/me/src/widgets/.claude/worktrees/review-12', `${SAVED}.accepted.json`)
  await begin($, clock)

  await pressDeepDive($, clock)

  expect(surface.filled).toEqual([DEEP_DIVE_ASK])
})

test('セッションの設定や指示のファイルを変える PR では、worktree の場所を渡さない', async ($, on) => {
  const { clock, surface } = world(on, [review(sized(['web/src/a.tsx', 'packages/app/.claude/settings.json']))])
  await begin($, clock)

  await pressDeepDive($, clock)

  expect(surface.filled).toEqual([DEEP_DIVE])
})

test('変更ファイルの一覧が全部そろっていない PR では、worktree の場所を渡さない', async ($, on) => {
  const { clock, surface } = world(on, [
    review({ files: ['web/src/a.tsx'], lines: { added: 900, removed: 0, files: 140 } }),
  ])
  await begin($, clock)

  await pressDeepDive($, clock)

  expect(surface.filled).toEqual([DEEP_DIVE])
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
  expect((await ui.find({ type: 'Text', text: /components\/orders/ }))?.text).toBe('…/components/orders · R-1')

  // Taken out: nothing left to comment on, and the approval is offered.
  await ui.press({ key: 'toggle:f1' })
  await clock.settle()
  expect(await ui.find({ key: 'comment' })).toBe(undefined)
  expect(await ui.find({ key: 'approve' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /コメントとして送ります/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeDefined()
  // Nothing was swapped out: the way back, the description and the findings are still drawn.
  expect(await ui.find({ key: 'back-to-list' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /^(行に付く|本文へ)$/ })).toBe(undefined)
  await ui.press({ key: 'comment' })
  await clock.settle()

  expect(await ui.findAll({ type: 'Text', text: /^行に付く$/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /^本文へ$/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Text', text: /^外した$/ })).toHaveLength(1)
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
  await ui.input({ key: 'approve', text: 'LGTM!', kind: 'submit' })
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
  // Not sent: the review stays open, and no note says it went.
  expect(await ui.find({ key: 'back-to-list' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^#12$/ })).toBeDefined()
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

// ---- the checkout a pre-read leaves ----

test('an accepted result leaves its checkout for a deep dive', async ($, on) => {
  const left = review({ status: 'reviewing', agentId: 'reviewer-x', reviewStartedAt: '2026-11-09T01:55:00.000Z', findings: [], verdict: undefined })
  const running = {
    key: KEY,
    agentId: 'reviewer-x',
    repo: '/Users/me/src/widgets',
    worktree: WORKTREE_12,
    resultPath: `${SAVED}.json`,
    allowedRoots: [WORKTREE_12],
  }
  const { clock, calls, agents } = world(on, [left], { running, reviewerAgentIds: ['reviewer-x'] }, {
    [`${SAVED}.json`]: result(),
    [DIFF_PATH]: DIFF,
  })
  agents.push({ id: 'reviewer-x', status: 'running' })
  await begin($, clock)

  await $.turn.complete({ agentId: 'reviewer-x', answer: '' } as never)
  await clock.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /要修正/ }))?.text).toBe('要修正')
  await pane.unmount()
  expect(removals(calls.argv)).toBe(0)
})

test('a result that cannot be read takes its checkout away', async ($, on) => {
  const left = review({ status: 'reviewing', agentId: 'reviewer-x', reviewStartedAt: '2026-11-09T01:55:00.000Z', findings: [], verdict: undefined })
  const running = { key: KEY, agentId: 'reviewer-x', repo: '', worktree: WORKTREE_12, resultPath: `${SAVED}.json`, allowedRoots: [] }
  const { clock, calls, agents } = world(on, [left], { running, reviewerAgentIds: ['reviewer-x'] }, { [DIFF_PATH]: DIFF })
  agents.push({ id: 'reviewer-x', status: 'running' })
  await begin($, clock)

  await $.turn.complete({ agentId: 'reviewer-x', answer: 'no json here' } as never)
  await clock.settle()

  expect(removals(calls.argv)).toBe(1)
})

test('片付けると、残してあった worktree が消える', async ($, on) => {
  const { clock, calls } = world(on, [review()])
  await begin($, clock)
  expect(removals(calls.argv)).toBe(0)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `row:${KEY}` })
  await clock.settle()
  await pane.press({ key: 'read' })
  await clock.settle()
  await pane.unmount()

  expect(removals(calls.argv)).toBe(1)
})

test('レビューを送ると、残してあった worktree が消える。送信に失敗したら残る', async ($, on) => {
  const { clock, calls, github } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)
  github.isRefusingReviews = true

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `row:${KEY}` })
  await clock.settle()
  await pane.press({ key: 'comment' })
  await clock.settle()
  await pane.press({ key: 'send' })
  await clock.settle()
  expect(removals(calls.argv)).toBe(0)

  github.isRefusingReviews = false
  await pane.press({ key: 'send' })
  await clock.settle()
  await pane.unmount()

  expect(removals(calls.argv)).toBe(1)
})

test('a waiting review that reuses a saved result still drops the checkout of an earlier commit', async ($, on) => {
  const { clock, calls } = world(on, [waiting()], {}, {
    [`${SAVED}.accepted.json`]: result(),
    [DIFF_PATH]: DIFF,
  })
  await begin($, clock)
  await clock.settle()

  expect(calls.spawn).toBe(0)
  expect(removals(calls.argv)).toBe(1)
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

test('a failed review reviewed again forgets the saved results first', async ($, on) => {
  const failed = review({ status: 'failed', failReason: 'タイムアウト', findings: [], verdict: undefined })
  const { clock, calls } = world(on, [failed], {}, { [`${SAVED}.accepted.json`]: result(), [DIFF_PATH]: DIFF })
  await begin($, clock)
  await clock.settle()
  expect(calls.spawn).toBe(0)

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `row:${KEY}` })
  await clock.settle()
  expect((await pane.find({ key: 'retry' }))?.props.label).toBe('もう一度レビューする')
  await pane.press({ key: 'retry' })
  await clock.settle()
  await pane.unmount()

  expect(calls.argv.filter(argv => argv[0] === 'rm' && argv.length === 5)).toEqual([RM_SAVED])
  // Back in the queue and picked up: the old copy was not what filled it.
  expect(calls.spawn).toBe(1)
})

test('a review without its diff reviewed again forgets the saved results first', async ($, on) => {
  // Done, with the diff gone: the pane offers to review again in place of sending.
  const { clock, calls } = world(on, [review()], {}, { [`${SAVED}.accepted.json`]: result() })
  await begin($, clock)
  await clock.settle()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await pane.press({ key: `row:${KEY}` })
  await clock.settle()
  expect((await pane.find({ key: 'rereview' }))?.props.label).toBe('もう一度レビューする')
  await pane.press({ key: 'rereview' })
  await clock.settle()
  await pane.unmount()

  expect(calls.argv.filter(argv => argv[0] === 'rm' && argv.length === 5)).toEqual([RM_SAVED])
  expect(calls.spawn).toBe(1)
  // The checkout kept for a deep dive goes before the new review makes its own.
  expect(removals(calls.argv)).toBeGreaterThan(0)
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
  ui: {
    press: (target: { key: string }) => Promise<unknown>
    input: (target: { key: string; text: string; kind: 'submit' }) => Promise<unknown>
  },
  clock: { settle: () => Promise<void> },
  control: 'comment' | 'approve',
) {
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  // The approval is the comment field's own submit; a comment review is a button.
  if (control === 'approve') await ui.input({ key: 'approve', text: 'LGTM!', kind: 'submit' })
  else await ui.press({ key: control })
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

test('選ぶと一覧が畳まれて一覧へ戻る行だけになり、戻ると全行が出る', async ($, on) => {
  const { clock } = world(on, [review(), review({ key: OTHER, url: 'https://github.com/acme/widgets/pull/13' })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'back-to-list' })).toBe(undefined)
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect(await ui.find({ key: `row:${KEY}` })).toBe(undefined)
  expect(await ui.find({ key: `row:${OTHER}` })).toBe(undefined)
  expect((await ui.find({ key: 'back-to-list' }))?.props.label).toBe('← 一覧 (2)')
  expect(await ui.find({ type: 'Text', text: /^#12$/ })).toBeDefined()

  await ui.press({ key: 'back-to-list' })
  await clock.settle()
  expect(await ui.find({ key: 'back-to-list' })).toBe(undefined)
  expect(await ui.find({ key: `row:${KEY}` })).toBeDefined()
  expect(await ui.find({ key: `row:${OTHER}` })).toBeDefined()
  await ui.unmount()
})

test('詳細の先頭に、まだ送る指摘の重さを添えた判定が出る', async ($, on) => {
  const { clock } = world(on, [
    review({ findings: [finding(), finding({ id: 'f2', severity: 'recommended', isAdopted: false })] }),
  ])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^要修正 ·/ }))?.text).toBe('要修正 · blocker 1')
  await ui.unmount()
})

test('PR へのリンクと片付けるは判定の上にあり、送るボタンの下には並ばない', async ($, on) => {
  const { clock } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect((await ui.find({ key: 'read' }))?.props.label).toBe('片付ける')
  // Drawn as buttons at rest, not only under the pointer.
  for (const key of ['deep-dive', 'read', 'add', 'adopt-all', 'back-to-list']) {
    const control = await ui.find({ key })
    expect([key, control?.props.variant, control?.props.plain]).toEqual([key, 'secondary', undefined])
  }
  const order = (await ui.findAll({ type: 'Button' })).map(one => one.key)
  expect(order.indexOf('read')).toBeGreaterThan(order.indexOf('deep-dive'))
  expect(order.indexOf('read')).toBeLessThan(order.indexOf('open:f1'))
  expect(order.at(-1)).toBe('comment')
  // Read top to bottom: the description, the findings, what was checked.
  const headings = (await ui.findAll({ type: 'Text', text: /^(概要|指摘 · .*|確認した点)$/ })).map(one => one.text)
  expect(headings).toEqual(['概要', '指摘 · 1 件中 1 件を送る'])
  await ui.unmount()
})

test('送る前に見るところは出ず、ボタンは日本語の動作名で出る', async ($, on) => {
  const { clock } = world(on, [review({ findings: [finding({ severity: 'recommended' })] })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /^送る前に見るところ$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /観点 \d/ })).toBe(undefined)
  expect((await ui.find({ key: 'comment' }))?.props.label).toBe('コメントで送る (1)')
  expect((await ui.find({ key: 'approve' }))?.props.submitLabel).toBe('承認して送る')
  // The filled button is kept for the confirm's 送信する: neither send control here is drawn as it.
  expect((await ui.find({ key: 'comment' }))?.props.variant).toBe('secondary')
  expect((await ui.find({ key: 'approve' }))?.props.label).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^PR コメント$/ })).toBeDefined()
  await ui.unmount()
})

test('時間外は、自動取得が平日 8–17 時だけだと見出しに出る', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  const during = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await during.find({ type: 'Text', text: /時間外/ })).toBe(undefined)
  await during.unmount()

  // Monday 11:00 JST to 18:00 JST.
  await clock.advance(7 * HOUR)
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /時間外 · 平日 8–17 時だけ自動取得/ })).toBeDefined()
  await after.unmount()
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
  // f1's read waits; f2 is opened and its read comes back; only then does f1's.
  await ui.press({ key: 'open:f1' })
  await clock.settle()
  await ui.press({ key: 'open:f2' })
  await clock.settle()
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

  await ui.press({ key: 'back-to-list' })
  await clock.settle()
  await ui.press({ key: `row:${OTHER}` })
  await clock.settle()
  expect(await ui.find({ key: 'open:f1' })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBe(undefined)
  await ui.unmount()
})

test('選んだ PR の見出しに、変更行数とファイル数が出る', async ($, on) => {
  const { clock } = world(on, [review({ lines: { added: 120, removed: 34, files: 5 } })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^widgets ·/ }))?.text).toBe('widgets · +120 −34 · 5 ファイル')
  expect((await ui.find({ type: 'Text', text: /^概要/ }))?.text).toBe('概要')
  await ui.unmount()
})

test('選んだ PR の見出しに、PR を出した人がリポジトリ名の次に出る', async ($, on) => {
  const { clock } = world(on, [review({ author: 'octocat', lines: { added: 120, removed: 34, files: 5 } })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^widgets ·/ }))?.text).toBe('widgets · @octocat · +120 −34 · 5 ファイル')
  await ui.unmount()
})

test('行数を持たない PR では、見出しはリポジトリ名だけになる', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect((await ui.find({ type: 'Text', text: /^widgets/ }))?.text).toBe('widgets')
  expect(await ui.find({ type: 'Text', text: /ファイル$/ })).toBe(undefined)
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

test('3 行の本文は折りたたまない', async ($, on) => {
  const { clock } = world(on, [review({ body: lines(3) })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  expect((await ui.find({ key: 'body' }))?.props.text).toBe(lines(3))
  expect(await ui.find({ key: 'more-body' })).toBe(undefined)
  await ui.unmount()
})

test('4 行の本文で『続きを表示』が出て、押すと全文が出て、折りたたむで 3 行に戻る', async ($, on) => {
  const { clock } = world(on, [review({ body: lines(4) })])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  expect((await ui.find({ key: 'body' }))?.props.text).toBe(lines(3))

  await ui.press({ key: 'more-body' })
  await clock.settle()
  expect((await ui.find({ key: 'body' }))?.props.text).toBe(lines(4))
  expect((await ui.find({ key: 'more-body' }))?.props.label).toBe('折りたたむ')

  await ui.press({ key: 'more-body' })
  await clock.settle()
  expect((await ui.find({ key: 'body' }))?.props.text).toBe(lines(3))
  expect((await ui.find({ key: 'more-body' }))?.props.label).toBe('続きを表示')
  await ui.unmount()
})

test('展開後に別の PR を選ぶと折りたたみに戻る', async ($, on) => {
  const { clock } = world(on, [
    review({ body: lines(5) }),
    review({ key: OTHER, url: 'https://github.com/acme/widgets/pull/13', body: lines(20) }),
  ])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  await ui.press({ key: 'more-body' })
  await clock.settle()
  await ui.press({ key: 'back-to-list' })
  await clock.settle()
  await ui.press({ key: `row:${OTHER}` })
  await clock.settle()

  expect((await ui.find({ key: 'body' }))?.props.text).toBe(lines(3))
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

test('指摘行のタグに書く severity は blocker だけで、基準の ID は開いたときに出る', async ($, on) => {
  const { clock } = world(on, [
    review({ findings: [finding(), finding({ id: 'f2', severity: 'recommended', line: 10, isUnsure: true })] }),
  ])
  await begin($, clock)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect(await ui.findAll({ type: 'Text', text: /^blocker$/ })).toHaveLength(1)
  expect((await ui.find({ type: 'Text', text: /^要確認$/ }))?.text).toBe('要確認')
  expect(await ui.find({ type: 'Text', text: /^recommended/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /R-1/ })).toBe(undefined)

  await ui.press({ key: 'open:f1' })
  await clock.settle()
  expect((await ui.find({ type: 'Text', text: /R-1/ }))?.text).toBe('…/components/orders · R-1')
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

/** The detail of the one stored review, drawn on the desktop. */
async function openDetail($: Engine, clock: { settle: () => Promise<void> }) {
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  return ui
}

test('確認した点は出ず、省いたものだけが 1 行で出る', async ($, on) => {
  const { clock } = world(on, [review({ skipped: ['機械チェック（対象なし）', 'diff の一部'] })])
  await begin($, clock)

  const ui = await openDetail($, clock)

  // The review still holds what was verified; the detail no longer draws it.
  expect(await ui.find({ type: 'Text', text: /確認 \d/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^確認した点$/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^省いたもの/ }))?.text).toBe('省いたもの: 機械チェック（対象なし）、diff の一部')
  await ui.unmount()
})

test('省いたものが無ければ、その行も出ない', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  const ui = await openDetail($, clock)

  expect(await ui.find({ type: 'Text', text: /^確認した点$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^省いたもの/ })).toBe(undefined)
  await ui.unmount()
})

// ---- the diff screen ----

// order-list.tsx: right-side lines 10 (context), 11 (added), 12 (context); old line 11 removed.
// filter.ts: right-side lines 40 (context), 41 (added).
const SCREEN_DIFF = [
  'diff --git a/x b/x',
  '--- a/web/src/components/orders/order-list.tsx',
  '+++ b/web/src/components/orders/order-list.tsx',
  '@@ -10,3 +10,3 @@',
  ' const a = 1',
  '-const old = 2',
  '+const b = 2',
  ' return a',
  'diff --git a/y b/y',
  '--- a/web/src/filter.ts',
  '+++ b/web/src/filter.ts',
  HUNK_FILTER,
].join('\n')
const ORDERS = 'web/src/components/orders/order-list.tsx'
// A file's Button is named by its place in the list, not by its path.
const FILE_ORDERS = 'file:0'
const FILE_FILTER = 'file:1'
const FILTER = 'web/src/filter.ts'

/** The diff screen of the one stored review, with no file open yet. */
async function openDiffScreen($: Engine, clock: { settle: () => Promise<void> }) {
  const ui = await openDetail($, clock)
  await ui.press({ key: 'diff-view' })
  await clock.settle()

  return ui
}

test('diff の保存がある PR の詳細に「差分を見る」が出て、押すとファイル一覧が行数と指摘の数つきで出る', async ($, on) => {
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)

  expect(await ui.find({ key: FILE_ORDERS })).toBeDefined()
  expect(await ui.find({ key: FILE_FILTER })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+1 −1 · 指摘 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+1 −0$/ })).toBeDefined()
  // No file is open yet, and the detail is not drawn under the screen.
  expect(await ui.find({ type: 'Text', text: /const b = 2/ })).toBe(undefined)
  expect(await ui.find({ key: 'read' })).toBe(undefined)
  await ui.unmount()
})

test('diff の保存が無い PR の詳細には「差分を見る」が出ない', async ($, on) => {
  const { clock } = world(on, [review()], {}, {})
  await begin($, clock)

  const ui = await openDetail($, clock)

  expect(await ui.find({ key: 'read' })).toBeDefined()
  expect(await ui.find({ key: 'diff-view' })).toBe(undefined)
  await ui.unmount()
})

test('ファイルを押すと行が出て、同じファイルを押すと閉じ、別のファイルを押すと切り替わる', async ($, on) => {
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^\+ const b = 2$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^- const old = 2$/ })).toBeDefined()

  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /const b = 2/ })).toBe(undefined)

  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  await ui.press({ key: FILE_FILTER })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^\+ const w = 4$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /const b = 2/ })).toBe(undefined)
  await ui.unmount()
})

test('下読みの指摘はその行の直後に出て、行が差分に無い指摘はファイルの先頭に出る', async ($, on) => {
  const findings = [
    finding(),
    finding({ id: 'f2', severity: 'recommended', line: 99, reason: '差分の外の行の話', comment: '外の行です' }),
  ]
  const { clock } = world(on, [review({ findings })], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()

  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  const at = (text: string) => texts.indexOf(text)
  expect(at('このページに無い指摘')).toBeGreaterThan(-1)
  // The finding off the diff stands above the first row; the one on line 11 between that row and the next.
  expect(at('差分の外の行の話')).toBeGreaterThan(at('このページに無い指摘'))
  expect(at('差分の外の行の話')).toBeLessThan(at('@@ -10,3 +10,3 @@'))
  expect(at('合計の丸め方が表示側と合わない')).toBeGreaterThan(at('+ const b = 2'))
  expect(at('合計の丸め方が表示側と合わない')).toBeLessThan(at('  return a'))
  expect(at('下読み · blocker')).toBeGreaterThan(at('+ const b = 2'))
  await ui.unmount()
})

test('追加行を押すと入力欄がその行の下に出て、送ると自分の指摘がその行の下と詳細ビューの両方に出る', async ($, on) => {
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_FILTER })
  await clock.settle()
  expect(await ui.find({ key: 'line-comment' })).toBe(undefined)

  await ui.press({ key: 'line:41' })
  await clock.settle()
  expect((await ui.find({ key: 'line-comment' }))?.props.label).toBe('41 行目へのコメント')

  await ui.input({ key: 'line-comment', text: 'ここ w の意味を知りたいです', kind: 'submit' })
  await clock.settle()
  expect(await ui.find({ key: 'line-comment' })).toBe(undefined)
  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  expect(texts.indexOf('ここ w の意味を知りたいです')).toBeGreaterThan(texts.indexOf('+ const w = 4'))
  expect(texts).toContain('自分')

  await ui.press({ key: 'back-to-detail' })
  await clock.settle()
  // The detail lists it as a finding at that file and line, to be sent with the rest.
  expect(await ui.find({ key: 'open:h1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^filter\.ts:41$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /2 件中 2 件を送る/ })).toBeDefined()
  await ui.unmount()
})

test('行コメントは「やめる」で入力欄が消え、何も足されない', async ($, on) => {
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_FILTER })
  await clock.settle()
  await ui.press({ key: 'line:40' })
  await clock.settle()
  await ui.press({ key: 'line-comment-cancel' })
  await clock.settle()

  expect(await ui.find({ key: 'line-comment' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^自分$/ })).toBe(undefined)
  await ui.unmount()
})

test('追加行と文脈行に加えて、削除行も押せる。削除行のボタンは別の名前を持つ', async ($, on) => {
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()

  // Right-side lines 10, 11 and 12, and the removed old line 11, which shares its number with a new line.
  const lines = (await ui.findAll({ type: 'Button' })).map(one => one.props.key).filter(key => String(key).startsWith('line:'))
  expect(lines).toEqual(['line:10', 'line:L11', 'line:11', 'line:12'])
  await ui.unmount()
})

test('確認中の PR と送信済みの PR では、差分は読めるが、どの行も押せない', async ($, on) => {
  const sent = review({
    key: OTHER,
    url: 'https://github.com/acme/widgets/pull/13',
    postedAt: '2026-11-09T01:30:00.000Z',
    postedEvent: 'COMMENT',
  })
  const { clock } = world(on, [review(), sent], {}, {
    [DIFF_PATH]: SCREEN_DIFF,
    [`${DATA}/diffs/acme/widgets/13/${SHA}.diff`]: SCREEN_DIFF,
  })
  await begin($, clock)

  const ui = await openDetail($, clock)
  await ui.press({ key: 'comment' })
  await clock.settle()
  await ui.press({ key: 'diff-view' })
  await clock.settle()
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^\+ const b = 2$/ })).toBeDefined()
  expect(await ui.find({ key: 'line:11' })).toBe(undefined)
  expect(await ui.find({ key: 'line:L11' })).toBe(undefined)
  // The request being confirmed is still there once back on the detail.
  await ui.press({ key: 'back-to-detail' })
  await clock.settle()
  expect(await ui.find({ key: 'send' })).toBeDefined()
  await ui.press({ key: 'back' })
  await clock.settle()

  await ui.press({ key: 'back-to-list' })
  await clock.settle()
  await ui.press({ key: `row:${OTHER}` })
  await clock.settle()
  await ui.press({ key: 'diff-view' })
  await clock.settle()
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^\+ const b = 2$/ })).toBeDefined()
  expect(await ui.find({ key: 'line:11' })).toBe(undefined)
  await ui.unmount()
})

test('削除行の行番号を押してコメントを足すと、削除行の下に出て、同じ番号の追加行の下には出ない', async ($, on) => {
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  await ui.press({ key: 'line:L11' })
  await clock.settle()
  expect((await ui.find({ key: 'line-comment' }))?.props.label).toBe('11 行目（削除行）へのコメント')
  await ui.input({ key: 'line-comment', text: '消した理由を知りたいです', kind: 'submit' })
  await clock.settle()

  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  // Under the removed row, and above the added row that is also numbered 11.
  expect(texts.indexOf('消した理由を知りたいです')).toBeGreaterThan(texts.indexOf('- const old = 2'))
  expect(texts.indexOf('消した理由を知りたいです')).toBeLessThan(texts.indexOf('+ const b = 2'))
  expect(texts.filter(text => text === '消した理由を知りたいです')).toHaveLength(1)

  await ui.press({ key: 'back-to-detail' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^削除行 · 自分$/ })).toBeDefined()
  await ui.unmount()
})

test('削除行のコメントは、確認で行に付く数に入り、送る payload では LEFT と変更前の行番号になる', async ($, on) => {
  const { clock, calls } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  await ui.press({ key: 'line:L11' })
  await clock.settle()
  await ui.input({ key: 'line-comment', text: '消した理由を知りたいです', kind: 'submit' })
  await clock.settle()
  await ui.press({ key: 'line:12' })
  await clock.settle()
  await ui.input({ key: 'line-comment', text: 'ここは右側です', kind: 'submit' })
  await clock.settle()
  await ui.press({ key: 'back-to-detail' })
  await clock.settle()
  await ui.press({ key: 'comment' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /インライン 2 件/ })).toBeDefined()
  await ui.press({ key: 'send' })
  await clock.settle()
  const payload = JSON.parse(calls.written[`${DATA}/payloads/acme/widgets/12/${SHA}.json`] ?? '{}') as {
    comments?: { path: string; line: number; side: string; body: string }[]
  }
  expect(payload.comments).toEqual([
    { path: ORDERS, line: 11, side: 'LEFT', body: '消した理由を知りたいです' },
    { path: ORDERS, line: 12, side: 'RIGHT', body: 'ここは右側です' },
  ])
  await ui.unmount()
})

// order-list.tsx: a block that only moved its indent (old 10-11 to new 11-12) inside a new wrapper,
// and one line whose text changed. filter.ts: an indent changed and nothing else.
const INDENT_DIFF = [
  'diff --git a/x b/x',
  `--- a/${ORDERS}`,
  `+++ b/${ORDERS}`,
  '@@ -9,4 +9,6 @@',
  ' start',
  '-first()',
  '-second()',
  '-third()',
  '+if (ok) {',
  '+  first()',
  '+  second()',
  '+  changed()',
  '+}',
  'diff --git a/y b/y',
  `--- a/${FILTER}`,
  `+++ b/${FILTER}`,
  '@@ -1,1 +1,1 @@',
  '-const a = 1',
  '+  const a = 1',
].join('\n')

test('既定で、字下げだけ変わった行は変更として出ず、「空白の変更も表示」で出て、もう一度押すと隠れる', async ($, on) => {
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: INDENT_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()

  const folded = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  // The two lines that only moved read as unchanged, in their new text; what changed stays.
  expect(folded).toContain('    first()')
  expect(folded).toContain('    second()')
  expect(folded).not.toContain('- first()')
  expect(folded).toContain('- third()')
  expect(folded).toContain('+ if (ok) {')
  expect(folded).toContain('+   changed()')
  expect((await ui.find({ key: 'whitespace' }))?.props.label).toBe('空白の変更も表示')

  await ui.press({ key: 'whitespace' })
  await clock.settle()
  const whole = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  expect(whole).toContain('- first()')
  expect(whole).toContain('+   first()')
  expect((await ui.find({ key: 'whitespace' }))?.props.label).toBe('空白の変更を隠す')

  await ui.press({ key: 'whitespace' })
  await clock.settle()
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).not.toContain('- first()')
  await ui.unmount()
})

test('空白だけが変わったファイルでは、そう出て、表示に切り替えられる。別のファイルを開くと隠す表示に戻る', async ($, on) => {
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: INDENT_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_FILTER })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^空白だけの変更です。$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /const a = 1/ })).toBe(undefined)

  await ui.press({ key: 'whitespace' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^- const a = 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^空白だけの変更です。$/ })).toBe(undefined)

  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  expect((await ui.findAll({ type: 'Text' })).map(one => one.text)).not.toContain('- first()')
  expect((await ui.find({ key: 'whitespace' }))?.props.label).toBe('空白の変更も表示')
  await ui.unmount()
})

test('空白の変更が無いファイルには、切り替えのボタンが出ない', async ($, on) => {
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /^\+ const b = 2$/ })).toBeDefined()
  expect(await ui.find({ key: 'whitespace' })).toBe(undefined)
  await ui.unmount()
})

test('畳んだ表示の行から足したコメントは、確認で行に付く', async ($, on) => {
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: INDENT_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  // New line 11 is `  first()`: unchanged on the folded screen, an added line in the saved diff.
  await ui.press({ key: 'line:11' })
  await clock.settle()
  await ui.input({ key: 'line-comment', text: 'ここです', kind: 'submit' })
  await clock.settle()
  await ui.press({ key: 'back-to-detail' })
  await clock.settle()
  await ui.press({ key: 'comment' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /インライン 1 件/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /行に付く/ })).toBeDefined()
  await ui.unmount()
})

test('ほかのページの指摘の「この行へ」を押すと、その行のページに移る', async ($, on) => {
  const findings = [finding({ line: 250, reason: '3 ページ目の行の話' })]
  const { clock } = world(on, [review({ findings })], {}, { [DIFF_PATH]: LONG_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^このページに無い指摘$/ })).toBeDefined()
  await ui.press({ key: 'goto:f1' })
  await clock.settle()

  const texts = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  expect(texts.indexOf('3 ページ目の行の話')).toBeGreaterThan(texts.indexOf('+ line 250'))
  expect(texts).not.toContain('このページに無い指摘')
  expect(await ui.find({ key: 'goto:f1' })).toBe(undefined)
  await ui.unmount()
})

test('畳んだ表示では、畳んだあとの最終ページから先に進めない', async ($, on) => {
  // 150 lines that only moved their indent, then 60 added: 211 rows as saved, 61 once folded.
  const moved = Array.from({ length: 150 }, (_, index) => `call${index}()`)
  const diff = [
    'diff --git a/x b/x',
    `--- a/${ORDERS}`,
    `+++ b/${ORDERS}`,
    '@@ -1,150 +1,210 @@',
    ...moved.map(text => `-${text}`),
    ...moved.map(text => `+  ${text}`),
    ...Array.from({ length: 60 }, (_, index) => `+added${index}()`),
  ].join('\n')
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: diff })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  // Folded: the header, 150 unchanged rows and 60 added ones make three pages.
  expect((await ui.findAll({ type: 'Text', text: /^1–100 行目 \/ 211 行$/ })).length).toBe(2)
  await ui.press({ key: 'page-next:top' })
  await clock.settle()
  await ui.press({ key: 'page-next:top' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^201–211 行目 \/ 211 行$/ })).toBeDefined()
  expect(await ui.find({ key: 'page-next:top' })).toBe(undefined)

  // As saved it is longer: 361 rows, four pages, and the fold's last page is not its last.
  await ui.press({ key: 'whitespace' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^1–100 行目 \/ 361 行$/ })).toBeDefined()
  await ui.unmount()
})

// 1,200 added lines of one file: more than is kept (1,000 rows), and more than one page (100 rows).
const LONG_DIFF = [
  'diff --git a/x b/x',
  '--- /dev/null',
  `+++ b/${ORDERS}`,
  '@@ -0,0 +1,1200 @@',
  ...Array.from({ length: 1200 }, (_, index) => `+line ${index + 1}`),
].join('\n')

test('長いファイルは 100 行ずつ出て、次へと前へで行き来でき、最後のページに途中までの案内が出る', async ($, on) => {
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: LONG_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()

  // The first page: the hunk's header and 99 lines. A surface does not draw a long file's tree whole.
  expect(await ui.find({ type: 'Text', text: /^\+ line 99$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+ line 100$/ })).toBe(undefined)
  expect((await ui.findAll({ type: 'Text', text: /^1–100 行目 \/ 1000 行$/ })).length).toBe(2)
  expect(await ui.find({ key: 'page-prev:top' })).toBe(undefined)
  const lines = (await ui.findAll({ type: 'Button' })).filter(one => String(one.props.key).startsWith('line:'))
  expect(lines).toHaveLength(99)

  await ui.press({ key: 'page-next:bottom' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^\+ line 99$/ })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^\+ line 100$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+ line 199$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^101–200 行目 \/ 1000 行$/ })).toBeDefined()

  await ui.press({ key: 'page-prev:top' })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^\+ line 99$/ })).toBeDefined()

  for (let turn = 0; turn < 9; turn += 1) {
    await ui.press({ key: 'page-next:top' })
    await clock.settle()
  }
  // The last page: the rows kept end at line 999, and no page follows.
  expect(await ui.find({ type: 'Text', text: /^\+ line 999$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\+ line 1000$/ })).toBe(undefined)
  expect(await ui.find({ key: 'page-next:top' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /^長いので途中までです。$/ })).toBeDefined()
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/acme/widgets/pull/12/files')
  await ui.unmount()
})

test('ほかのページの行の指摘は、行番号を添えてファイルの先頭に出て、そのページでは行の下に出る', async ($, on) => {
  const findings = [
    finding({ line: 150, reason: '2 ページ目の行の話' }),
    finding({ id: 'f2', line: 1100, reason: '切れた先の行の話' }),
  ]
  const { clock } = world(on, [review({ findings })], {}, { [DIFF_PATH]: LONG_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  const first = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  expect(first.indexOf('2 ページ目の行の話')).toBeGreaterThan(first.indexOf('このページに無い指摘'))
  expect(first.indexOf('2 ページ目の行の話')).toBeLessThan(first.indexOf('+ line 1'))
  expect(first).toContain('L150 · 下読み · blocker')
  expect(first).toContain('L1100 · 下読み · blocker')

  await ui.press({ key: 'page-next:top' })
  await clock.settle()
  const second = (await ui.findAll({ type: 'Text' })).map(one => one.text)
  // On its own page the finding stands under its line, with no line number added.
  expect(second.indexOf('2 ページ目の行の話')).toBeGreaterThan(second.indexOf('+ line 150'))
  expect(second.indexOf('2 ページ目の行の話')).toBeLessThan(second.indexOf('+ line 151'))
  expect(second).toContain('下読み · blocker')
  expect(second.indexOf('切れた先の行の話')).toBeLessThan(second.indexOf('+ line 100'))
  await ui.unmount()
})

test('ページを進めたあと別のファイルを開いて戻ると、最初のページから出る。短いファイルにページ送りは出ない', async ($, on) => {
  const two = [LONG_DIFF, 'diff --git a/y b/y', `--- a/${FILTER}`, `+++ b/${FILTER}`, HUNK_FILTER].join('\n')
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: two })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  await ui.press({ key: 'page-next:top' })
  await clock.settle()
  await ui.press({ key: FILE_FILTER })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^\+ const w = 4$/ })).toBeDefined()
  expect(await ui.find({ key: 'page-next:top' })).toBe(undefined)
  expect(await ui.find({ type: 'Text', text: /行目 \// })).toBe(undefined)

  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /^\+ line 1$/ })).toBeDefined()
  await ui.unmount()
})

test('1 行に置く要素は、押せる行でボタン 1 つと Text 2 つまで', async ($, on) => {
  // The desktop app left the pane empty for a file of 340 rows at eight elements a row.
  const { clock } = world(on, [review({ findings: [] })], {}, { [DIFF_PATH]: LONG_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  const before = (await ui.findAll({})).length
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()

  // 99 lines and a header, the pagers and the notes around them.
  expect((await ui.findAll({})).length - before).toBeLessThan(99 * 4 + 30)
  await ui.unmount()
})

test('パスの長いファイルでも、ボタンの key は短く、押すと開く', async ($, on) => {
  // A surface cuts a long key, and a press on the cut key reaches no Button.
  const deep = 'features/leads/detail/components/leadDetailMobileTabView/leadDetailMobileTabView.tsx'
  const diff = ['diff --git a/x b/x', `--- a/${deep}`, `+++ b/${deep}`, '@@ -1,1 +1,2 @@', ' keep', '+added'].join('\n')
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: diff })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  const keys = (await ui.findAll({ type: 'Button' })).map(one => String(one.props.key))
  expect(keys.filter(key => key.length > 32)).toEqual([])
  await ui.press({ key: 'file:0' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /^\+ added$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^leadDetailMobileTabView\.tsx$/ })).toBeDefined()
  await ui.unmount()
})

test('hunk の無いファイルを開くと、表示できる差分が無いと出る', async ($, on) => {
  const binary = ['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'].join('\n')
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: binary })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: 'file:0' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /^表示できる差分がありません。$/ })).toBeDefined()
  await ui.unmount()
})

test('制御文字を含む行でも画面が出て、置き換えた文字で描かれる', async ($, on) => {
  const dirty = [
    'diff --git a/x b/x',
    `--- a/${FILTER}`,
    `+++ b/${FILTER}`,
    '@@ -1,1 +1,2 @@',
    ' keep',
    '+\tif (isAdmin‮) {\u001b[31m',
  ].join('\n')
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: dirty })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: 'file:0' })
  await clock.settle()

  // The tab's two spaces lead the line, so they are drawn as no-break spaces.
  expect(await ui.find({ type: 'Text', text: /^\+   if \(isAdmin�\) \{�\[31m$/ })).toBeDefined()
  expect(await ui.find({ key: 'line:2' })).toBeDefined()
  await ui.unmount()
})

test('「← 詳細」で詳細に戻り、別の PR を選ぶと差分の画面は持ち越されない', async ($, on) => {
  const other = review({ key: OTHER, url: 'https://github.com/acme/widgets/pull/13' })
  const { clock } = world(on, [review(), other], {}, {
    [DIFF_PATH]: SCREEN_DIFF,
    [`${DATA}/diffs/acme/widgets/13/${SHA}.diff`]: SCREEN_DIFF,
  })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  await ui.press({ key: 'back-to-detail' })
  await clock.settle()
  expect(await ui.find({ key: 'read' })).toBeDefined()
  expect(await ui.find({ key: FILE_ORDERS })).toBe(undefined)

  await ui.press({ key: 'diff-view' })
  await clock.settle()
  // Opened again, the screen starts with every file closed.
  expect(await ui.find({ type: 'Text', text: /const b = 2/ })).toBe(undefined)
  await ui.press({ key: 'back-to-detail' })
  await clock.settle()
  await ui.press({ key: 'back-to-list' })
  await clock.settle()
  await ui.press({ key: `row:${OTHER}` })
  await clock.settle()
  expect(await ui.find({ key: 'read' })).toBeDefined()
  expect(await ui.find({ key: 'back-to-detail' })).toBe(undefined)
  await ui.unmount()
})

test('行の入力欄を開いたまま「← 詳細」で戻ると、詳細に追加フォームは開いていない', async ($, on) => {
  const { clock } = world(on, [review()], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  await ui.press({ key: FILE_FILTER })
  await clock.settle()
  await ui.press({ key: 'line:41' })
  await clock.settle()
  await ui.press({ key: 'back-to-detail' })
  await clock.settle()

  expect(await ui.find({ key: 'add-body' })).toBe(undefined)
  expect(await ui.find({ key: 'add' })).toBeDefined()
  await ui.unmount()
})

test('ファイルを読んでいる間に別のファイルへ切り替えても、先のファイルの差分は出ない', async ($, on) => {
  const { clock, disk } = world(on, [review()], {}, { [DIFF_PATH]: SCREEN_DIFF })
  await begin($, clock)

  const ui = await openDiffScreen($, clock)
  let release = () => {}
  disk.hold = new Promise<void>(resolve => {
    release = resolve
  })
  // The first file's read waits; the second is opened and read; only then does the first come back.
  await ui.press({ key: FILE_ORDERS })
  await clock.settle()
  await ui.press({ key: FILE_FILTER })
  await clock.settle()
  release()
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /^\+ const w = 4$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /const b = 2/ })).toBe(undefined)
  await ui.unmount()
})

test('ファイル一覧を読んでいる間に別の PR を選ぶと、先の PR の差分の画面は出ない', async ($, on) => {
  const other = review({ key: OTHER, url: 'https://github.com/acme/widgets/pull/13' })
  const { clock, disk } = world(on, [review(), other], {}, {
    [DIFF_PATH]: SCREEN_DIFF,
    [`${DATA}/diffs/acme/widgets/13/${SHA}.diff`]: SCREEN_DIFF,
  })
  await begin($, clock)

  const ui = await openDetail($, clock)
  let release = () => {}
  disk.hold = new Promise<void>(resolve => {
    release = resolve
  })
  await ui.press({ key: 'diff-view' })
  await clock.settle()
  await ui.press({ key: 'back-to-list' })
  await clock.settle()
  await ui.press({ key: `row:${OTHER}` })
  await clock.settle()
  // A comment being added on the other review: the late read must not end it.
  await ui.press({ key: 'add' })
  await clock.settle()
  release()
  await clock.settle()

  // The other review's detail stays as it was; nothing of the first one's diff landed on it.
  expect(await ui.find({ key: 'add-body' })).toBeDefined()
  expect(await ui.find({ key: 'read' })).toBeDefined()
  expect(await ui.find({ key: 'back-to-detail' })).toBe(undefined)
  // Nor is it waiting for the first review to be selected again.
  await ui.press({ key: 'back-to-list' })
  await clock.settle()
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()
  expect(await ui.find({ key: 'read' })).toBeDefined()
  expect(await ui.find({ key: 'back-to-detail' })).toBe(undefined)
  await ui.unmount()
})

// ---- the comment an approval goes with ----

const approvable = () => review({ findings: [finding({ severity: 'recommended', isAdopted: false })] })

test('承認の確認に、初期値の LGTM! が本文として出る', async ($, on) => {
  const { clock } = world(on, [approvable()])
  await begin($, clock)

  const ui = await openDetail($, clock)
  expect((await ui.find({ key: 'approve' }))?.props.value).toBe('LGTM!')
  await ui.input({ key: 'approve', text: 'LGTM!', kind: 'submit' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /承認として送ります/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /インライン 0 件 · 本文あり/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^LGTM!$/ })).toBeDefined()
  await ui.unmount()
})

test('PR コメント欄に書いて送ると、その文面が承認の確認に出る', async ($, on) => {
  const { clock } = world(on, [approvable()])
  await begin($, clock)

  const ui = await openDetail($, clock)
  await ui.input({ key: 'approve', text: 'ありがとうございます！', kind: 'submit' })
  await clock.settle()

  expect(await ui.find({ type: 'Text', text: /^ありがとうございます！$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^LGTM!$/ })).toBe(undefined)
  await ui.unmount()
})

test('書いた PR コメントは、別の PR を選ぶと初期値に戻る', async ($, on) => {
  const { clock } = world(on, [approvable()])
  await begin($, clock)

  const ui = await openDetail($, clock)
  await ui.input({ key: 'approve', text: '書きかけ' })
  await clock.settle()
  await ui.press({ key: 'back-to-list' })
  await clock.settle()
  await ui.press({ key: `row:${KEY}` })
  await clock.settle()

  expect((await ui.find({ key: 'approve' }))?.props.value).toBe('LGTM!')
  await ui.unmount()
})

test('承認できない PR では PR コメント欄が出ない', async ($, on) => {
  const { clock } = world(on, [review()])
  await begin($, clock)

  const ui = await openDetail($, clock)

  expect(await ui.find({ key: 'approve' })).toBe(undefined)
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
