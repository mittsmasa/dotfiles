// Everything that reaches outside the module: gh, git, the mechanical checks,
// the reviewer subagent, the store. The decisions are in reviews.ts.
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { History, Inbox, Mode, Placement, Review, ReviewEvent } from '../types'
import { fileDiff, filesOf, hunkAt, pageCountOf, shownRows } from './diff'
import type { RepoConfig } from './reviews'
import {
  checksToRun,
  expandArgv,
  failureOf,
  outputsOf,
  resolveViewpoints,
  summarizeChecks,
  takesFiles,
  warningLine,
} from './profile'
import type { CheckResult } from './profile'
import {
  DEFAULT_APPROVE_COMMENT,
  addHumanComment,
  buildReviewPayload,
  canApprove,
  canComment,
  editComment,
  headArgs,
  headOf,
  parseDiffLines,
  parseLeftLines,
  setAllAdopted,
  postArgs,
  postedUrlOf,
  splitForReview,
  toggleAdopted,
} from './posting'
import {
  REVIEWER_SYSTEM,
  isCheckoutSafe,
  guardOf,
  acceptReviewerOutput,
  historyArgs,
  historyOf,
  previousFile,
  withHistories,
  acceptedCopyOf,
  applyFetchResult,
  CONFIG_FILE,
  conversationArgs,
  conversationFile,
  criteriaFor,
  criteriaRoot,
  fail,
  isAllowedToolCall,
  isDue,
  isScript,
  lastRequestedAt,
  mergeSearches,
  originMatches,
  parseConfig,
  parseKey,
  parseReviewerJson,
  recoverOnStart,
  requestedArgs,
  resolveClone,
  reviewerPrompt,
  reviewFromSaved,
  buildSearchArgv,
  searchedKeys,
  timeoutAction,
  toPosted,
  viewArgs,
} from './reviews'

export const REVIEWER = 'pr-review-inbox:reviewer'
const EMPTY: Inbox = { reviews: [], isFetching: false, withDiff: [] }

// register.tsx declares the same atom for its reads: the validator reads an
// atom's reference only in the file that uses it.
const inboxAtom = atom({ plugin: 'pr-review-inbox', key: 'inbox' } as const, EMPTY, {
  shape: 'inbox-2',
})

export type Config = {
  repos: Record<string, string>
  criteria: RepoConfig['criteria']
  sources: string[]
  clonePath?: string
  profile: RepoConfig['profile']
  schedule: RepoConfig['schedule']
  /** The viewpoint files that are plain files, in reading order; not yet resolved. */
  viewpoints: string[]
  /** What the config file had wrong, shown after a fetch. */
  warnings: string[]
  utcOffsetMinutes: number
  home: string
  dataDir: string
}

/** One commit of one pull request: what a saved result is filed under. */
type Commit = Pick<Review, 'key' | 'headSha'>

type Running = {
  key: string
  agentId: string
  repo: string
  worktree: string
  resultPath: string
  allowedRoots: string[]
}

/** How many reviews go at once: those a reviewer is at work on, and those being set up for one. */
const MAX_PARALLEL = 3

// The module's own copy of what the store holds; rebuilt by `init` on a reload.
let inbox: Inbox = EMPTY
let reviewerAgentIds: string[] = []
let running: Running[] = []
// The reviews being set up for a reviewer. They stay `queued` until it starts,
// so `pump` must not pick them again.
const preparing = new Set<string>()
// Woken whenever `running` or `preparing` changes: a tool call may be waiting on its reviewer's spawn.
let waiters: (() => void)[] = []
// Store writes go through one line: two hooks merging at once lose a write.
let line: Promise<unknown> = Promise.resolve()
// Git writes to one clone go one at a time: two fetches fight over the same ref locks.
const repoLines = new Map<string, Promise<unknown>>()

function wake() {
  const woken = waiters
  waiters = []
  for (const one of woken) one()
}

/** Runs `fn` once every git write queued before it on `repo` has ended; a failure holds up none after it. */
function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const step = (repoLines.get(repo) ?? Promise.resolve()).then(fn)
  repoLines.set(
    repo,
    step.catch(() => undefined),
  )

  return step
}

// ---- which session runs the inbox ----

// Kept in the session's state so a reload finds it; register.tsx declares the
// same atom for its reads.
const activeAtom = atom({ plugin: 'pr-review-inbox', key: 'isActive' } as const, false)

// This module's copy of the atom, for the paths that cannot await a read.
let isActive = false
let sessionId: string | undefined
let fetchTimer: { cancel: () => void } | undefined
let isRegistered = false
let hasLoadedReviewers = false

async function knownReviewers($: EngineInterface): Promise<readonly string[]> {
  if (!hasLoadedReviewers) {
    reviewerAgentIds = ((await $.store.get('reviewerAgentIds')) as string[] | undefined) ?? []
    hasLoadedReviewers = true
  }

  return reviewerAgentIds
}

/**
 * Makes this session the one running the inbox: the last session to ask wins,
 * and the one that had it stops at its next fetch. Safe to call again.
 */
export async function activate($: EngineInterface, config: Config, via: 'command' | 'session.start') {
  sessionId ??= await $.session.id()
  await $.store.set('owner', { sessionId })
  if (!isRegistered) {
    await $.agent.register({
      name: 'reviewer',
      description: 'Pre-reads one pull request for the PR review inbox (spawned by the mod only)',
      prompt: REVIEWER_SYSTEM,
      tools: ['Read', 'Grep', 'Glob', 'Write'],
      omitClaudeMd: true,
    })
    isRegistered = true
  }
  const wasActive = isActive
  isActive = true
  await update($, activeAtom, () => true)
  // Taking the inbox over: what the last session left running is cut off here.
  if (!wasActive) {
    await init($, config)
    await $.fs
      .write(`${config.dataDir}/active.json`, JSON.stringify({ sessionId, via, at: (await now($)).toISOString() }))
      .catch(() => undefined)
  }
  fetchTimer?.cancel()
  fetchTimer = $.clock.every(config.schedule.intervalMinutes * 60_000, () => void tick($, config))
  if (!wasActive) $.clock.after(500, () => void tick($, config))
}

