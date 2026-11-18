// What a pre-read is made of, as the config file sets it: the mechanical
// checks, the viewpoint files, and the files that replace the prompt's guide
// and comment style. Pure: no `$`. run.ts runs what is decided here.

/** One mechanical check: an argument vector run with no shell, in the data directory. */
export type Check = {
  name: string
  argv: string[]
  /** The file in the output directory its standard output goes to. */
  stdout?: string
  /** Files it writes into the output directory itself. */
  outputs: string[]
}

/**
 * How the viewpoint files are explained to the reviewer: a short generic note
 * by default, or the text of the guide file the config names.
 */
export type GuideSource = { kind: 'generic' } | { kind: 'file'; path: string }

export type Profile = {
  /** Viewpoint files or globs, `~` expanded, not yet resolved; read in this order. None by default. */
  viewpoints: string[]
  guide: GuideSource
  /** The file whose text replaces the comment style; the built-in one without. */
  commentStyle?: string
  /** The checks to run; none by default. */
  checks: Check[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const expandHome = (path: string, home: string) =>
  path === '~' || path.startsWith('~/') ? home + path.slice(1) : path

/** A file name inside the output directory: one plain segment. */
const isOutputName = (name: unknown): name is string =>
  typeof name === 'string' && /^[\w.-]+$/.test(name) && name !== '.' && name !== '..'

function parseCheck(raw: unknown, home: string): Check | string {
  if (!isRecord(raw)) return 'checks の項目がオブジェクトではない'
  const name = typeof raw.name === 'string' && /^[\w.-]+$/.test(raw.name) ? raw.name : undefined
  if (!name) return 'checks の項目に name が無い'
  const argv = raw.argv
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(one => typeof one === 'string' && one !== '')) {
    return `checks.${name} の argv が文字列の配列ではない`
  }
  if (raw.stdout !== undefined && !isOutputName(raw.stdout)) return `checks.${name} の stdout がファイル名ではない`
  const outputs = raw.outputs ?? []
  if (!Array.isArray(outputs) || !outputs.every(isOutputName)) return `checks.${name} の outputs がファイル名の配列ではない`

  return {
    name,
    argv: (argv as string[]).map(one => expandHome(one, home)),
    ...(raw.stdout === undefined ? {} : { stdout: raw.stdout as string }),
    outputs: outputs as string[],
  }
}

const optionalPath = (raw: unknown, key: string, home: string, warnings: string[]): string | undefined => {
  if (raw === undefined) return undefined
  if (typeof raw === 'string' && raw !== '') return expandHome(raw, home)
  warnings.push(`review.${key} がパスではない`)

  return undefined
}

/**
 * The `review` section, read item by item: an item that does not read is
 * dropped for the default and named in `warnings`, the rest still apply.
 */
export function parseProfile(raw: unknown, home: string): { profile: Profile; warnings: string[] } {
  const warnings: string[] = []
  const section = raw === undefined ? {} : isRecord(raw) ? raw : (warnings.push('review がオブジェクトではない'), {})

  let viewpoints: string[] | undefined
  if (section.viewpoints !== undefined) {
    const list = section.viewpoints
    if (Array.isArray(list) && list.every(one => typeof one === 'string' && one !== '')) {
      viewpoints = (list as string[]).map(one => expandHome(one, home))
    } else {
      warnings.push('review.viewpoints がパスの配列ではない')
    }
  }
  const guidePath = optionalPath(section.guide, 'guide', home, warnings)
  const commentStyle = optionalPath(section.commentStyle, 'commentStyle', home, warnings)

  let checks: Check[] | undefined
  if (section.checks !== undefined) {
    if (Array.isArray(section.checks)) {
      checks = []
      for (const one of section.checks) {
        const parsed = parseCheck(one, home)
        if (typeof parsed === 'string') warnings.push(parsed)
        else if (checks.some(check => check.name === parsed.name)) warnings.push(`checks.${parsed.name} が重複している`)
        else checks.push(parsed)
      }
    } else {
      warnings.push('review.checks が配列ではない')
    }
  }

  const guide: GuideSource = guidePath ? { kind: 'file', path: guidePath } : { kind: 'generic' }

  return {
    profile: {
      viewpoints: viewpoints ?? [],
      guide,
      ...(commentStyle ? { commentStyle } : {}),
      checks: checks ?? [],
    },
    warnings,
  }
}

/** What a stat of one viewpoint path found; `kind` is absent when nothing is there. */
export type ViewpointStat = { path: string; kind?: 'file' | 'dir' | 'other' }

/**
 * Only plain files are kept: a reviewer may read what was named and nothing
 * beside it. A missing file is left out quietly.
 */
export function pickViewpointFiles(stats: readonly ViewpointStat[]): { files: string[]; warnings: string[] } {
  const files: string[] = []
  const warnings: string[] = []
  for (const stat of stats) {
    if (stat.kind === 'file') files.push(stat.path)
    else if (stat.kind !== undefined) warnings.push(`review.viewpoints の ${stat.path} はファイルではない`)
  }

  return { files, warnings }
}

/** A viewpoint path is a glob when a segment holds `*`, `?` or `{a,b}`. */
export const isGlob = (path: string) => /[*?{]/.test(path)

/** The directory a glob is walked from: the segments before the first one holding a glob character. */
export function globBase(pattern: string): string {
  const segments = pattern.split('/')
  const first = segments.findIndex(isGlob)
  const base = segments.slice(0, first).join('/')

  return base === '' ? '/' : base
}

/**
 * `**` matches any number of directories (none included), `*` and `?` stay
 * inside one segment, `{a,b}` is either. Every other character is literal.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string
    if (char === '*' && pattern[i + 1] === '*') {
      const slash = pattern[i + 2] === '/'
      out += slash ? '(?:[^/]+/)*' : '.*'
      i += slash ? 2 : 1
    } else if (char === '*') out += '[^/]*'
    else if (char === '?') out += '[^/]'
    else if (char === '{') {
      const close = pattern.indexOf('}', i)
      if (close < 0) out += '\\{'
      else {
        out += `(?:${pattern.slice(i + 1, close).split(',').map(escapeRegExp).join('|')})`
        i = close
      }
    } else out += escapeRegExp(char)
  }

  return new RegExp(`^${out}$`)
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** What expanding the viewpoints reads: `$.fs.list` and `$.fs.stat`, or a fake in a test. */
export type ViewpointFs = {
  list: (path: string) => Promise<readonly { name: string; kind: 'file' | 'dir' | 'other'; isLink: boolean }[]>
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other' }>
}

/** Bounds on one glob's walk: a link loop or a pattern rooted too high stops here. */
const GLOB_MAX_DEPTH = 8
const GLOB_MAX_FILES = 100
const GLOB_MAX_DIRS = 500

/**
 * The files one glob matches, sorted by path. Names starting with `.` are
 * not walked into or matched, as in a shell. A link is followed; the depth
 * and directory bounds stop a loop.
 */
async function expandGlob(pattern: string, fs: ViewpointFs): Promise<{ files: string[]; warnings: string[] }> {
  const matcher = globToRegExp(pattern)
  const files: string[] = []
  let dirs = 0
  let isCut = false
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (isCut || depth > GLOB_MAX_DEPTH || ++dirs > GLOB_MAX_DIRS) {
      isCut = true

      return
    }
    const entries = await fs.list(dir).catch(() => [])
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith('.')) continue
      const path = `${dir === '/' ? '' : dir}/${entry.name}`
      const kind = entry.isLink ? (await fs.stat(path).catch(() => undefined))?.kind : entry.kind
      if (kind === 'dir') await walk(path, depth + 1)
      else if (kind === 'file' && matcher.test(path)) {
        if (files.length >= GLOB_MAX_FILES) {
          isCut = true

          return
        }
        files.push(path)
      }
    }
  }
  await walk(globBase(pattern), 0)
  files.sort()
  const warnings = [
    ...(files.length === 0 ? [`review.viewpoints の ${pattern} に合うファイルが無い`] : []),
    ...(isCut ? [`review.viewpoints の ${pattern} は広すぎるので途中までしか読まない`] : []),
  ]

  return { files, warnings }
}

