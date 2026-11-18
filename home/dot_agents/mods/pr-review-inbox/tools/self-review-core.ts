// The decisions of the self-review: which `gh pr create` to stop, which
// repository is covered, whether a result already stands for the branch, and
// how the result reads as a list of fixes. Pure: self-review.ts runs git and
// reads the files.
import type { Finding, Review, Severity } from '../types'

/** What a `gh pr create` asks for, as far as the gate cares. */
export type PrCreate = {
  /** `--base` / `-B`, as typed. */
  base?: string
  /** `--repo` / `-R`, as typed. */
  repo?: string
  /** `--dry-run`, `--help`: nothing is created. */
  createsNothing: boolean
}

/**
 * The words of one shell command, with quotes and backslashes undone. Undefined
 * when the command chains, pipes, redirects or opens a subshell outside quotes:
 * the gate reads only a lone call.
 */
export function shellWords(command: string): string[] | undefined {
  const words: string[] = []
  let word = ''
  let hasWord = false
  let quote: "'" | '"' | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i] as string
    if (quote === "'") {
      if (char === "'") quote = undefined
      else word += char
    } else if (quote === '"') {
      if (char === '"') quote = undefined
      else if (char === '\\' && i + 1 < command.length && '"\\$`'.includes(command[i + 1] as string)) word += command[++i]
      else word += char
    } else if (char === "'" || char === '"') {
      quote = char
      hasWord = true
    } else if (char === '\\') {
      if (i + 1 < command.length) word += command[++i]
      hasWord = true
    } else if (char === ' ' || char === '\t') {
      if (hasWord) words.push(word)
      word = ''
      hasWord = false
    } else if (';&|<>()`\n'.includes(char)) {
      // `(` also stops `$(...)` outside quotes.
      return undefined
    } else {
      word += char
      hasWord = true
    }
  }
  if (quote !== undefined) return undefined
  if (hasWord) words.push(word)

  return words
}

/** The value of a flag that takes one: `--long v`, `--long=v`, `-s v`, `-sv`. */
function flagValue(words: readonly string[], long: string, short: string): string | undefined {
  for (let i = 0; i < words.length; i++) {
    const one = words[i] as string
    if (one === '--') return undefined
    if (one === long || one === short) return words[i + 1]
    if (one.startsWith(`${long}=`)) return one.slice(long.length + 1)
    if (one.startsWith(short) && !one.startsWith('--') && one.length > short.length) {
      return one.slice(one[short.length] === '=' ? short.length + 1 : short.length)
    }
  }

  return undefined
}

/** A lone `gh pr create`, read; undefined for any other command. */
export function parsePrCreate(command: string): PrCreate | undefined {
  const words = shellWords(command.trim())
  if (!words) return undefined
  // `GH_TOKEN=x gh pr create` still runs gh.
  const start = words.findIndex(one => !/^[A-Za-z_]\w*=/.test(one))
  const [gh, pr, create, ...rest] = start < 0 ? [] : words.slice(start)
  if (gh !== 'gh' || pr !== 'pr' || create !== 'create') return undefined
  const base = flagValue(rest, '--base', '-B')
  const repo = flagValue(rest, '--repo', '-R')

  return {
    ...(base ? { base } : {}),
    ...(repo ? { repo } : {}),
    createsNothing: rest.some(one => one === '--dry-run' || one === '--help' || one === '-h'),
  }
}

/** `owner/repo` of a GitHub remote URL (ssh, scp-like or https). */
export function fullNameOf(remote: string): string | undefined {
  const match = /[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim())
  if (!match) return undefined
  const [, owner, repo] = match as unknown as [string, string, string]

  return [owner, repo].every(one => one !== '.' && one !== '..') ? `${owner}/${repo}` : undefined
}

/** Whether the config's `sources` (owners or `owner/repo`) take in this repository. */
export function isCovered(fullName: string, sources: readonly string[]): boolean {
  const owner = fullName.split('/')[0]

  return sources.some(one => one === fullName || one === owner)
}

/** The branch name `refs/remotes/origin/HEAD` points at, from `git symbolic-ref --short`. */
export function defaultBranchOf(symbolicRef: string): string | undefined {
  const name = symbolicRef.trim()

  return name.startsWith('origin/') && name.length > 'origin/'.length ? name.slice('origin/'.length) : undefined
}

/** The key the reviewer is told and its result must carry: no pull request number exists yet. */
export const selfKey = (fullName: string) => `${fullName}#self`

