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
 * How the viewpoint files are explained to the reviewer: the testable-design
 * sections by default, a short generic note for files set without a guide, or
 * the text of the guide file the config names.
 */
export type GuideSource = { kind: 'testable-design' } | { kind: 'generic' } | { kind: 'file'; path: string }

export type Profile = {
  /** Viewpoint files, `~` expanded, not yet resolved; read in this order. */
  viewpoints: string[]
  guide: GuideSource
  /** The file whose text replaces the comment style; the built-in one without. */
  commentStyle?: string
  /** The checks to run; undefined runs the default testable-design ones. */
  checks?: Check[]
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

  const guide: GuideSource = guidePath
    ? { kind: 'file', path: guidePath }
    : viewpoints
      ? { kind: 'generic' }
      : { kind: 'testable-design' }

  return {
    profile: {
      viewpoints: viewpoints ?? SKILL_FILES.map(file => `${skillDirOf(home)}/${file}`),
      guide,
      ...(commentStyle ? { commentStyle } : {}),
      ...(checks ? { checks } : {}),
    },
    warnings,
  }
}

/** What a stat of one viewpoint path found; `kind` is absent when nothing is there. */
export type ViewpointStat = { path: string; kind?: 'file' | 'dir' | 'other' }

/**
 * Only plain files are kept: a reviewer may read what was named and nothing
 * beside it. A missing file is left out quietly, as the default skill may be absent.
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

/** The default checks: oxlint and testable-scan from the skill, with the binaries already resolved. */
export function defaultChecks(tools: { oxlint: string; node: string }, skillDir: string): Check[] {
  const dir = `${skillDir}/tools`

  return [
    {
      name: 'oxlint',
      argv: [tools.oxlint, '-c', `${dir}/oxlintrc.json`, '-f', 'json', '{files}'],
      stdout: 'oxlint.json',
      outputs: [],
    },
    {
      name: 'testable-scan',
      argv: [tools.node, `${dir}/bin/testable-scan.ts`, '{worktree}', '{relativeFiles}', '--out', '{outDir}'],
      outputs: ['candidates.json', 'ir.json'],
    },
  ]
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