/**
 * The viewpoint files to give the reviewer, in the config's order: a plain
 * path as `pickViewpointFiles` keeps it, a glob as the files it matches,
 * sorted by path. A file named twice is kept where it first appears.
 */
export async function resolveViewpoints(paths: readonly string[], fs: ViewpointFs): Promise<{ files: string[]; warnings: string[] }> {
  const files: string[] = []
  const warnings: string[] = []
  for (const path of paths) {
    const found = isGlob(path)
      ? await expandGlob(path, fs)
      : pickViewpointFiles([{ path, ...(await fs.stat(path).then(one => ({ kind: one.kind }), () => ({}))) }])
    for (const file of found.files) if (!files.includes(file)) files.push(file)
    warnings.push(...found.warnings)
  }

  return { files, warnings }
}

export type ArgvVars = {
  /** Real paths of the files to check, inside the worktree. */
  files: readonly string[]
  worktree: string
  outDir: string
}

/**
 * Fills the placeholders, one argument at a time: an argument that is exactly
 * `{files}` or `{relativeFiles}` becomes one argument per file, `{worktree}`
 * and `{outDir}` are replaced inside an argument, and nothing is split again.
 * A relative path starts with `./`, so a file named `-x` is no option.
 */
export function expandArgv(argv: readonly string[], vars: ArgvVars): string[] {
  const relative = vars.files.map(file =>
    file.startsWith(vars.worktree + '/') ? `./${file.slice(vars.worktree.length + 1)}` : `./${file}`,
  )

  return argv.flatMap(arg => {
    if (arg === '{files}') return [...vars.files]
    if (arg === '{relativeFiles}') return relative

    return [arg.replaceAll('{worktree}', vars.worktree).replaceAll('{outDir}', vars.outDir)]
  })
}