/** Stops this session's inbox: its timer, its pane, and the review it had running. */
async function stop($: EngineInterface, config: Config) {
  fetchTimer?.cancel()
  fetchTimer = undefined
  isActive = false
  await update($, activeAtom, () => false)
  const mine = running
  // The store's `running` is the new owner's now: only this copy is dropped.
  running = []
  wake()
  for (const one of mine) await removeWorktree($, config, one.key)
  await $.ui.close({ id: 'review-inbox' }).catch(() => undefined)
}

/** True while this session still owns the inbox; stops it the moment it does not. */
async function ensureOwner($: EngineInterface, config: Config): Promise<boolean> {
  if (!isActive) return false
  const owner = (await $.store.get('owner')) as { sessionId?: string } | undefined
  if (owner?.sessionId === sessionId) return true
  await stop($, config)

  return false
}

function mutate($: EngineInterface, change: (inbox: Inbox) => Inbox): Promise<void> {
  const step = line.then(async () => {
    const before = inbox
    inbox = change(inbox)
    // What the pane is doing (a selection, a draft) is not worth a store write.
    if (inbox.reviews !== before.reviews || inbox.lastFetchedAt !== before.lastFetchedAt) {
      await $.store.set('inbox', { reviews: inbox.reviews, lastFetchedAt: inbox.lastFetchedAt })
    }
    await update($, inboxAtom, () => inbox)
  })
  line = step.catch(() => undefined)

  return step
}

// `$` crosses a file only into function declarations: the validator follows no other.
function patch($: EngineInterface, key: string, change: (review: Review) => Review) {
  return mutate($, state => ({
    ...state,
    reviews: state.reviews.map(review => (review.key === key ? change(review) : review)),
  }))
}

export function select($: EngineInterface, key: string | undefined) {
  return mutate($, state =>
    isSending
      ? state
      : {
          ...state,
          selectedKey: key,
          mode: undefined,
          openFindingId: undefined,
          openDiff: undefined,
          diffView: undefined,
          isBodyOpen: false,
          approveComment: undefined,
        },
  )
}

export function toggleBody($: EngineInterface) {
  return mutate($, state => ({ ...state, isBodyOpen: !state.isBodyOpen }))
}

export function setApproveComment($: EngineInterface, text: string) {
  return mutate($, state => (isSending ? state : { ...state, approveComment: text }))
}

// A hunk longer than this is not drawn: one drawing holds 100,000 characters in all.
const HUNK_MAX_CHARS = 50_000

/**
 * Opens one finding of the selected review, closing the one that was open,
 * and reads the diff hunk it sits in. A request being confirmed or sent stays
 * up: its findings can be read against the diff before it goes.
 */
export async function openFinding($: EngineInterface, config: Config, id: string) {
  await mutate($, state => {
    const isConfirming = state.mode?.kind === 'confirm' || state.mode?.kind === 'sending'

    return {
      ...state,
      mode: isConfirming ? state.mode : undefined,
      openFindingId: state.openFindingId === id ? undefined : id,
      openDiff: undefined,
    }
  })
  const key = inbox.selectedKey
  const review = inbox.reviews.find(one => one.key === key)
  const finding = review?.findings.find(one => one.id === id)
  const path = review && diffPathOf(config, review)
  if (inbox.openFindingId !== id || !path || finding?.file === undefined || finding.line === undefined) return
  const { file, line } = finding
  const diff = await $.fs.read(path).then(String, () => undefined)
  const source = diff === undefined ? undefined : hunkAt(diff, file, line, finding.side ?? 'RIGHT')
  if (source === undefined || source.length > HUNK_MAX_CHARS) return
  // The read took a while: only the finding still open, of the review still selected, gets it.
  await mutate($, state =>
    state.selectedKey === key && state.openFindingId === id ? { ...state, openDiff: { id, source } } : state,
  )
}

// ---- the diff screen ----

// One file's diff drawn at once: a drawing holds 100,000 characters in all,
// and each row adds its line numbers.
const DIFF_FILE_LIMITS = { chars: 50_000, rows: 1000 }

const isLineComment = (mode: Mode | undefined) => mode?.kind === 'add' && mode.at !== undefined

/**
 * Opens the diff screen of the selected review: reads its saved diff and lists
 * the files. A request being confirmed or sent stays up; any other mode ends.
 */
export async function openDiffView($: EngineInterface, config: Config, key: string) {
  const review = inbox.reviews.find(one => one.key === key)
  const path = review && diffPathOf(config, review)
  if (!path || inbox.selectedKey !== key) return
  const diff = await $.fs.read(path).then(String, () => undefined)
  if (diff === undefined) return refreshWithDiff($, config)
  const files = filesOf(diff)
  // The read took a while: only the review still selected gets its screen.
  await mutate($, state => {
    const isConfirming = state.mode?.kind === 'confirm' || state.mode?.kind === 'sending'

    return state.selectedKey === key
      ? { ...state, mode: isConfirming ? state.mode : undefined, diffView: { key, files } }
      : state
  })
}

/** Back to the detail. A comment being written on a line ends with the screen it was on. */
export function closeDiffView($: EngineInterface) {
  wantedDiffFile = undefined

  return mutate($, state => ({
    ...state,
    diffView: undefined,
    mode: isLineComment(state.mode) ? undefined : state.mode,
  }))
}

// The file last asked for on the diff screen: a slower read of another must not land.
let wantedDiffFile: string | undefined

