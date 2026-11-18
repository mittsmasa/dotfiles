// Pre-reads my own branch with the reviewer of pr-review-inbox, before its
// pull request is opened. The decisions are in self-review-core.ts; this file
// runs git and the checks, and reads and writes the files.
//
//   node self-review.ts gate                 PreToolUse hook: stops a gh pr create with no result
//   node self-review.ts prepare [--base b]   writes the diff, the check output and the reviewer's prompt
//   node self-review.ts report               takes the reviewer's result and prints the list of fixes
//   node self-review.ts skip --reason r      lets this commit through with no pre-read
//
// Needs node 22.18 or later: it runs .ts as is and resolves the mod's imports with registerHooks.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import type { Review } from '../types'

// The mod imports './diff' with no extension, as its engine resolves it; node needs the `.ts`.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context)
      throw error
    }
  },
})

const reviews: typeof import('../hooks/reviews') = await import('../hooks/reviews.ts')
const profile: typeof import('../hooks/profile') = await import('../hooks/profile.ts')
const core: typeof import('./self-review-core') = await import('./self-review-core.ts')

const HOME = homedir()
const INVOKE = `${process.execPath} ${fileURLToPath(import.meta.url)}`
/** Stands in for the agent id the inbox checks a result against: the session spawns the reviewer here. */
const SELF_AGENT = 'self-review'
const MAX_DIFF = 3_000_000
const CHECK_TIMEOUT_MS = 180_000

class Stop extends Error {}
const stop = (message: string): never => {
  throw new Stop(message)
}
const firstLine = (text: string) => text.trim().split('\n')[0]?.slice(0, 160) ?? ''

type Ran = { exitCode: number; stdout: string; stderr: string; error?: string }

/**
 * Runs an argument vector with no shell. `error` is set only when it could not
 * start or timed out; a non-zero exit is an ordinary result.
 */
function run(argv: readonly string[], timeoutMs = 60_000): Promise<Ran> {
  const [file, ...args] = argv

  return new Promise(resolve => {
    // Not inside the checkout: a check reads only the config it is handed.
    execFile(
      file as string,
      args,
      { cwd: tmpdir(), timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code
        if (!error) resolve({ exitCode: 0, stdout, stderr })
        else if (typeof code === 'number' && !error.killed) resolve({ exitCode: code, stdout, stderr })
        else resolve({ exitCode: -1, stdout, stderr, error: error.killed ? 'タイムアウト' : firstLine(error.message) })
      },
    )
  })
}

const git = (root: string, ...args: string[]) => run(['git', '-C', root, ...args], 120_000)

function option(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const one = args[i] as string
    if (one === name) return args[i + 1]
    if (one.startsWith(`${name}=`)) return one.slice(name.length + 1)
  }

  return undefined
}

// ---- the repository and the config ----

type Repo = { root: string; fullName?: string; head?: string }

async function repoAt(cwd: string): Promise<Repo | undefined> {
  const top = await git(cwd, 'rev-parse', '--show-toplevel')
  if (top.exitCode !== 0) return undefined
  const root = await realpath(top.stdout.trim())
  const origin = await git(root, 'remote', 'get-url', 'origin')
  const head = await git(root, 'rev-parse', 'HEAD')
  const fullName = origin.exitCode === 0 ? core.fullNameOf(origin.stdout) : undefined

  return { root, ...(fullName ? { fullName } : {}), ...(head.exitCode === 0 ? { head: head.stdout.trim() } : {}) }
}

async function loadConfig() {
  const text = await readFile(`${HOME}/${reviews.CONFIG_FILE}`, 'utf8').catch(() => undefined)

  return reviews.parseConfig(text, HOME)
}

