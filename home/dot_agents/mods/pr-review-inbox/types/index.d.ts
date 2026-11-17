export type Severity = 'blocker' | 'recommended' | 'suggestion'

export type Finding = {
  id: string
  severity: Severity
  /** 要確認: the reviewer could not settle it from the code alone. */
  isUnsure: boolean
  file?: string
  line?: number
  /** `LEFT`: `line` counts in the file before the change, a removed line. Absent: after it. */
  side?: 'LEFT'
  /** Why it is a problem, shown in the list. */
  reason: string
  /** The text to post on the pull request; a person may edit it. */
  comment: string
  /** `behavior`: a defect the change introduces, traced in the code. */
  /** `viewpoint`: one the configured viewpoint files support. */
  source: 'criteria' | 'behavior' | 'viewpoint' | 'human'
  criteriaId?: string
  isAdopted: boolean
}

export type Verdict = 'needs-fix' | 'comments' | 'clean'

/**
 * One review thread I opened on the pull request, as GitHub holds it. Its
 * texts are the pull request's: drawn as plain text, never followed.
 */
export type PastThread = {
  /** GitHub's node id of the thread. */
  id: string
  path: string
  /** The line today; absent once the code under the thread changed. */
  line?: number
  originalLine?: number
  isResolved: boolean
  isOutdated: boolean
  /** My first comment, on one line. */
  comment: string
  /** What others answered, newest first. */
  replies: string[]
}

/** My earlier reviews of a pull request; held only where there is at least one. */
export type History = {
  count: number
  lastReviewedAt: string
  lastState: 'COMMENTED' | 'APPROVED' | 'CHANGES_REQUESTED' | 'DISMISSED'
  threads: PastThread[]
  /** Threads of mine beyond the ones held. */
  more?: number
}

/** The pre-read's view of one earlier thread: whether today's code answers it. */
export type Followup = { id: string; state: 'addressed' | 'open' | 'unclear'; note: string }

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
  /** Who opened the pull request, by login; absent until a fetch brings it. */
  author?: string
  /** The pull request's size as GitHub counts it; absent until a fetch brings it. */
  lines?: { added: number; removed: number; files: number }
  status: 'queued' | 'reviewing' | 'done' | 'failed'
  failReason?: string
  agentId?: string
  reviewStartedAt?: string
  verdict?: Verdict
  findings: Finding[]
  humanReview: string[]
  /** My earlier reviews, as the last fetch read them; absent when I have not reviewed it. */
  history?: History
  /** The pre-read's view of the earlier threads; absent when it was given none. */
  followups?: Followup[]
  /** What the reviewer verified; absent on a review kept from before it was asked for. */
  checked?: string[]
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
  | { kind: 'add'; place: string; at?: { file: string; line: number; side?: 'LEFT' }; error?: string }
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
  comments: { path: string; line: number; side: 'RIGHT' | 'LEFT'; body: string }[]
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
  /** Whether the selected review's description is drawn in full. */
  isBodyOpen?: boolean
  /** The comment an approval of the selected review goes with; absent until typed. */
  approveComment?: string
  /**
   * The diff screen of the review `key`: its files, and the one drawn open.
   * Drawn only while `key` is the selected review.
   */
  diffView?: {
    key: string
    files: { path: string; added: number; removed: number }[]
    /**
     * `isCut`: the file's diff was longer than is kept. `page`: which stretch of
     * its rows is drawn, from 0; a surface does not draw a tree of every row.
     */
    open?: { path: string; source: string; isCut: boolean; page: number }
    /** Whether the open file is drawn as saved; absent, changes of whitespace alone are folded. */
    showsWhitespace?: boolean
  }
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
