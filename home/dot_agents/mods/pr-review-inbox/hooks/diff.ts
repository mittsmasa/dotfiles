// Reading a saved unified diff for the pane: the hunk a finding sits in.

const isHunkRow = (row: string) =>
  row.startsWith(' ') || row.startsWith('+') || row.startsWith('-') || row.startsWith('\\')

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
      current = row.startsWith('+++ b/') ? row.slice(6) : undefined
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