/** The base branch: the one typed, else the one `origin/HEAD` names; only a valid branch name. */
async function resolveBase(root: string, typed: string | undefined): Promise<string | undefined> {
  const base = typed ?? core.defaultBranchOf((await git(root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD')).stdout)
  if (base === undefined || base.startsWith('-')) return undefined

  return (await run(['git', 'check-ref-format', '--branch', base])).exitCode === 0 ? base : undefined
}

/** Where one commit's pre-read is kept: inside the checkout, under the globally ignored `.workflow`. */
const resultsDir = (root: string) => `${root}/.workflow/self-review`
const commitDir = (root: string, sha: string) => `${resultsDir(root)}/${sha}`

/** The commits that have an accepted result or a skip mark. */
async function markedCommits(root: string): Promise<string[]> {
  const dir = resultsDir(root)
  const names = await readdir(dir).catch(() => [] as string[])

  return names.filter(
    name =>
      /^[0-9a-f]{40,64}$/.test(name) && (existsSync(`${dir}/${name}/accepted.json`) || existsSync(`${dir}/${name}/skipped.json`)),
  )
}

// ---- gate ----

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)

  return Buffer.concat(chunks).toString('utf8')
}

async function gate() {
  const input = JSON.parse(await readStdin()) as { cwd?: unknown; tool_input?: { command?: unknown } }
  const command = input.tool_input?.command
  const pr = typeof command === 'string' ? core.parsePrCreate(command) : undefined
  if (!pr || pr.createsNothing) return
  const repo = await repoAt(typeof input.cwd === 'string' ? input.cwd : process.cwd())
  if (!repo) return
  // `-R` takes OWNER/REPO or HOST/OWNER/REPO: the last two segments name it.
  const fullName = pr.repo !== undefined ? core.fullNameOf(`/${pr.repo}`) : repo.fullName
  const base = await resolveBase(repo.root, pr.base)
  const listed = base === undefined ? undefined : await git(repo.root, 'rev-list', `origin/${base}..HEAD`, '--')
  const decision = core.gateDecision({
    pr,
    fullName,
    sources: (await loadConfig()).sources,
    base,
    commits: listed?.exitCode === 0 ? listed.stdout.split('\n').filter(Boolean) : undefined,
    marked: await markedCommits(repo.root),
    invoke: INVOKE,
  })
  if (decision.kind === 'deny') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason },
      }),
    )
  }
}

// ---- prepare ----

async function requireRepo(): Promise<Required<Repo>> {
  const repo = await repoAt(process.cwd())
  if (!repo?.head) return stop('git リポジトリの中で実行してください')
  if (!repo.fullName) return stop('origin が GitHub のリポジトリではありません')

  return repo as Required<Repo>
}

/** The same steps as the inbox's mechanicalChecks in run.ts, with node in place of the engine. */
async function mechanicalChecks(
  checks: readonly import('../hooks/profile').Check[],
  files: readonly string[],
  root: string,
  scanDir: string,
): Promise<{ skipped: string[]; outputs?: { name: string; files: string[] }[] }> {
  if (checks.length === 0) return { skipped: [] }
  const targets: string[] = []
  const scripts = checks.some(profile.takesFiles) ? files.filter(reviews.isScript).slice(0, 200) : []
  for (const file of scripts) {
    const path = `${root}/${file}`
    const link = await lstat(path).catch(() => undefined)
    const real = await realpath(path).catch(() => undefined)
    // A link may point outside the checkout; only plain files inside it are checked.
    if (link?.isFile() && real?.startsWith(root + '/')) targets.push(real)
  }
  const plan = profile.checksToRun(checks, targets.length)
  if (plan.run.length === 0) return { skipped: plan.skipped }
  const results: import('../hooks/profile').CheckResult[] = []
  for (const check of plan.run) {
    // A second prepare of the same commit must not read what the first one left.
    for (const name of profile.outputsOf(check)) await rm(`${scanDir}/${name}`, { force: true })
    const ran = await run(profile.expandArgv(check.argv, { files: targets, worktree: root, outDir: scanDir }), CHECK_TIMEOUT_MS)
    if (ran.error !== undefined) {
      results.push({ check, failure: ran.error })
      continue
    }
    if (check.stdout) await writeFile(`${scanDir}/${check.stdout}`, ran.stdout.slice(0, MAX_DIFF))
    const missing = check.outputs.filter(name => !existsSync(`${scanDir}/${name}`))
    const failure = profile.failureOf(ran, missing)
    results.push(failure === undefined ? { check } : { check, failure })
  }
  const summary = profile.summarizeChecks(results)

  return { ...summary, skipped: [...plan.skipped, ...summary.skipped] }
}

