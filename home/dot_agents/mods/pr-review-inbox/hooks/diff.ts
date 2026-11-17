// Reading a saved unified diff for the pane: the hunk a finding sits in, and
// the files and rows of the diff screen.

const isHunkRow = (row: string) =>
  row.startsWith(' ') || row.startsWith('+') || row.startsWith('-') || row.startsWith('\\')

/**
 * The path a `--- ` or `+++ ` row names, or nothing for `/dev/null`. git ends
 * a path that holds a space with a tab; it is no part of the path.
 */
export function pathOfRow(row: string, prefix: '--- a/' | '+++ b/'): string | undefined {
  return row.startsWith(prefix) ? row.slice(prefix.length).replace(/\t$/, '') : undefined
}

/**
 * The hunk of `file` that shows right-side `line`, from its `@@` header to its
 * last row, or nothing when the diff shows no such line of that file.
 */
export function hunkAt(diff: string, file: string, line: number): string | undefined {
  let current: string | undefined
  let hunk: string[] = []
  let next = 0
  let isInHunk = false
  let isHit = false
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ') || row.startsWith('@@ ')) {
      if (isHit) break
      const start = row.startsWith('@@ ') ? /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(row)?.[1] : undefined
      if (row.startsWith('diff --git ')) current = undefined
      isInHunk = start !== undefined
      hunk = isInHunk ? [row] : []
      next = Number(start)
    } else if (!isInHunk && row.startsWith('+++ ')) {
      current = pathOfRow(row, '+++ b/')
    } else if (isInHunk && isHunkRow(row)) {
      hunk.push(row)
      if (row.startsWith('+') || row.startsWith(' ')) {
        if (current === file && next === line) isHit = true
        next += 1
      }
    }
  }

  return isHit ? hunk.join('\n') : undefined
}

export type DiffFile = { path: string; added: number; removed: number }

type Section = DiffFile & { hunks: string[] }

/** The diff cut at each `diff --git`: a file's path, its counts and its hunk rows. */
function sectionsOf(diff: string): Section[] {
  const sections: Section[] = []
  let current: (Section & { fallback: string; old?: string; isNamed: boolean }) | undefined
  let isInHunk = false
  const close = () => {
    if (!current) return
    const { fallback, old, isNamed, ...section } = current
    sections.push({ ...section, path: isNamed ? section.path : (old ?? fallback) })
  }
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      close()
      // The header's own second path: all a rename or a binary file leaves to go by.
      const fallback = / b\/(.*)$/.exec(row)?.[1] ?? ''
      current = { path: '', added: 0, removed: 0, hunks: [], fallback, isNamed: false }
      isInHunk = false
    } else if (!current) {
      continue
    } else if (row.startsWith('@@ ')) {
      isInHunk = /^@@ -\d+(?:,\d+)? \+\d+/.test(row)
      if (isInHunk) current.hunks.push(row)
    } else if (!isInHunk) {
      const old = pathOfRow(row, '--- a/')
      const path = pathOfRow(row, '+++ b/')
      if (old !== undefined) current.old = old
      if (path !== undefined) {
        current.path = path
        current.isNamed = true
      }
    } else if (isHunkRow(row)) {
      current.hunks.push(row)
      if (row.startsWith('+')) current.added += 1
      if (row.startsWith('-')) current.removed += 1
    }
  }
  close()

  return sections.filter(section => section.path !== '')
}

/** The files a diff changes, in its order, with the lines each adds and removes. */
export function filesOf(diff: string): DiffFile[] {
  return sectionsOf(diff).map(({ path, added, removed }) => ({ path, added, removed }))
}

/**
 * The hunks of one file, cut at a row's end once they pass either limit: one
 * drawing holds only so much. Empty for a file with no hunk, or not in the diff.
 */
export function fileDiff(
  diff: string,
  path: string,
  limits: { chars: number; rows: number },
): { source: string; isCut: boolean } {
  const hunks = sectionsOf(diff).find(section => section.path === path)?.hunks ?? []
  const kept: string[] = []
  let chars = 0
  for (const row of hunks) {
    if (kept.length >= limits.rows || chars + row.length + 1 > limits.chars) break
    kept.push(row)
    chars += row.length + 1
  }

  return { source: kept.join('\n'), isCut: kept.length < hunks.length }
}

export type DiffRow =
  | { kind: 'hunk'; text: string }
  | { kind: 'add'; newLine: number; text: string }
  | { kind: 'remove'; oldLine: number; text: string }
  | { kind: 'context'; oldLine: number; newLine: number; text: string }

/** A file's hunks as rows, each line numbered from its hunk's header. */
export function rowsOf(source: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  for (const row of source.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(row)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      rows.push({ kind: 'hunk', text: row })
    } else if (row.startsWith('+')) {
      rows.push({ kind: 'add', newLine, text: row.slice(1) })
      newLine += 1
    } else if (row.startsWith('-')) {
      rows.push({ kind: 'remove', oldLine, text: row.slice(1) })
      oldLine += 1
    } else if (row.startsWith(' ')) {
      rows.push({ kind: 'context', oldLine, newLine, text: row.slice(1) })
      oldLine += 1
      newLine += 1
    }
  }

  return rows
}

// Rows of a file drawn at once. The desktop app drew a file of 11 rows and
// left the pane empty for one of 340: the tree of a long file has to be cut.
export const DIFF_PAGE_ROWS = 100

/** How many pages a file's rows make; one even with no row. */
export function pageCountOf(rowCount: number): number {
  return Math.max(1, Math.ceil(rowCount / DIFF_PAGE_ROWS))
}

// Control characters a Text refuses, and the ones that reorder what is read.
const UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f‪-‮⁦-⁩]/g

/**
 * A line of a diff made safe to draw as Text: the diff is the pull request's.
 * A tab becomes two spaces; any other control character, and the bidi controls
 * that show code in an order it does not run in, become U+FFFD.
 */
export function safeText(text: string): string {
  return text.replace(/\t/g, '  ').replace(UNSAFE, '�')
}