/** Opens one file of the diff screen, closing the one that was open; the open one closes. */
export async function openDiffFile($: EngineInterface, config: Config, path: string) {
  const view = inbox.diffView
  if (!view || view.key !== inbox.selectedKey) return
  const key = view.key
  const review = inbox.reviews.find(one => one.key === key)
  const diffPath = review && diffPathOf(config, review)
  if (!diffPath) return
  const isClosing = view.open?.path === path
  wantedDiffFile = isClosing ? undefined : path
  await mutate($, state =>
    state.diffView?.key === key
      ? {
          ...state,
          mode: isLineComment(state.mode) ? undefined : state.mode,
          diffView: { key, files: state.diffView.files },
        }
      : state,
  )
  if (isClosing) return
  const diff = await $.fs.read(diffPath).then(String, () => undefined)
  if (diff === undefined) return
  const open = { path, ...fileDiff(diff, path, DIFF_FILE_LIMITS), page: 0 }
  await mutate($, state =>
    state.selectedKey === key && state.diffView?.key === key && wantedDiffFile === path
      ? { ...state, diffView: { ...state.diffView, open } }
      : state,
  )
}

/** Turns the open file's page by `by`, staying within its pages. A comment being written on a line ends. */
export function turnDiffPage($: EngineInterface, by: number) {
  return mutate($, state => {
    const open = state.diffView?.open
    if (!state.diffView || !open) return state
    // Counted as the screen draws the file: folded unless whitespace is shown.
    const last = pageCountOf(shownRows(open.source, state.diffView.showsWhitespace === true).length) - 1
    const page = Math.min(last, Math.max(0, open.page + by))

    return {
      ...state,
      mode: isLineComment(state.mode) ? undefined : state.mode,
      diffView: { ...state.diffView, open: { ...open, page } },
    }
  })
}

/** Shows the open file as saved, or folds its changes of whitespace again; either starts at its first page. */
export function toggleWhitespace($: EngineInterface) {
  return mutate($, state => {
    const open = state.diffView?.open
    if (!state.diffView || !open) return state

    return {
      ...state,
      mode: isLineComment(state.mode) ? undefined : state.mode,
      diffView: { ...state.diffView, open: { ...open, page: 0 }, showsWhitespace: state.diffView.showsWhitespace !== true },
    }
  })
}

/**
 * Starts a comment on a line of the diff: only on a review that can still be
 * sent. `LEFT` is a removed line, numbered in the file before the change.
 */
export function startLineComment($: EngineInterface, file: string, line: number, side?: 'LEFT') {
  return mutate($, state => {
    const review = state.reviews.find(one => one.key === state.selectedKey)
    const isBusy = isSending || state.mode?.kind === 'confirm' || state.mode?.kind === 'sending'
    const isOnDiff = state.diffView !== undefined && state.diffView.key === state.selectedKey

    return !review || !isOpen(review) || isBusy || !isOnDiff
      ? state
      : { ...state, mode: { kind: 'add', place: '', at: { file, line, ...(side ? { side } : {}) } } }
  })
}

export function setMode($: EngineInterface, mode: Mode | undefined) {
  return mutate($, state => (isSending ? state : { ...state, mode }))
}

export async function markRead($: EngineInterface, config: Config, key: string) {
  await mutate($, state => ({
    ...state,
    selectedKey: undefined,
    openDiff: undefined,
    diffView: undefined,
    reviews: state.reviews.map(review => (review.key === key ? { ...review, isRead: true } : review)),
  }))
  // The checkout was kept for a deep dive; a reviewer at work, or being set up, keeps its own.
  if (!running.some(one => one.key === key) && !preparing.has(key)) await removeWorktree($, config, key)
}

/**
 * What a deep dive of a finished review can start from: the checkout the
 * pre-read left, and the result this mod accepted. Each only where it exists.
 */
export async function deepDiveContext(
  $: EngineInterface,
  config: Config,
  key: string,
): Promise<{ worktree?: string; resultPath?: string }> {
  const review = inbox.reviews.find(one => one.key === key)
  if (!review || review.status !== 'done') return {}
  const place = worktreeOf(config, key)
  const saved = savedPathsOf(config, review)
  const hasWorktree = place !== undefined && isCheckoutSafe(review) && (await $.fs.exists(place.worktree))
  const hasResult = saved !== undefined && (await $.fs.exists(saved.accepted))

  return {
    ...(hasWorktree ? { worktree: place.worktree } : {}),
    ...(hasResult ? { resultPath: saved.accepted } : {}),
  }
}

async function now($: EngineInterface) {
  return new Date(await $.clock.now())
}
const firstLine = (text: string) => text.trim().split('\n')[0]?.slice(0, 160) ?? ''
const git = (args: string[]) => ['git', '-c', 'core.hooksPath=/dev/null', ...args]

async function run($: EngineInterface, argv: string[], config: Config, timeoutMs = 60_000) {
  // Never inside a checkout: a pull request's own tool config must not be read.
  return $.process.run(argv, { cwd: config.dataDir, timeoutMs })
}

async function must($: EngineInterface, argv: string[], config: Config, what: string, timeoutMs?: number) {
  const ran = await run($, argv, config, timeoutMs)
  if (ran.exitCode !== 0) throw new Error(`${what}: ${firstLine(ran.stderr)}`)

  return ran
}

async function realPath($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath
  } catch {
    return undefined
  }
}

export async function makeConfig($: EngineInterface, options: Readonly<Record<string, unknown>>): Promise<Config> {
  const home = (await $.env.get('HOME')) ?? ''
  const offset = Number(options.utcOffsetMinutes)
  const text = await $.fs.read(`${home}/${CONFIG_FILE}`).then(String, () => undefined)
  const { repos, criteria, sources, clonePath, profile, schedule, warnings } = parseConfig(text, home)
  const picked = await resolveViewpoints(profile.viewpoints, {
    list: path => $.fs.list(path),
    stat: path => $.fs.stat(path),
  })

  return {
    home,
    repos,
    criteria,
    sources,
    ...(clonePath ? { clonePath } : {}),
    profile,
    schedule,
    viewpoints: picked.files,
    warnings: [...warnings, ...picked.warnings],
    utcOffsetMinutes: Number.isFinite(offset) ? offset : 0,
    dataDir: `${home}/.cache/pr-review-inbox`,
  }
}