export type GateFacts = {
  pr: PrCreate | undefined
  fullName: string | undefined
  sources: readonly string[]
  /** The base branch, from the command or `origin/HEAD`; undefined when neither says. */
  base: string | undefined
  /** `git rev-list origin/<base>..HEAD`; undefined when that cannot be listed. */
  commits: readonly string[] | undefined
  /** The commits with an accepted result or a skip mark. */
  marked: readonly string[]
  /** How the session runs the script: `<node> <script>`. */
  invoke: string
}

export type GateDecision = { kind: 'pass' } | { kind: 'deny'; reason: string }

/**
 * Lets the pull request be opened when a commit of this branch, not yet in its
 * base, has an accepted result or a skip mark. A commit after it passes too:
 * fixing the findings moves HEAD, and asking again for each fix never ends.
 */
export function gateDecision(facts: GateFacts): GateDecision {
  const { pr, fullName, base, commits } = facts
  if (!pr || pr.createsNothing) return { kind: 'pass' }
  // Another owner's repository, or one with no GitHub origin: not this gate's.
  if (!fullName || !isCovered(fullName, facts.sources)) return { kind: 'pass' }
  if (base === undefined) {
    return deny(`base ブランチが決まりません（gh pr create に --base が無く、origin/HEAD もありません）。base を指定して下読みしてください。\n${steps(facts.invoke, '<base>')}`)
  }
  if (commits === undefined) {
    return deny(`origin/${base} が手元にありません。git fetch origin ${base} のあと、下読みしてください。\n${steps(facts.invoke, base)}`)
  }
  // Nothing to review: gh says so itself.
  if (commits.length === 0) return { kind: 'pass' }
  if (commits.some(sha => facts.marked.includes(sha))) return { kind: 'pass' }

  return deny(`このブランチ（${fullName}、base ${base}）には、まだ下読みの結果がありません。PR を作る前に下読みしてください。\n${steps(facts.invoke, base)}`)
}

const deny = (body: string): GateDecision => ({ kind: 'deny', reason: `pr-review-inbox のセルフレビュー: ${body}` })

function steps(invoke: string, base: string): string {
  return [
    '手順:',
    `1. このリポジトリで ${invoke} prepare --base ${base} を実行する`,
    '2. 出力された依頼文ファイルを Read し、その中身をそのまま prompt にして general-purpose の subagent を 1 つ起動する。subagent が結果を書き終えるまで待つ',
    `3. ${invoke} report を実行し、出力された修正リストをユーザーに見せる`,
    '4. blocker を直す。recommended を直さないなら、その理由を PR 本文に書く',
    '5. もう一度 gh pr create を実行する',
    `下読みを飛ばすのは、ユーザーがそう指示したときだけにしてください: ${invoke} skip --reason "<理由>"`,
    '/review-inbox を打った受付セッションでは subagent が動きません。別のセッションで下読みするか、skip するかをユーザーに聞いてください。',
  ].join('\n')
}

// ---- the list of fixes ----

const ORDER: readonly Severity[] = ['blocker', 'recommended', 'suggestion']

const placeOf = (finding: Pick<Finding, 'file' | 'line'>) =>
  finding.file === undefined ? '（場所なし）' : finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`

/** The count line: every severity, in order, zero included. */
export function countLine(findings: readonly Pick<Finding, 'severity'>[]): string {
  return ORDER.map(severity => `${severity} ${findings.filter(one => one.severity === severity).length}`).join(' / ')
}

/** An accepted result as the session shows it: the counts, then the findings by severity. */
export function fixList(review: Pick<Review, 'key' | 'headSha' | 'findings' | 'humanReview' | 'checked' | 'skipped'>): string {
  const sorted = ORDER.flatMap(severity => review.findings.filter(one => one.severity === severity))
  const section = (title: string, items: readonly string[] | undefined) =>
    items && items.length > 0 ? [`## ${title}`, ...items.map(one => `- ${one}`), ''] : []

  return [
    `# セルフレビュー: ${review.key} @ ${review.headSha.slice(0, 7)}`,
    '',
    countLine(review.findings),
    '',
    ...(sorted.length > 0
      ? [
          '## 指摘',
          ...sorted.flatMap(one => [
            `- [${one.severity}] ${placeOf(one)}${one.isUnsure ? '（要確認）' : ''}`,
            `  - 理由: ${one.reason}`,
            ...(one.comment !== one.reason ? [`  - 直し方: ${one.comment}`] : []),
          ]),
          '',
        ]
      : ['指摘はありません。', '']),
    ...section('人が見るべき点', review.humanReview),
    ...section('確かめたこと', review.checked),
    ...section('省いたもの', review.skipped),
  ]
    .join('\n')
    .trimEnd()
}
