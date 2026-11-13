// Everything that reaches outside the module: gh, git, the mechanical checks,
// the reviewer subagent, the store. The decisions are in reviews.ts.
import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Inbox, Mode, Placement, Review, ReviewEvent } from '../types'
import { hunkAt } from './diff'
import type { RepoConfig } from './reviews'
import { defaultChecks, expandArgv, failureOf, outputsOf, pickViewpointFiles, skillDirOf, summarizeChecks, warningLine } from './profile'
import type { Check, CheckResult, ViewpointStat } from './profile'
import {
  addHumanComment,
  buildReviewPayload,
  canApprove,
  canComment,
  editComment,
  headArgs,
  headOf,
  parseDiffLines,
  setAllAdopted,
  postArgs,
  postedUrlOf,
  splitForReview,
  toggleAdopted,
} from './posting'
import {
  REVIEWER_SYSTEM,
  guardOf,
  acceptReviewerOutput,
  acceptedCopyOf,
  applyFetchResult,
  CONFIG_FILE,
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

// The module's own copy of what the store holds; rebuilt by `init` on a reload.
let inbox: Inbox = EMPTY
let reviewerAgentIds: string[] = []
let running: Running | undefined
let spawning: Promise<void> | undefined
let tools: { oxlint: string; node: string } | undefined
// Store writes go through one line: two hooks merging at once lose a write.
let line: Promise<unknown> = Promise.resolve()

// ---- which session runs the inbox ----

const HOUR_MS = 60 * 60 * 1000

// Kept in the session's state so a reload finds it; register.tsx declares the
// same atom for its reads.
const activeAtom = atom({ plugin: 'pr-review-inbox', key: 'isActive' } as const, false)

// This module's copy of the atom, for the paths that cannot await a read.
let isActive = false
let sessionId: string | undefined
let hourly: { cancel: () => void } | undefined
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
  hourly?.cancel()
  hourly = $.clock.every(HOUR_MS, () => void tick($, config))
  if (!wasActive) $.clock.after(500, () => void tick($, config))
}

/** Stops this session's inbox: its timer, its pane, and the review it had running. */
async function stop($: EngineInterface, config: Config) {
  hourly?.cancel()
  hourly = undefined
  isActive = false
  await update($, activeAtom, () => false)
  const mine = running
  // The store's `running` is the new owner's now: only this copy is dropped.
  running = undefined
  if (mine) await removeWorktree($, config, mine.key)
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
          isHumanReviewOpen: false,
          isBodyOpen: false,
        },
  )
}

export function showBody($: EngineInterface) {
  return mutate($, state => ({ ...state, isBodyOpen: true }))
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
  const source = diff === undefined ? undefined : hunkAt(diff, file, line)
  if (source === undefined || source.length > HUNK_MAX_CHARS) return
  // The read took a while: only the finding still open, of the review still selected, gets it.
  await mutate($, state =>
    state.selectedKey === key && state.openFindingId === id ? { ...state, openDiff: { id, source } } : state,
  )
}

export function showHumanReview($: EngineInterface) {
  return mutate($, state => ({ ...state, isHumanReviewOpen: true }))
}

export function setMode($: EngineInterface, mode: Mode | undefined) {
  return mutate($, state => (isSending ? state : { ...state, mode }))
}

