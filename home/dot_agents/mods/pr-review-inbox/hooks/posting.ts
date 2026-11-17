// Pure logic of sending a review: which findings go, where each lands, and
// what the request holds. The sending itself is in run.ts.
import type { Finding, Review, ReviewEvent, ReviewPayload } from '../types'
import { pathOfRow } from './diff'
import { parseKey, severityTag } from './reviews'

// ---- adopting, editing, adding ----

function mapFinding(review: Review, id: string, change: (finding: Finding) => Finding): Review {
  return {
    ...review,
    findings: review.findings.map(finding => (finding.id === id ? change(finding) : finding)),
  }
}

export function toggleAdopted(review: Review, id: string): Review {
  return mapFinding(review, id, finding => ({ ...finding, isAdopted: !finding.isAdopted }))
}

/** Every finding taken out, or every one put back. */
export function setAllAdopted(review: Review, isAdopted: boolean): Review {
  return { ...review, findings: review.findings.map(finding => ({ ...finding, isAdopted })) }
}

/** An empty text is no edit: a comment with nothing to say is taken out instead. */
export function editComment(review: Review, id: string, comment: string): Review {
  return comment.trim() === '' ? review : mapFinding(review, id, finding => ({ ...finding, comment }))
}

type Place = { file: string; line: number; side?: 'LEFT' }

/** `path:line`, or nothing; `'invalid'` for anything else. */
export function parsePlace(text: string): Place | undefined | 'invalid' {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^(\S+):(\d+)$/.exec(trimmed)
  const line = Number(match?.[2])

  return match && line > 0 ? { file: match[1] as string, line } : 'invalid'
}

export function addHumanComment(
  review: Review,
  // A place picked on the diff comes as it is: a path may hold what `path:line` cannot.
  input: { place: string | Place; body: string },
): { review: Review } | { error: string } {
  const body = input.body.trim()
  if (body === '') return { error: '本文を入力してください' }
  const place = typeof input.place === 'string' ? parsePlace(input.place) : input.place
  if (place === 'invalid') return { error: '場所は path:line の形で入力してください' }
  const count = review.findings.filter(finding => finding.source === 'human').length
  const added: Finding = {
    id: `h${count + 1}`,
    severity: 'suggestion',
    isUnsure: false,
    ...place,
    reason: body.split('\n')[0] ?? body,
    comment: body,
    source: 'human',
    isAdopted: true,
  }

  return { review: { ...review, findings: [...review.findings, added] } }
}

// ---- where a comment can land ----

/** The right-side line numbers a diff shows, per file: added and context lines. */
export function parseDiffLines(diff: string): Record<string, number[]> {
  const lines: Record<string, number[]> = {}
  let file: string | undefined
  let next = 0
  let isInHunk = false
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      file = undefined
      isInHunk = false
    } else if (!isInHunk && row.startsWith('+++ ')) {
      // The same reading as the diff screen's, so a place picked there is a key here.
      file = pathOfRow(row, '+++ b/')
    } else if (row.startsWith('@@ ')) {
      const start = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row)?.[1]
      next = Number(start)
      isInHunk = start !== undefined
    } else if (isInHunk && file !== undefined) {
      if (row.startsWith('+') || row.startsWith(' ')) {
        ;(lines[file] ??= []).push(next)
        next += 1
      }
    }
  }

  return lines
}

/**
 * The left-side line numbers a diff shows, per file: removed and context lines,
 * counted in the file before the change. A deleted file goes by its old path.
 */
export function parseLeftLines(diff: string): Record<string, number[]> {
  const lines: Record<string, number[]> = {}
  let file: string | undefined
  let old: string | undefined
  let next = 0
  let isInHunk = false
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      file = undefined
      old = undefined
      isInHunk = false
    } else if (!isInHunk && row.startsWith('--- ')) {
      old = pathOfRow(row, '--- a/')
    } else if (!isInHunk && row.startsWith('+++ ')) {
      file = pathOfRow(row, '+++ b/') ?? old
    } else if (row.startsWith('@@ ')) {
      const start = /^@@ -(\d+)/.exec(row)?.[1]
      next = Number(start)
      isInHunk = start !== undefined
    } else if (isInHunk && file !== undefined) {
      if (row.startsWith('-') || row.startsWith(' ')) {
        ;(lines[file] ??= []).push(next)
        next += 1
      }
    }
  }

  return lines
}

type Lines = Readonly<Record<string, readonly number[]>>

/**
 * Adopted findings, split by whether GitHub can hang them on a line of the
 * diff. A finding on the left side is looked up among `leftLines`.
 */