export async function init($: EngineInterface, config: Config) {
  await $.process.run(['mkdir', '-p', config.dataDir])
  const stored = (await $.store.get('inbox')) as Partial<Inbox> | undefined
  const before = Array.isArray(stored?.reviews) ? stored.reviews : []
  await knownReviewers($)
  // A reload leaves the reviewers it had running at work: the mod cannot stop
  // them, so they are taken up again rather than cut off under their feet.
  const left = runningFromStore(await $.store.get('running'))
  const alive = await aliveAgentIds($)
  const kept = left.filter(
    one =>
      alive.includes(one.agentId) &&
      before.some(review => review.key === one.key && review.status === 'reviewing' && review.agentId === one.agentId),
  )
  await setRunning($, kept)
  isSending = false
  inbox = EMPTY
  await mutate($, () => ({
    ...EMPTY,
    reviews: recoverOnStart(
      before,
      kept.map(one => one.agentId),
    ),
    lastFetchedAt: stored?.lastFetchedAt,
  }))
  await refreshWithDiff($, config)
  // A review cut off by a restart leaves its worktree behind.
  for (const review of before.filter(one => one.status === 'reviewing' && !kept.some(k => k.key === one.key))) {
    await removeWorktree($, config, review.key)
  }
  for (const one of kept) await onTimeout($, config, one.key)
}

/** The store's `running`: a list now; one review, or null, before reviews ran side by side. */
function runningFromStore(value: unknown): Running[] {
  if (Array.isArray(value)) return value as Running[]

  return value !== null && typeof value === 'object' ? [value as Running] : []
}

/** Keeps `running` in the store too, so a reload can take its reviewers up again. */
async function setRunning($: EngineInterface, value: Running[]) {
  // Set before the store write: a reviewer's first tool call may be waiting on it.
  running = value
  wake()
  await $.store.set('running', value)
}

const ALIVE = new Set(['pending', 'running', 'waiting'])

/** This session's agents still at work; none when the engine cannot say. */
async function aliveAgentIds($: EngineInterface): Promise<string[]> {
  try {
    return (await $.agent.list()).filter(agent => ALIVE.has(agent.status)).map(agent => agent.id)
  } catch {
    return []
  }
}

function worktreeOf(config: Config, key: string) {
  const parsed = parseKey(key)
  const repo = parsed && resolveClone(config, parsed.fullName)

  return parsed && repo ? { repo, worktree: `${repo}/.claude/worktrees/review-${parsed.number}` } : undefined
}

async function removeWorktree($: EngineInterface, config: Config, key: string) {
  const place = worktreeOf(config, key)
  if (!place) return
  await withRepoLock(place.repo, () => removeWorktreeAt($, config, place))
}

/** Only from inside `withRepoLock` on the same clone. */
async function removeWorktreeAt($: EngineInterface, config: Config, place: { repo: string; worktree: string }) {
  await run($, git(['-C', place.repo, 'worktree', 'remove', '--force', place.worktree]), config).catch(
    () => undefined,
  )
}

// ---- fetching ----

export async function fetchNow($: EngineInterface, config: Config) {
  if (inbox.isFetching || !(await ensureOwner($, config))) return
  await mutate($, state => ({ ...state, isFetching: true, fetchError: undefined }))
  let fetchError: string | undefined
  try {
    if (config.sources.length === 0) throw new Error(`~/${CONFIG_FILE} にリポジトリを設定してください`)
    const searches = []
    for (const source of config.sources) searches.push(await run($, buildSearchArgv(source), config))
    const search = mergeSearches(searches)
    const views = []
    for (const key of searchedKeys(search) ?? []) {
      const argv = viewArgs(key)
      views.push({ key, ...(argv ? await run($, argv, config) : { exitCode: 1, stdout: '' }) })
    }
    const stored = inbox.reviews
    // A review that was sent and is asked for again starts over at the same head.
    const reRequested = new Map<string, string>()
    for (const view of views) {
      const headSha = view.exitCode === 0 ? headOf(view.stdout) : undefined
      if (headSha === undefined || !/^[0-9a-f]{40}$/.test(headSha)) continue
      const sentAt = await sentAtOf($, config, stored, { key: view.key, headSha })
      const argv = sentAt === undefined ? undefined : requestedArgs(view.key)
      if (sentAt === undefined || !argv) continue
      const asked = await run($, argv, config)
      const requestedAt = asked.exitCode === 0 ? lastRequestedAt(asked.stdout) : undefined
      if (requestedAt === undefined) throw new Error(firstLine(asked.stderr) || 'レビュー依頼の履歴を読めませんでした')
      if (requestedAt !== null && Date.parse(requestedAt) > Date.parse(sentAt)) reRequested.set(view.key, headSha)
    }
    const fetched = applyFetchResult({ search, views }, stored, new Set(reRequested.keys()))
    if (fetched === stored) throw new Error(firstLine(search.stderr) || '取得結果を読めませんでした')
    // My earlier reviews of each: one that cannot be read keeps what was held, and fails nothing.
    const histories = new Map<string, History | null | undefined>()
    for (const review of fetched) {
      const argv = historyArgs(review.key)
      const asked = argv ? await run($, argv, config).catch(() => undefined) : undefined
      histories.set(review.key, asked?.exitCode === 0 ? historyOf(asked.stdout) : undefined)
    }
    const next = withHistories(fetched, histories, stored)
    // Only once the fetch is good: a failed one leaves the saved results too.
    for (const [key, headSha] of reRequested) await dropSaved($, config, { key, headSha })
    const fetchedAt = (await now($)).toISOString()
    await mutate($, state => ({ ...state, reviews: [...next], lastFetchedAt: fetchedAt }))
  } catch (error) {
    fetchError = firstLine(String(error instanceof Error ? error.message : error))
  }
  // A fetch that went well still says what the config file had wrong.
  const shown = fetchError ?? warningLine(config.warnings)
  await mutate($, state => ({ ...state, isFetching: false, fetchError: shown }))
  await pump($, config)
}

