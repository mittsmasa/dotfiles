// Pure logic of sending a review: which findings go, where each lands, and
// what the request holds. The sending itself is in run.ts.
import type { Finding, Review, ReviewEvent, ReviewPayload } from '../types'
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

/** An empty text is no edit: a comment with nothing to say is taken out instead. */
export function editComment(review: Review, id: string, comment: string): Review {
  return comment.trim() === '' ? review : mapFinding(review, id, finding => ({ ...finding, comment }))
}

type Place = { file: string; line: number }

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
  input: { place: string; body: string },
): { review: Review } | { error: string } {
  const body = input.body.trim()
  if (body === '') return { error: '本文を入力してください' }
  const place = parsePlace(input.place)
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
      file = row.startsWith('+++ b/') ? row.slice(6) : undefined
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

/** Adopted findings, split by whether GitHub can hang them on a line of the diff. */
export function splitForReview(
  review: Review,
  diffLines: Readonly<Record<string, readonly number[]>>,
): { inline: Finding[]; inBody: Finding[] } {
  const adopted = review.findings.filter(finding => finding.isAdopted)
  const isInline = (finding: Finding) =>
    finding.file !== undefined &&
    finding.line !== undefined &&
    Object.hasOwn(diffLines, finding.file) &&
    (diffLines[finding.file] as readonly number[]).includes(finding.line)

  return { inline: adopted.filter(isInline), inBody: adopted.filter(finding => !isInline(finding)) }
}

/** How a finding reads in the review body: its place first, when it has one. */
export function bodyLine(finding: Finding): string {
  if (finding.file === undefined) return finding.comment
  const place = finding.line === undefined ? finding.file : `${finding.file}:${finding.line}`

  return `${place} ${finding.comment}`
}

const INLINE_ONLY_BODY = 'インラインコメントを参照してください。'

export function buildReviewPayload(
  review: Review,
  diffLines: Readonly<Record<string, readonly number[]>>,
  event: ReviewEvent,
): ReviewPayload {
  const { inline, inBody } = splitForReview(review, diffLines)
  const text = inBody.map(bodyLine).join('\n\n')
  // The API wants a body with COMMENT; an approval may go without one.
  const body = text !== '' ? text : event === 'COMMENT' ? INLINE_ONLY_BODY : undefined

  return {
    commit_id: review.headSha,
    event,
    ...(body === undefined ? {} : { body }),
    comments: inline.map(finding => ({
      path: finding.file as string,
      line: finding.line as number,
      side: 'RIGHT',
      body: finding.comment,
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

/** The one control drawn as the main button: commenting before approving. */
export function primaryOf(actions: readonly Action[]): 'comment' | 'approve' | undefined {
  if (actions.includes('comment')) return 'comment'

  return actions.includes('approve') ? 'approve' : undefined
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