export function markRead($: EngineInterface, key: string) {
  return mutate($, state => ({
    ...state,
    selectedKey: undefined,
    openDiff: undefined,
    reviews: state.reviews.map(review => (review.key === key ? { ...review, isRead: true } : review)),
  }))
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
  const { repos, criteria, sources, clonePath, profile, warnings } = parseConfig(text, home)
  const stats: ViewpointStat[] = []
  for (const path of profile.viewpoints) {
    const stat = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
    const kind = stat?.kind
    stats.push(kind === undefined ? { path } : { path, kind })
  }
  const picked = pickViewpointFiles(stats)

  return {
    home,
    repos,
    criteria,
    sources,
    ...(clonePath ? { clonePath } : {}),
    profile,
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
  // A reload leaves the reviewer it had running at work: the mod cannot stop
  // it, so it is taken up again rather than cut off under its feet.
  const left = ((await $.store.get('running')) as Running | null | undefined) ?? undefined
  const alive = await aliveAgentIds($)
  const kept =
    left &&
    alive.includes(left.agentId) &&
    before.some(one => one.key === left.key && one.status === 'reviewing' && one.agentId === left.agentId)
      ? left
      : undefined
  await setRunning($, kept)
  isSending = false
  inbox = EMPTY
  await mutate($, () => ({
    ...EMPTY,
    reviews: recoverOnStart(before, kept ? [kept.agentId] : []),
    lastFetchedAt: stored?.lastFetchedAt,
  }))
  await refreshWithDiff($, config)
  // A review cut off by a restart leaves its worktree behind.
  for (const review of before.filter(one => one.status === 'reviewing' && one.key !== kept?.key)) {
    await removeWorktree($, config, review.key)
  }
  if (kept) await onTimeout($, config, kept.key)
}

/** Keeps `running` in the store too, so a reload can take its reviewer up again. */
async function setRunning($: EngineInterface, value: Running | undefined) {
  running = value
  // The store takes JSON data only: null, not undefined, says there is none.
  await $.store.set('running', value ?? null)
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
    const next = applyFetchResult({ search, views }, stored, new Set(reRequested.keys()))
    if (next === stored) throw new Error(firstLine(search.stderr) || '取得結果を読めませんでした')
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
  if (isActive && isDue(await now($), config.utcOffsetMinutes)) await fetchNow($, config)
}

// ---- reviewing, one at a time ----

export async function pump($: EngineInterface, config: Config) {
  if (running || spawning || !(await ensureOwner($, config))) return
  const next = inbox.reviews.find(review => review.status === 'queued')
  if (next) await startReview($, config, next)
}

export async function retry($: EngineInterface, config: Config, key: string) {
  const failed = inbox.reviews.find(review => review.key === key && review.status === 'failed')
  if (failed) await dropSaved($, config, failed)
  await patch($, key, review =>
    review.status === 'failed' ? { ...review, status: 'queued', failReason: undefined } : review,
  )
  await pump($, config)
}

async function resolveTools($: EngineInterface, config: Config) {
  if (tools) return tools
  // The real binaries, not shims that would read a checkout's tool versions.
  const oxlint = await must($, ['mise', 'which', 'oxlint'], config, 'oxlint が見つからない')
  const node = await must($, ['mise', 'which', 'node'], config, 'node が見つからない')
  tools = { oxlint: oxlint.stdout.trim(), node: node.stdout.trim() }

  return tools
}

/** The checks the config sets, or the default ones with their binaries found. */
async function checksOf($: EngineInterface, config: Config): Promise<Check[]> {
  if (config.profile.checks) return config.profile.checks
  const skillDir = skillDirOf(config.home)
  if (!(await $.fs.exists(`${skillDir}/tools`))) throw new Error('testable-design の tools が無い')

  return defaultChecks(await resolveTools($, config), skillDir)
}

/**
 * Runs the checks over the changed scripts. A check fails only when it cannot
 * start, times out, or leaves an output it names missing: a lint that finds
 * something exits non-zero and its output is the point. `outputs` is absent
 * when nothing could run at all; the reviewer then gets no output directory.
 */
async function mechanicalChecks(
  $: EngineInterface,
  config: Config,
  review: Review,
  worktreeReal: string,
  scanDir: string,
): Promise<{ skipped: string[]; outputs?: { name: string; files: string[] }[] }> {
  const targets: string[] = []
  for (const file of review.files.filter(isScript).slice(0, 200)) {
    const stat = await $.fs.stat(`${worktreeReal}/${file}`, { resolve: true }).catch(() => undefined)
    // A link may point outside the checkout; only plain files inside it are scanned.
    const isInside = stat?.realPath?.startsWith(worktreeReal + '/') === true
    if (stat && stat.kind === 'file' && !stat.isLink && isInside) targets.push(stat.realPath as string)
  }
  if (targets.length === 0) return { skipped: ['機械チェック（対象の JS / TS ファイルなし）'] }
  let checks: Check[]
  try {
    checks = await checksOf($, config)
  } catch (error) {
    return { skipped: [`機械チェック（${firstLine(String(error instanceof Error ? error.message : error))}）`] }
  }
  if (checks.length === 0) return { skipped: [] }
  const results: CheckResult[] = []
  for (const check of checks) {
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

  return summarizeChecks(results)
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

async function startReview($: EngineInterface, config: Config, review: Review) {
  if (await reuseSaved($, config, review)) return pump($, config)
  const parsed = parseKey(review.key)
  const place = worktreeOf(config, review.key)
  let release = () => {}
  spawning = new Promise<void>(resolve => (release = resolve))
  let hasWorktree = false
  try {
    if (!parsed || !place || !(await $.fs.exists(place.repo))) throw new Error('clone なし')
    const { repo, worktree } = place
    const origin = await must($, git(['-C', repo, 'remote', 'get-url', 'origin']), config, 'origin を読めない')
    if (!originMatches(origin.stdout, parsed.fullName)) throw new Error('origin 不一致')

    await removeWorktree($, config, review.key)
    await must(
      $,
      git(['-C', repo, 'fetch', 'origin', `pull/${parsed.number}/head`, review.baseRefName]),
      config,
      'fetch 失敗',
      180_000,
    )
    await must($, git(['-C', repo, 'worktree', 'add', '--detach', worktree, review.headSha]), config, 'worktree 作成失敗', 180_000)
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
    const guide =
      guideText !== undefined
        ? { kind: 'text' as const, text: guideText }
        : guideSource.kind === 'testable-design'
          ? { kind: 'testable-design' as const }
          : { kind: 'generic' as const }
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
      }),
    })
    if (started.agentId === undefined) throw new Error('reviewer を起動できない')
    const agentId = started.agentId
    reviewerAgentIds = [...reviewerAgentIds, agentId].slice(-100)
    await $.store.set('reviewerAgentIds', reviewerAgentIds)
    await setRunning($, { key: review.key, agentId, repo, worktree, resultPath, allowedRoots })
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
  } finally {
    release()
    spawning = undefined
  }
  if (!running) await pump($, config)
}