/** When a review of this commit was sent: what the store holds, or the note left beside its result. */
async function sentAtOf(
  $: EngineInterface,
  config: Config,
  stored: readonly Review[],
  commit: Commit,
): Promise<string | undefined> {
  const held = stored.find(review => review.key === commit.key && review.headSha === commit.headSha)
  if (held?.postedAt !== undefined) return held.postedAt
  const saved = savedPathsOf(config, commit)
  const note = saved && (await $.fs.read(saved.posted).then(String, () => undefined))

  return note === undefined ? undefined : toPosted(parseReviewerJson(note, undefined))?.postedAt
}

export async function tick($: EngineInterface, config: Config) {
  if (isActive && isDue(await now($), config.utcOffsetMinutes, config.schedule)) await fetchNow($, config)
}

// ---- reviewing, up to MAX_PARALLEL at once ----

export async function pump($: EngineInterface, config: Config) {
  if (!(await ensureOwner($, config))) return
  // Picked and marked with no await between: two pumps at once must not pick the same review.
  const free = MAX_PARALLEL - running.length - preparing.size
  const next = inbox.reviews
    .filter(
      review =>
        review.status === 'queued' && !preparing.has(review.key) && !running.some(one => one.key === review.key),
    )
    .slice(0, Math.max(0, free))
  for (const review of next) preparing.add(review.key)
  await Promise.all(next.map(review => startReview($, config, review)))
}

export async function retry($: EngineInterface, config: Config, key: string) {
  const failed = inbox.reviews.find(review => review.key === key && review.status === 'failed')
  if (failed) await dropSaved($, config, failed)
  await patch($, key, review =>
    review.status === 'failed' ? { ...review, status: 'queued', failReason: undefined } : review,
  )
  await pump($, config)
}

/**
 * Runs the checks the config sets; with none set, nothing runs and nothing is
 * reported as left out. Without a changed script to check, only the checks
 * that are not handed the scripts run (`checksToRun`). A check fails only when it
 * cannot start, times out, or leaves an output it names missing: a lint that
 * finds something exits non-zero and its output is the point. `outputs` is
 * absent when nothing ran at all; the reviewer then gets no output directory.
 */
async function mechanicalChecks(
  $: EngineInterface,
  config: Config,
  review: Review,
  worktreeReal: string,
  scanDir: string,
): Promise<{ skipped: string[]; outputs?: { name: string; files: string[] }[] }> {
  const { checks } = config.profile
  if (checks.length === 0) return { skipped: [] }
  const targets: string[] = []
  const scripts = checks.some(takesFiles) ? review.files.filter(isScript).slice(0, 200) : []
  for (const file of scripts) {
    const stat = await $.fs.stat(`${worktreeReal}/${file}`, { resolve: true }).catch(() => undefined)
    // A link may point outside the checkout; only plain files inside it are scanned.
    const isInside = stat?.realPath?.startsWith(worktreeReal + '/') === true
    if (stat && stat.kind === 'file' && !stat.isLink && isInside) targets.push(stat.realPath as string)
  }
  const plan = checksToRun(checks, targets.length)
  if (plan.run.length === 0) return { skipped: plan.skipped }
  const results: CheckResult[] = []
  for (const check of plan.run) {
    const written = outputsOf(check).map(name => `${scanDir}/${name}`)
    // A retry at the same head must not read what an earlier run left.
    if (written.length > 0) await $.process.run(['rm', '-f', ...written])
    try {
      const argv = expandArgv(check.argv, { files: targets, worktree: worktreeReal, outDir: scanDir })
      const ran = await run($, argv, config, 180_000)
      if (check.stdout) await $.fs.write(`${scanDir}/${check.stdout}`, ran.stdout.slice(0, 3_000_000))
      const missing: string[] = []
      for (const name of check.outputs) if (!(await $.fs.exists(`${scanDir}/${name}`))) missing.push(name)
      const failure = failureOf(ran, missing)
      results.push(failure === undefined ? { check } : { check, failure })
    } catch (error) {
      results.push({ check, failure: firstLine(String(error instanceof Error ? error.message : error)) })
    }
  }

  const summary = summarizeChecks(results)

  return { ...summary, skipped: [...plan.skipped, ...summary.skipped] }
}

/** A file the config names, read whole; what could not be read goes to `skipped`. */
async function readNamed($: EngineInterface, path: string | undefined, label: string, skipped: string[]) {
  if (path === undefined) return undefined
  const text = await $.fs.read(path).then(String, () => undefined)
  if (text === undefined || text.trim() === '') skipped.push(`${label}（読めない。既定を使った）`)

  return text?.trim() ? text : undefined
}

/**
 * Fills a waiting review from the result this mod accepted for the same commit,
 * without a reviewer or a worktree. Only the copy written on accept is read:
 * the file a reviewer writes may come from one that was cut off.
 */
async function reuseSaved($: EngineInterface, config: Config, review: Review): Promise<boolean> {
  const saved = savedPathsOf(config, review)
  const diffPath = diffPathOf(config, review)
  if (!saved || !diffPath || !(await $.fs.exists(diffPath))) return false
  const accepted = await $.fs.read(saved.accepted).then(String, () => undefined)
  if (accepted === undefined) return false
  const posted = await $.fs.read(saved.posted).then(String, () => undefined)
  const reused = reviewFromSaved(
    review,
    parseReviewerJson(accepted, undefined),
    posted === undefined ? undefined : parseReviewerJson(posted, undefined),
    await now($),
  )
  if (!reused) return false
  await patch($, review.key, one =>
    one.status === 'queued' && one.headSha === review.headSha ? reused : one,
  )
  await refreshWithDiff($, config)

  return true
}

/** Sets one review up for a reviewer; `pump` has put its key in `preparing`, and it leaves here. */
async function startReview($: EngineInterface, config: Config, review: Review) {
  try {
    await prepareReview($, config, review)
  } finally {
    preparing.delete(review.key)
    wake()
  }
  await pump($, config)
}

