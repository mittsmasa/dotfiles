export type Severity = 'blocker' | 'recommended' | 'suggestion'

export type Finding = {
  id: string
  severity: Severity
  /** 要確認: the reviewer could not settle it from the code alone. */
  isUnsure: boolean
  file?: string
  line?: number
  /** Why it is a problem, shown in the list. */
  reason: string
  /** The text to post on the pull request; a person may edit it. */
  comment: string
  source: 'criteria' | 'testable-design' | 'human'
  criteriaId?: string
  isAdopted: boolean
}

export type Verdict = 'needs-fix' | 'comments' | 'clean'

export type Review = {
  /** `owner/repo#123` */
  key: string
  title: string
  url: string
  /** The pull request's description, made safe to draw as markdown; absent until fetched. */
  body?: string
  headSha: string
  baseRefName: string
  files: string[]
  status: 'queued' | 'reviewing' | 'done' | 'failed'
  failReason?: string
  agentId?: string
  reviewStartedAt?: string
  verdict?: Verdict
  findings: Finding[]
  humanReview: string[]
  skipped: string[]
  isRead: boolean
  reviewedAt?: string
  postedAt?: string
  postedUrl?: string
  postedEvent?: ReviewEvent
}

/** The two reviews this mod can send; it has no way to request changes. */
export type ReviewEvent = 'COMMENT' | 'APPROVE'

/** What the selected review's detail is doing besides listing findings. */
export type Mode =
  | { kind: 'edit'; id: string }
  | { kind: 'add'; place: string; error?: string }
  | { kind: 'confirm'; payload: ReviewPayload; placement: Placement; error?: string }
  | { kind: 'sending'; payload: ReviewPayload; placement: Placement }

/**
 * Where each adopted finding of a request goes, by finding id: on a line of
 * the diff, or into the review body. A finding not named here is not sent.
 * Made from the same split as the payload, so the two cannot disagree.
 */
export type Placement = Record<string, 'inline' | 'body'>

/** The request body of one review: what the confirm screen shows is what is sent. */
export type ReviewPayload = {
  commit_id: string
  event: ReviewEvent
  body?: string
  comments: { path: string; line: number; side: 'RIGHT'; body: string }[]
}

export type Inbox = {
  reviews: Review[]
  lastFetchedAt?: string
  fetchError?: string
  isFetching: boolean
  selectedKey?: string
  mode?: Mode
  /** The one finding of the selected review drawn open. */
  openFindingId?: string
  /** The diff hunk the open finding sits in; drawn only while `id` is the open finding. */
  openDiff?: { id: string; source: string }
  isHumanReviewOpen?: boolean
  /** Whether the selected review's description is drawn in full. */
  isBodyOpen?: boolean
  /** Keys of the reviews whose diff is saved, so their findings can be placed. */
  withDiff: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'pr-review-inbox': {
      inbox: Shaped<Inbox>
      /** Whether this session is the one running the inbox. */
      isActive: boolean
    }
  }
}