/** A file the config names, read whole; what could not be read goes to `skipped`. */
async function readNamed(path: string | undefined, label: string, skipped: string[]) {
  if (path === undefined) return undefined
  const text = await readFile(path, 'utf8').catch(() => undefined)
  if (text === undefined || text.trim() === '') skipped.push(`${label}（読めない。既定を使った）`)

  return text?.trim() ? text : undefined
}

const viewpointFs: import('../hooks/profile').ViewpointFs = {
  list: async path =>
    (await readdir(path, { withFileTypes: true })).map(entry => ({
      name: entry.name,
      kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other',
      isLink: entry.isSymbolicLink(),
    })),
  stat: async path => {
    const found = await stat(path)

    return { kind: found.isFile() ? 'file' : found.isDirectory() ? 'dir' : 'other' }
  },
}

async function prepare(args: readonly string[]) {
  const repo = await requireRepo()
  const config = await loadConfig()
  if (!core.isCovered(repo.fullName, config.sources)) {
    stop(`${repo.fullName} は ~/${reviews.CONFIG_FILE} の sources に入っていません`)
  }
  const base = await resolveBase(repo.root, option(args, '--base'))
  if (base === undefined) return stop('base ブランチが決まりません。--base <branch> を付けてください')
  const range = `origin/${base}...HEAD`
  const dir = commitDir(repo.root, repo.head)
  const scanDir = `${dir}/scan`
  const diffPath = `${dir}/changes.diff`
  const resultPath = `${dir}/result.json`
  const promptPath = `${dir}/prompt.md`
  await mkdir(scanDir, { recursive: true })
  for (const name of ['result.json', 'accepted.json']) await rm(`${dir}/${name}`, { force: true })

  const diff = await git(repo.root, 'diff', range, '--')
  if (diff.exitCode !== 0) return stop(`diff を取れません（git fetch origin ${base} が要るかもしれません）: ${firstLine(diff.stderr)}`)
  await writeFile(diffPath, diff.stdout.slice(0, MAX_DIFF))
  const files = (await git(repo.root, 'diff', '--name-only', '-z', range, '--')).stdout.split('\0').filter(Boolean)
  const skipped = diff.stdout.length > MAX_DIFF ? ['diff の一部（大きすぎる）'] : []
  const checked = await mechanicalChecks(config.profile.checks, files, repo.root, scanDir)
  skipped.push(...checked.skipped)

  // The criteria file is read only where it really lies inside the checkout.
  const criteria = reviews.criteriaFor(repo.fullName, files, config.criteria)
  const criteriaReal = criteria ? await realpath(`${repo.root}/${criteria}`).catch(() => undefined) : undefined
  const criteriaPath = criteriaReal ? reviews.criteriaRoot(repo.root, criteriaReal) : undefined
  const picked = await profile.resolveViewpoints(config.profile.viewpoints, viewpointFs)
  const skillFiles: string[] = []
  for (const file of picked.files) {
    const real = await realpath(file).catch(() => undefined)
    if (real) skillFiles.push(real)
  }
  const { guide: guideSource, commentStyle: stylePath } = config.profile
  const guideText = await readNamed(guideSource.kind === 'file' ? guideSource.path : undefined, 'review.guide', skipped)
  const commentStyle = await readNamed(stylePath, 'review.commentStyle', skipped)
  skipped.push('PR の会話と checks（PR 作成前のため無し）')
  const status = await git(repo.root, 'status', '--porcelain', '--', '.', ':!.workflow')
  if (status.stdout.trim() !== '') skipped.push('未コミットの変更（diff に含まれない）')

  const key = core.selfKey(repo.fullName)
  // The inbox registers REVIEWER_SYSTEM as its reviewer's system prompt; a session's subagent gets it at the top.
  const prompt = [
    reviews.REVIEWER_SYSTEM,
    '---',
    reviews.reviewerPrompt({
      key,
      headSha: repo.head,
      worktree: repo.root,
      diffPath,
      ...(checked.outputs ? { scanDir, checkOutputs: checked.outputs } : {}),
      criteriaPath,
      skillFiles,
      guide: guideText !== undefined ? { kind: 'text', text: guideText } : { kind: 'generic' },
      ...(commentStyle === undefined ? {} : { commentStyle }),
      resultPath,
      files,
    }),
  ].join('\n\n')
  await writeFile(promptPath, prompt)
  await writeFile(`${dir}/meta.json`, JSON.stringify({ key, headSha: repo.head, base, skipped, preparedAt: new Date().toISOString() }))

  const warning = profile.warningLine([...config.warnings, ...picked.warnings])
  console.log(
    [
      `依頼文: ${promptPath}`,
      `結果の書き先: ${resultPath}`,
      `対象: ${repo.fullName} ${repo.head.slice(0, 7)}（base ${base}、変更 ${files.length} ファイル）`,
      ...(warning ? [warning] : []),
      '',
      '次の手順:',
      '1. 依頼文ファイルを Read し、その中身をそのまま prompt にして general-purpose の subagent を 1 つ起動する',
      `2. subagent が終わったら ${INVOKE} report を実行する`,
    ].join('\n'),
  )
}