export function splitForReview(
  review: Review,
  diffLines: Lines,
  leftLines: Lines = {},
): { inline: Finding[]; inBody: Finding[] } {
  const adopted = review.findings.filter(finding => finding.isAdopted)
  const isInline = (finding: Finding) => {
    const lines = finding.side === 'LEFT' ? leftLines : diffLines

    return (
      finding.file !== undefined &&
      finding.line !== undefined &&
      Object.hasOwn(lines, finding.file) &&
      (lines[finding.file] as readonly number[]).includes(finding.line)
    )
  }

  return { inline: adopted.filter(isInline), inBody: adopted.filter(finding => !isInline(finding)) }
}

/**
 * A finding's comment as sent, led by its severity. A person's own comment
 * goes as written: its severity is a default nobody chose.
 */
export function taggedComment(finding: Finding): string {
  return finding.source === 'human' ? finding.comment : `${severityTag(finding.severity)} ${finding.comment}`
}

/** How a finding reads in the review body: the severity, then its place, when it has one. */
export function bodyLine(finding: Finding): string {
  if (finding.file === undefined) return taggedComment(finding)
  const line = finding.line === undefined ? '' : `:${finding.line}${finding.side === 'LEFT' ? '（削除行）' : ''}`
  const place = `${finding.file}${line}`
  const tag = finding.source === 'human' ? '' : `${severityTag(finding.severity)} `

  return `${tag}${place} ${finding.comment}`
}

const INLINE_ONLY_BODY = 'インラインコメントを参照してください。'

/** What an approval says when nothing else was typed. */
export const DEFAULT_APPROVE_COMMENT = 'LGTM!'

export function buildReviewPayload(
  review: Review,
  diffLines: Readonly<Record<string, readonly number[]>>,
  event: ReviewEvent,
  /** The person's own words on an approval, ahead of the findings; a comment review takes none. */
  comment?: string,
  /** The left-side lines of the diff; left out, a finding on a removed line goes into the body. */
  leftLines: Lines = {},
): ReviewPayload {
  const { inline, inBody } = splitForReview(review, diffLines, leftLines)
  const lead = event === 'APPROVE' ? (comment ?? '').trim() : ''
  const text = [...(lead === '' ? [] : [lead]), ...inBody.map(bodyLine)].join('\n\n')
  // The API wants a body with COMMENT; an approval may go without one.
  const body = text !== '' ? text : event === 'COMMENT' ? INLINE_ONLY_BODY : undefined

  return {
    commit_id: review.headSha,
    event,
    ...(body === undefined ? {} : { body }),
    comments: inline.map(finding => ({
      path: finding.file as string,
      line: finding.line as number,
      side: finding.side ?? 'RIGHT',
      body: taggedComment(finding),
    })),
  }
}

// ---- what a person may do with a review ----

const isSendable = (review: Review) => review.status === 'done' && review.postedAt === undefined

/** Nothing adopted means nothing to say: no comment review to send. */
export function canComment(review: Review): boolean {
  return isSendable(review) && review.findings.some(finding => finding.isAdopted)
}

/** Never while a blocker is still adopted: take it out first, deliberately. */
export function canApprove(review: Review): boolean {
  return (
    isSendable(review) &&
    !review.findings.some(finding => finding.isAdopted && finding.severity === 'blocker')
  )
}

export type Action = 'comment' | 'approve' | 'rereview' | 'posted' | 'approved'

/** The send controls a review's detail shows, in order. */
export function actionsOf(review: Review, hasDiff: boolean): Action[] {
  if (review.postedAt !== undefined) return [review.postedEvent === 'APPROVE' ? 'approved' : 'posted']
  if (review.status !== 'done') return []
  // Without the saved diff no finding can be placed on a line.
  if (!hasDiff) return ['rereview']

  return [...(canComment(review) ? ['comment' as const] : []), ...(canApprove(review) ? ['approve' as const] : [])]
}

// ---- the request ----

export function postArgs(key: string, payloadPath: string): string[] | undefined {
  const parsed = parseKey(key)
  if (!parsed) return undefined

  return [
    'gh', 'api', '--method', 'POST',
    `repos/${parsed.fullName}/pulls/${parsed.number}/reviews`,
    '--input', payloadPath,
  ]
}

export function headArgs(key: string): string[] | undefined {
  const parsed = parseKey(key)
  if (!parsed) return undefined

  return ['gh', 'pr', 'view', String(parsed.number), '-R', parsed.fullName, '--json', 'headRefOid']
}

function field(stdout: string, name: string): string | undefined {
  try {
    const value = (JSON.parse(stdout) as Record<string, unknown>)[name]

    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export const headOf = (stdout: string) => field(stdout, 'headRefOid')
export const postedUrlOf = (stdout: string) => field(stdout, 'html_url')