async function finish($: EngineInterface, config: Config, key: string) {
  await removeWorktree($, config, key)
  await setRunning($, undefined)
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
  const mine = running
  if (!mine || mine.agentId !== agentId) return
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
  await finish($, config, mine.key)
}

/**
 * A review's timer: arms itself until the review ends. A reviewer still at
 * work past the timeout is waited on, since nothing here can stop it.
 */
async function onTimeout($: EngineInterface, config: Config, key: string) {
  const review = inbox.reviews.find(one => one.key === key)
  const mine = running
  if (!review || mine?.key !== key || review.agentId !== mine.agentId) return
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
  const added = addHumanComment(review, { place: mode.place, body })
  if ('error' in added) return setMode($, { ...mode, error: added.error })
  await patch($, key, () => added.review)
  await setMode($, undefined)
}

export async function requeue($: EngineInterface, config: Config, key: string) {
  const open = inbox.reviews.find(review => review.key === key && isOpen(review))
  if (open) await dropSaved($, config, open)
  await patch($, key, review =>
    isOpen(review) ? { ...review, status: 'queued', findings: [], humanReview: [], skipped: [] } : review,
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
  // The same split the payload is built from, so each finding's tag matches what is sent.
  const { inline, inBody } = splitForReview(review, diffLines)
  const placement: Placement = Object.fromEntries([
    ...inline.map(finding => [finding.id, 'inline'] as const),
    ...inBody.map(finding => [finding.id, 'body'] as const),
  ])
  await setMode($, { kind: 'confirm', payload: buildReviewPayload(review, diffLines, event), placement })
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
      throw new Error('PR が更新されています。再レビューしてから送ってください')
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
          reviews: state.reviews.map(one => (one.key === key ? { ...one, isRead: true } : one)),
        }
      : {}),
  }))
}

// ---- the guard in front of a subagent's tool calls ----

type Args = Readonly<Record<string, unknown>>
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)

export async function isToolCallAllowed(
  $: EngineInterface,
  config: Config | undefined,
  call: { tool: string; agentId: string; args: Args },
): Promise<boolean> {
  // A reviewer's first call may arrive before its spawn has answered.
  if (spawning) {
    await Promise.race([spawning, new Promise<void>(resolve => $.clock.after(5000, resolve))])
  }
  const guard = guardOf({
    isActive,
    isSpawnedHere: (await knownReviewers($)).includes(call.agentId),
  })
  if (guard === 'pass') return true
  const filePath = str(call.args.file_path)
  const path = str(call.args.path)
  const target = call.tool === 'Read' ? filePath : path
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
      resultPath: running?.agentId === call.agentId ? running.resultPath : undefined,
      allowedRoots: running?.agentId === call.agentId ? running.allowedRoots : [],
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