async function prepareReview($: EngineInterface, config: Config, review: Review) {
  // A checkout kept from an earlier commit must not outlive it, reused result or not.
  await removeWorktree($, config, review.key)
  if (await reuseSaved($, config, review)) return
  const parsed = parseKey(review.key)
  const place = worktreeOf(config, review.key)
  let hasWorktree = false
  try {
    if (!parsed || !place || !(await $.fs.exists(place.repo))) throw new Error('clone なし')
    const { repo, worktree } = place
    const origin = await must($, git(['-C', repo, 'remote', 'get-url', 'origin']), config, 'origin を読めない')
    if (!originMatches(origin.stdout, parsed.fullName)) throw new Error('origin 不一致')

    await withRepoLock(repo, async () => {
      await removeWorktreeAt($, config, place)
      await must(
        $,
        git(['-C', repo, 'fetch', 'origin', `pull/${parsed.number}/head`, review.baseRefName]),
        config,
        'fetch 失敗',
        180_000,
      )
      await must($, git(['-C', repo, 'worktree', 'add', '--detach', worktree, review.headSha]), config, 'worktree 作成失敗', 180_000)
    })
    hasWorktree = true
    const worktreeReal = await realPath($, worktree)
    if (!worktreeReal) throw new Error('worktree を解決できない')

    const slot = `${parsed.fullName}/${parsed.number}`
    const scanDir = `${config.dataDir}/scan/${slot}/${review.headSha}`
    const diffPath = diffPathOf(config, review) as string
    const resultPath = `${config.dataDir}/results/${slot}/${review.headSha}.json`
    await $.process.run(['mkdir', '-p', scanDir, `${config.dataDir}/diffs/${slot}`, `${config.dataDir}/results/${slot}`])
    await $.process.run(['rm', '-f', resultPath])

    const diff = await must(
      $,
      git(['-C', worktree, 'diff', `origin/${review.baseRefName}...HEAD`]),
      config,
      'diff 失敗',
      120_000,
    )
    await $.fs.write(diffPath, diff.stdout.slice(0, 3_000_000))
    const skipped = [
      ...(diff.isStdoutTruncated || diff.stdout.length > 3_000_000 ? ['diff の一部（大きすぎる）'] : []),
    ]
    const checked = await mechanicalChecks($, config, review, worktreeReal, scanDir)
    skipped.push(...checked.skipped)

    // The criteria file is read only where it really lies inside the clone.
    const criteria = criteriaFor(parsed.fullName, review.files, config.criteria)
    const repoReal = await realPath($, repo)
    const criteriaReal = criteria ? await realPath($, `${repo}/${criteria}`) : undefined
    const criteriaPath = repoReal && criteriaReal ? criteriaRoot(repoReal, criteriaReal) : undefined
    // The viewpoints, opened file by file: the reviewer cannot load a skill.
    const skillFiles: string[] = []
    for (const file of config.viewpoints) {
      const real = await realPath($, file)
      if (real) skillFiles.push(real)
    }
    const { guide: guideSource, commentStyle: stylePath } = config.profile
    const guideText = await readNamed($, guideSource.kind === 'file' ? guideSource.path : undefined, 'review.guide', skipped)
    const commentStyle = await readNamed($, stylePath, 'review.commentStyle', skipped)
    const guide = guideText !== undefined ? { kind: 'text' as const, text: guideText } : { kind: 'generic' as const }
    // The points I raised before, for the reviewer to check against today's code. The folder
    // it is written to is one the reviewer already reads.
    const previous = previousFile(review.history)
    const previousPath = `${scanDir}/previous.json`
    const hasPrevious =
      previous !== undefined &&
      (await $.fs.write(previousPath, previous).then(
        () => true,
        () => false,
      ))
    // The comments and checks as they stand now, in the same folder. A failure here is only noted:
    // the review goes on without them.
    const conversationPath = `${scanDir}/conversation.json`
    const conversationArgv = conversationArgs(review.key)
    const conversationRun = conversationArgv ? await run($, conversationArgv, config).catch(() => undefined) : undefined
    const conversation = conversationRun?.exitCode === 0 ? conversationFile(conversationRun.stdout) : undefined
    const hasConversation =
      typeof conversation === 'string' &&
      (await $.fs.write(conversationPath, conversation).then(
        () => true,
        () => false,
      ))
    if (conversation === undefined || (typeof conversation === 'string' && !hasConversation)) {
      skipped.push('PR の会話と checks（取得失敗）')
    }
    const allowedRoots = [
      worktreeReal,
      await realPath($, scanDir),
      await realPath($, diffPath),
      criteriaPath,
      ...skillFiles,
    ].flatMap(one => one ?? [])

    const started = await $.agent.spawn({
      subagentType: REVIEWER,
      description: `review ${review.key}`,
      prompt: reviewerPrompt({
        key: review.key,
        headSha: review.headSha,
        worktree: worktreeReal,
        diffPath,
        ...(checked.outputs ? { scanDir, checkOutputs: checked.outputs } : {}),
        criteriaPath,
        skillFiles,
        guide,
        ...(commentStyle === undefined ? {} : { commentStyle }),
        resultPath,
        files: review.files,
        ...(hasPrevious ? { previousPath } : {}),
        ...(hasConversation ? { conversationPath } : {}),
      }),
    })
    if (started.agentId === undefined) throw new Error('reviewer を起動できない')
    const agentId = started.agentId
    // Known as this mod's reviewer at once: a session not running the inbox refuses it, kept or not.
    reviewerAgentIds = [...reviewerAgentIds, agentId].slice(-100)
    if (!isActive) {
      // The inbox stopped while this was set up. Nothing here can stop the reviewer:
      // it is left to end, refused every tool, and its checkout goes.
      await $.store.set('reviewerAgentIds', reviewerAgentIds)
      await removeWorktree($, config, review.key)

      return
    }
    await setRunning($, [...running, { key: review.key, agentId, repo, worktree, resultPath, allowedRoots }])
    await $.store.set('reviewerAgentIds', reviewerAgentIds)
    const startedAt = (await now($)).toISOString()
    await patch($, review.key, one => ({
      ...one,
      status: 'reviewing',
      agentId,
      reviewStartedAt: startedAt,
      skipped,
    }))
    await onTimeout($, config, review.key)
  } catch (error) {
    const reason = firstLine(String(error instanceof Error ? error.message : error))
    await patch($, review.key, one => fail(one, reason))
    if (hasWorktree) await removeWorktree($, config, review.key)
  }
}