// ---- report ----

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every(one => typeof one === 'string')

async function report() {
  const repo = await requireRepo()
  const dir = commitDir(repo.root, repo.head)
  const meta = JSON.parse(await readFile(`${dir}/meta.json`, 'utf8').catch(() => 'null')) as Record<string, unknown> | null
  if (!meta || typeof meta.key !== 'string' || typeof meta.base !== 'string') {
    return stop(`HEAD（${repo.head.slice(0, 7)}）の prepare がありません。先に ${INVOKE} prepare を実行してください`)
  }
  const resultPath = `${dir}/result.json`
  const json = reviews.parseReviewerJson(await readFile(resultPath, 'utf8').catch(() => undefined), undefined)
  // The inbox's own acceptance: the result must name this branch's key and commit.
  const review: Review = {
    key: meta.key,
    title: '',
    url: '',
    headSha: repo.head,
    baseRefName: meta.base,
    files: [],
    status: 'reviewing',
    agentId: SELF_AGENT,
    findings: [],
    humanReview: [],
    skipped: isStrings(meta.skipped) ? meta.skipped : [],
    isRead: false,
  }
  const accepted = reviews.acceptReviewerOutput(review, { agentId: SELF_AGENT, json }, new Date())
  if (accepted.kind !== 'accept') {
    return stop(
      [
        `結果を受理できない: ${accepted.kind === 'fail' ? accepted.reason : '下読みの対象と合わない'}`,
        `subagent が結果を書けなかったときは、最終メッセージの \`\`\`json ブロックを ${resultPath} に保存してから、もう一度 report を実行してください。`,
        `直らなければ prepare からやり直してください。ユーザーの指示があるときだけ ${INVOKE} skip --reason "<理由>" で飛ばせます。`,
      ].join('\n'),
    )
  }
  await writeFile(`${dir}/accepted.json`, reviews.acceptedCopyOf(accepted, json) as string)
  console.log(core.fixList(accepted.review))
}

// ---- skip ----

async function skip(args: readonly string[]) {
  const reason = option(args, '--reason')?.trim()
  if (!reason) return stop('--reason "<理由>" を付けてください')
  const repo = await requireRepo()
  const dir = commitDir(repo.root, repo.head)
  await mkdir(dir, { recursive: true })
  await writeFile(`${dir}/skipped.json`, JSON.stringify({ reason, at: new Date().toISOString() }))
  console.log(`下読みを飛ばす印を書きました: ${dir}/skipped.json`)
}

// ---- main ----

const [sub, ...args] = process.argv.slice(2)
try {
  if (sub === 'gate') await gate()
  else if (sub === 'prepare') await prepare(args)
  else if (sub === 'report') await report()
  else if (sub === 'skip') await skip(args)
  else stop('使い方: self-review.ts gate | prepare [--base <branch>] | report | skip --reason <理由>')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error instanceof Stop ? message : `self-review: ${message}`)
  // A broken gate lets the pull request through: exit 2 would block it, and 0 never does.
  process.exitCode = sub === 'gate' ? 0 : 1
}