/** How one check ended: it ran (any exit code), or it could not start, timed out, or left no output. */
export type CheckResult = { check: Check; failure?: string }

/**
 * Whether a check that ran failed: only when an output it names is missing.
 * The exit code is not read: a lint that finds something exits non-zero, and
 * its output is the point.
 */
export function failureOf(ran: { exitCode: number; stderr: string }, missing: readonly string[]): string | undefined {
  if (missing.length === 0) return undefined

  return ran.stderr.trim().split('\n')[0]?.slice(0, 160) || `出力が無い: ${missing.join(', ')}`
}

/** The files a check writes into the output directory, in order. */
export const outputsOf = (check: Check) => [...(check.stdout ? [check.stdout] : []), ...check.outputs]

/** Whether a check is handed the changed scripts: only `{files}` and `{relativeFiles}` do that. */
export const takesFiles = (check: Check) => check.argv.some(arg => arg === '{files}' || arg === '{relativeFiles}')

/**
 * The checks to run when `scriptCount` changed scripts can be checked. With
 * none, a check handed the scripts has nothing to read and is left out; one
 * that reads the checkout itself (`{worktree}`) still runs, since a PR that
 * touches only workflows or Dockerfiles is where it matters most.
 */
export function checksToRun(checks: readonly Check[], scriptCount: number): { run: Check[]; skipped: string[] } {
  if (scriptCount > 0) return { run: [...checks], skipped: [] }

  return {
    run: checks.filter(check => !takesFiles(check)),
    skipped: checks.filter(check => takesFiles(check)).map(check => `${check.name}（対象の JS / TS ファイルなし）`),
  }
}

/**
 * A failed check is named in `skipped` and its output left out of what the
 * prompt lists; the output directory still goes to the reviewer for the rest.
 */
export function summarizeChecks(results: readonly CheckResult[]): {
  skipped: string[]
  outputs: { name: string; files: string[] }[]
} {
  return {
    skipped: results.flatMap(one => (one.failure === undefined ? [] : [`${one.check.name}（${one.failure}）`])),
    outputs: results.flatMap(one => (one.failure === undefined ? [{ name: one.check.name, files: outputsOf(one.check) }] : [])),
  }
}

/** Every warning on one line: the pane shows the first line of an error. */
export const warningLine = (warnings: readonly string[]) =>
  warnings.length === 0 ? undefined : `設定の誤り: ${warnings.map(one => one.replace(/\s+/g, ' ')).join(' / ')}`