/** `keepWorktree`: an accepted result leaves its checkout for a deep dive. */
async function finish($: EngineInterface, config: Config, key: string, keepWorktree = false) {
  if (!keepWorktree) await removeWorktree($, config, key)
  await setRunning(
    $,
    running.filter(one => one.key !== key),
  )
  await refreshWithDiff($, config)
  await pump($, config)
}

/** A reviewer's turn ended: take its result only if it is the one we wait on. */
export async function onTurnComplete(
  $: EngineInterface,
  config: Config,
  agentId: string,
  answer: string | undefined,
) {
  const mine = running.find(one => one.agentId === agentId)
  if (!mine) return
  const review = inbox.reviews.find(one => one.key === mine.key)
  if (!review) return finish($, config, mine.key)
  const fileText = await $.fs.read(mine.resultPath).then(String, () => undefined)
  const json = parseReviewerJson(fileText, answer)
  const accepted = acceptReviewerOutput(review, { agentId, json }, await now($))
  if (accepted.kind === 'discard') return
  // The copy a later fetch may reuse: written for an accepted result only.
  const copy = acceptedCopyOf(accepted, json)
  const saved = savedPathsOf(config, review)
  if (copy !== undefined && saved) await $.fs.write(saved.accepted, copy).catch(() => undefined)
  await patch($, mine.key, one =>
    accepted.kind === 'accept' ? accepted.review : fail(one, accepted.reason),
  )
  await finish($, config, mine.key, accepted.kind === 'accept')
}

/**
 * A review's timer: arms itself until the review ends. A reviewer still at
 * work past the timeout is waited on, since nothing here can stop it.
 */
async function onTimeout($: EngineInterface, config: Config, key: string) {
  const review = inbox.reviews.find(one => one.key === key)
  const mine = running.find(one => one.key === key)
  if (!review || !mine || review.agentId !== mine.agentId) return
  const action = timeoutAction(review, await now($), (await aliveAgentIds($)).includes(mine.agentId))
  if (action.kind === 'wait') {
    $.clock.after(action.ms, () => void onTimeout($, config, key))
  } else if (action.kind === 'fail') {
    await patch($, key, one => fail(one, 'タイムアウト'))
    await finish($, config, key)
  }
}

// ---- adopting, editing, and sending a review ----

function slotOf(key: string) {
  const parsed = parseKey(key)

  return parsed ? `${parsed.fullName}/${parsed.number}` : undefined
}

function diffPathOf(config: Config, review: Commit) {
  const slot = slotOf(review.key)

  return slot ? `${config.dataDir}/diffs/${slot}/${review.headSha}.diff` : undefined
}

/** A commit's results: the reviewer's file, the mod's accepted copy, and what was sent. */
function savedPathsOf(config: Config, review: Commit) {
  const slot = slotOf(review.key)
  if (!slot) return undefined
  const base = `${config.dataDir}/results/${slot}/${review.headSha}`

  return { dir: `${config.dataDir}/results/${slot}`, result: `${base}.json`, accepted: `${base}.accepted.json`, posted: `${base}.posted.json` }
}

/** Forgets a commit's results, so the next review of it starts from nothing. */
async function dropSaved($: EngineInterface, config: Config, review: Commit) {
  const saved = savedPathsOf(config, review)
  if (saved) await $.process.run(['rm', '-f', saved.result, saved.accepted, saved.posted])
}

async function refreshWithDiff($: EngineInterface, config: Config) {
  const withDiff: string[] = []
  for (const review of inbox.reviews.filter(one => one.status === 'done')) {
    const path = diffPathOf(config, review)
    if (path && (await $.fs.exists(path))) withDiff.push(review.key)
  }
  await mutate($, state => ({ ...state, withDiff }))
}

const isOpen = (review: Review) => review.status === 'done' && review.postedAt === undefined

export function toggle($: EngineInterface, key: string, id: string) {
  return patch($, key, review => (isOpen(review) && !isSending ? toggleAdopted(review, id) : review))
}

export function adoptAll($: EngineInterface, key: string, isAdopted: boolean) {
  return patch($, key, review => (isOpen(review) && !isSending ? setAllAdopted(review, isAdopted) : review))
}

export async function saveEdit($: EngineInterface, key: string, id: string, text: string) {
  await patch($, key, review => (isOpen(review) && !isSending ? editComment(review, id, text) : review))
  await setMode($, undefined)
}

export async function addComment($: EngineInterface, key: string, body: string) {
  const review = inbox.reviews.find(one => one.key === key)
  const mode = inbox.mode
  if (!review || !isOpen(review) || mode?.kind !== 'add') return
  // A line pressed on the diff is the place; the field of the detail's form is not read then.
  const added = addHumanComment(review, { place: mode.at ?? mode.place, body })
  if ('error' in added) return setMode($, { ...mode, error: added.error })
  await patch($, key, () => added.review)
  await setMode($, undefined)
}

export async function requeue($: EngineInterface, config: Config, key: string) {
  const open = inbox.reviews.find(review => review.key === key && isOpen(review))
  if (open) await dropSaved($, config, open)
  if (open) await removeWorktree($, config, key)
  await patch($, key, review =>
    isOpen(review)
      ? { ...review, status: 'queued', findings: [], followups: undefined, humanReview: [], checked: [], skipped: [] }
      : review,
  )
  await pump($, config)
}

