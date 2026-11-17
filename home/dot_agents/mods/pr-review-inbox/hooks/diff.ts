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
export function hunkAt(diff: string, file: string, line: number, side: 'RIGHT' | 'LEFT' = 'RIGHT'): string | undefined {
  let current: string | undefined
  let old: string | undefined
  let hunk: string[] = []
  let next = 0
  let oldNext = 0
  let isInHunk = false
  let isHit = false
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ') || row.startsWith('@@ ')) {
      if (isHit) break
      const starts = row.startsWith('@@ ') ? /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(row) : null
      if (row.startsWith('diff --git ')) {
        current = undefined
        old = undefined
      }
      isInHunk = starts !== null
      hunk = isInHunk ? [row] : []
      oldNext = Number(starts?.[1])
      next = Number(starts?.[2])
    } else if (!isInHunk && row.startsWith('--- ')) {
      old = pathOfRow(row, '--- a/')
    } else if (!isInHunk && row.startsWith('+++ ')) {
      // A deleted file has no new path: it goes by its old one, as on the diff screen.
      current = pathOfRow(row, '+++ b/') ?? old
    } else if (isInHunk && isHunkRow(row)) {
      hunk.push(row)
      if (row.startsWith('-') || row.startsWith(' ')) {
        if (side === 'LEFT' && row.startsWith('-') && current === file && oldNext === line) isHit = true
        oldNext += 1
      }
      if (row.startsWith('+') || row.startsWith(' ')) {
        if (side === 'RIGHT' && current === file && next === line) isHit = true
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

const bare = (text: string) => text.replace(/\s+/g, '')

/**
 * A run of removed rows and the run of added rows after it, with the rows that
 * differ in whitespace alone paired, in order, into context rows: the text of
 * the new side, the numbers of both. What is left keeps the diff's order,
 * removed before added.
 */
function pairUp(
  removed: readonly Extract<DiffRow, { kind: 'remove' }>[],
  added: readonly Extract<DiffRow, { kind: 'add' }>[],
): DiffRow[] {
  // The longest common subsequence of the two runs, compared without whitespace.
  const width = added.length + 1
  const lengths = new Uint16Array((removed.length + 1) * width)
  for (let r = removed.length - 1; r >= 0; r -= 1) {
    for (let a = added.length - 1; a >= 0; a -= 1) {
      lengths[r * width + a] =
        bare((removed[r] as DiffRow).text) === bare((added[a] as DiffRow).text)
          ? (lengths[(r + 1) * width + a + 1] as number) + 1
          : Math.max(lengths[(r + 1) * width + a] as number, lengths[r * width + a + 1] as number)
    }
  }
  // The pairs, walked from the front: between two pairs, the removed rows, then the added ones.
  const out: DiffRow[] = []
  let r = 0
  let a = 0
  let fromRemoved = 0
  let fromAdded = 0
  while (r < removed.length && a < added.length) {
    const gone = removed[r] as Extract<DiffRow, { kind: 'remove' }>
    const come = added[a] as Extract<DiffRow, { kind: 'add' }>
    if (bare(gone.text) === bare(come.text)) {
      out.push(...removed.slice(fromRemoved, r), ...added.slice(fromAdded, a))
      out.push({ kind: 'context', oldLine: gone.oldLine, newLine: come.newLine, text: come.text })
      r += 1
      a += 1
      fromRemoved = r
      fromAdded = a
    } else if ((lengths[(r + 1) * width + a] as number) >= (lengths[r * width + a + 1] as number)) {
      r += 1
    } else {
      a += 1
    }
  }

  return [...out, ...removed.slice(fromRemoved), ...added.slice(fromAdded)]
}

/**
 * A file's rows with the changes of whitespace alone folded away, as GitHub's
 * "Hide whitespace" reads: a line that only moved its indent is a context row,
 * and a hunk left with no change is not shown. Line numbers and hunk headers
 * are the saved diff's own, so a place picked here is a place in that diff.
 */
export function foldWhitespace(rows: readonly DiffRow[]): DiffRow[] {
  const out: DiffRow[] = []
  let header: DiffRow | undefined
  let hunk: DiffRow[] = []
  const flush = () => {
    const folded: DiffRow[] = []
    for (let index = 0; index < hunk.length; ) {
      const row = hunk[index] as DiffRow
      if (row.kind !== 'remove') {
        folded.push(row)
        index += 1
        continue
      }
      const removed: Extract<DiffRow, { kind: 'remove' }>[] = []
      const added: Extract<DiffRow, { kind: 'add' }>[] = []
      for (let next = hunk[index]; next?.kind === 'remove'; next = hunk[index]) {
        removed.push(next)
        index += 1
      }
      for (let next = hunk[index]; next?.kind === 'add'; next = hunk[index]) {
        added.push(next)
        index += 1
      }
      folded.push(...pairUp(removed, added))
    }
    if (folded.some(row => row.kind === 'add' || row.kind === 'remove')) out.push(...(header ? [header] : []), ...folded)
    hunk = []
  }
  for (const row of rows) {
    if (row.kind === 'hunk') {
      flush()
      header = row
    } else {
      hunk.push(row)
    }
  }
  flush()

  return out
}

/** The rows of a file as the diff screen draws them: folded unless whitespace is asked for. */
export function shownRows(source: string, showsWhitespace: boolean): DiffRow[] {
  return showsWhitespace ? rowsOf(source) : foldWhitespace(rowsOf(source))
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