/** Builds the request the confirm screen shows; nothing is sent here. */
export async function openConfirm($: EngineInterface, config: Config, key: string, event: ReviewEvent) {
  const review = inbox.reviews.find(one => one.key === key)
  const path = review && diffPathOf(config, review)
  if (!review || !path || isSending) return
  if (event === 'COMMENT' ? !canComment(review) : !canApprove(review)) return
  const diff = await $.fs.read(path).then(String, () => undefined)
  if (diff === undefined) return refreshWithDiff($, config)
  const diffLines = parseDiffLines(diff)
  const leftLines = parseLeftLines(diff)
  // The same split the payload is built from, so each finding's tag matches what is sent.
  const { inline, inBody } = splitForReview(review, diffLines, leftLines)
  const placement: Placement = Object.fromEntries([
    ...inline.map(finding => [finding.id, 'inline'] as const),
    ...inBody.map(finding => [finding.id, 'body'] as const),
  ])
  const comment = inbox.approveComment ?? DEFAULT_APPROVE_COMMENT
  await setMode($, { kind: 'confirm', payload: buildReviewPayload(review, diffLines, event, comment, leftLines), placement })
}

/** The approval with the comment as typed: the confirm screen shows it before anything goes. */
export async function approveWith($: EngineInterface, config: Config, key: string, comment: string) {
  await setApproveComment($, comment)
  await openConfirm($, config, key, 'APPROVE')
}

// Set and cleared synchronously: two presses of 送信する must not both pass.
let isSending = false

/**
 * Sends the request the confirm screen is showing. Called from that screen's
 * 送信する press and nowhere else: no timer, subagent or prompt reaches it.
 */
export async function send($: EngineInterface, config: Config, key: string) {
  const review = inbox.reviews.find(one => one.key === key)
  const mode = inbox.mode
  const slot = slotOf(key)
  const head = headArgs(key)
  if (!review || !slot || !head || !isOpen(review)) return
  if (mode?.kind !== 'confirm' || inbox.selectedKey !== key || isSending) return
  const { payload, placement } = mode
  if (payload.commit_id !== review.headSha) return
  isSending = true
  let error: string | undefined
  try {
    await mutate($, state => ({ ...state, mode: { kind: 'sending', payload, placement } }))
    const current = await run($, head, config)
    if (current.exitCode !== 0) throw new Error(firstLine(current.stderr) || 'PR の状態を確認できません')
    if (headOf(current.stdout) !== review.headSha) {
      throw new Error('PR が更新されています。もう一度レビューしてから送ってください')
    }
    const dir = `${config.dataDir}/payloads/${slot}`
    const payloadPath = `${dir}/${review.headSha}.json`
    await $.process.run(['mkdir', '-p', dir])
    await $.fs.write(payloadPath, JSON.stringify(payload))
    const post = postArgs(key, payloadPath) as string[]
    const posted = await run($, post, config)
    if (posted.exitCode !== 0) throw new Error(firstLine(posted.stderr) || '送信に失敗しました')
    const sent = {
      postedAt: (await now($)).toISOString(),
      postedUrl: postedUrlOf(posted.stdout),
      postedEvent: payload.event,
    }
    await patch($, key, one => ({ ...one, ...sent }))
    // Kept beside the result: the same commit coming back must not be sent twice.
    const saved = savedPathsOf(config, review)
    if (saved) {
      await $.process.run(['mkdir', '-p', saved.dir]).catch(() => undefined)
      await $.fs.write(saved.posted, JSON.stringify(sent)).catch(() => undefined)
    }
    await removeWorktree($, config, key)
  } catch (failure) {
    error = firstLine(String(failure instanceof Error ? failure.message : failure))
  } finally {
    isSending = false
  }
  // A sent review leaves nothing to do: it leaves the list at once.
  const isDone = error === undefined
  await mutate($, state => ({
    ...state,
    mode: error === undefined ? undefined : { kind: 'confirm', payload, placement, error },
    ...(isDone
      ? {
          selectedKey: undefined,
          diffView: undefined,
          reviews: state.reviews.map(one => (one.key === key ? { ...one, isRead: true } : one)),
        }
      : {}),
  }))
}

// ---- the guard in front of a subagent's tool calls ----

type Args = Readonly<Record<string, unknown>>
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

/**
 * A reviewer's first call may arrive before its spawn has answered. A call from
 * an agent not yet in `running` waits while a review is being set up, until
 * that agent shows up in `running`, nothing is being set up, or 5 seconds pass.
 * The main loop and a reviewer already known never wait.
 */
async function untilKnown($: EngineInterface, agentId: string | undefined) {
  const isSettled = () => preparing.size === 0 || running.some(one => one.agentId === agentId)
  if (agentId === undefined || isSettled()) return
  await new Promise<void>(resolve => {
    let isDone = false
    const end = () => {
      if (isDone) return
      isDone = true
      resolve()
    }
    const check = () => {
      if (isDone) return
      if (isSettled()) end()
      else waiters.push(check)
    }
    waiters.push(check)
    $.clock.after(5000, end)
  })
}

export async function isToolCallAllowed(
  $: EngineInterface,
  config: Config | undefined,
  call: { tool: string; agentId: string; args: Args },
): Promise<boolean> {
  await untilKnown($, call.agentId)
  const guard = guardOf({
    isActive,
    isSpawnedHere: (await knownReviewers($)).includes(call.agentId),
  })
  if (guard === 'pass') return true
  const filePath = str(call.args.file_path)
  const path = str(call.args.path)
  const target = call.tool === 'Read' ? filePath : path
  const mine = running.find(one => one.agentId === call.agentId)
  const isAllowed = guard === 'check' && isAllowedToolCall(
    {
      tool: call.tool,
      agentId: call.agentId,
      filePath,
      path,
      pattern: str(call.args.pattern),
      glob: str(call.args.glob),
      realPath: target === undefined ? undefined : await realPath($, target),
    },
    {
      reviewerAgentIds,
      resultPath: mine?.resultPath,
      allowedRoots: mine?.allowedRoots ?? [],
    },
  )
  if (!isAllowed && config) {
    const entry = `${(await now($)).toISOString()} ${call.tool} ${target ?? filePath ?? ''}\n`
    const log = `${config.dataDir}/denied.log`
    const before = (await $.fs.exists(log)) ? String(await $.fs.read(log)).slice(-200_000) : ''
    await $.fs.write(log, before + entry).catch(() => undefined)
  }

  return isAllowed
}
