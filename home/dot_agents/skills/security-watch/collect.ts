// Usage:
//   node collect.ts collect   Fetch the last N days, drop reported items, write pending.json and print it
//   node collect.ts mark      Move every key in pending.json to seen.json
// State lives in $SECURITY_WATCH_STATE_DIR (default ~/.local/state/security-watch), per machine.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type Advisory,
  type Item,
  type Seen,
  advisoryToItem,
  dedupKeys,
  filterUnseen,
  markSeen,
  matchesKeywords,
  parseFeed,
  passesAdvisoryFilter,
  pruneSeen,
  withinWindow,
} from './lib.ts'

type FeedSource = { name: string; axis: string; url: string; keywordFilter: boolean }

type Config = {
  windowDays: number
  seenTtlDays: number
  keywords: string[]
  watchPackages: string[]
  feeds: FeedSource[]
  githubAdvisory: { name: string; axis: string; ecosystem: string }
}

type SourceResult = { items: Item[]; error?: string }

const FETCH_TIMEOUT_MS = 20_000
const USER_AGENT = 'security-watch/1.0 (personal feed reader)'

const stateDir = process.env.SECURITY_WATCH_STATE_DIR ?? join(homedir(), '.local/state/security-watch')
const seenPath = join(stateDir, 'seen.json')
const pendingPath = join(stateDir, 'pending.json')

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw error
  }
}

async function collectFeed(source: FeedSource, config: Config, now: Date): Promise<SourceResult> {
  try {
    const response = await fetch(source.url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) return { items: [], error: `${source.name}: HTTP ${response.status}` }
    const entries = parseFeed(await response.text())
    if (entries.length === 0) return { items: [], error: `${source.name}: フィードから 0 件しか取れなかった` }
    const recent = withinWindow(entries, now, config.windowDays)
    const relevant = source.keywordFilter
      ? recent.filter((entry) => matchesKeywords(`${entry.title} ${entry.summary}`, config.keywords))
      : recent
    return {
      items: relevant.map((entry) => ({ ...entry, source: source.name, axis: source.axis, keys: dedupKeys(entry) })),
    }
  } catch (error) {
    return { items: [], error: `${source.name}: ${(error as Error).message}` }
  }
}

type GhAdvisory = {
  ghsa_id: string
  cve_id: string | null
  severity: string
  summary: string
  html_url: string
  published_at: string
  vulnerabilities: { package: { name: string } | null }[] | null
}

async function collectAdvisories(config: Config, now: Date): Promise<SourceResult> {
  const { name, axis, ecosystem } = config.githubAdvisory
  const since = new Date(now.getTime() - config.windowDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const endpoint = `/advisories?ecosystem=${ecosystem}&per_page=100&published=${encodeURIComponent(`>=${since}`)}`
  try {
    const { stdout } = await promisify(execFile)('gh', ['api', '--paginate', endpoint, '--jq', '.[]'], {
      maxBuffer: 64 * 1024 * 1024,
    })
    const advisories: Advisory[] = stdout
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as GhAdvisory)
      .map((gh) => ({
        ghsaId: gh.ghsa_id,
        cveId: gh.cve_id,
        severity: gh.severity,
        summary: gh.summary,
        url: gh.html_url,
        published: gh.published_at,
        packages: (gh.vulnerabilities ?? []).flatMap((v) => (v.package ? [v.package.name] : [])),
      }))
    const items = withinWindow(advisories, now, config.windowDays)
      .filter((advisory) => passesAdvisoryFilter(advisory, config.watchPackages))
      .map((advisory) => advisoryToItem(advisory, name, axis))
    return { items }
  } catch (error) {
    return { items: [], error: `${name}: ${(error as Error).message.split('\n')[0]}` }
  }
}

async function collect(): Promise<void> {
  const config = await readJson<Config>(new URL('./sources.json', import.meta.url).pathname, null as never)
  const now = new Date()
  const results = await Promise.all([
    ...config.feeds.map((source) => collectFeed(source, config, now)),
    collectAdvisories(config, now),
  ])
  const collected = results.flatMap((result) => result.items)
  const seen = pruneSeen(await readJson<Seen>(seenPath, {}), now, config.seenTtlDays)
  const items = filterUnseen(collected, seen)
  const output = {
    generatedAt: now.toISOString(),
    windowDays: config.windowDays,
    stats: { collected: collected.length, unreported: items.length },
    errors: results.flatMap((result) => (result.error ? [result.error] : [])),
    items,
  }
  await mkdir(join(stateDir, 'reports'), { recursive: true })
  await writeFile(pendingPath, `${JSON.stringify(output, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

async function mark(): Promise<void> {
  const config = await readJson<Config>(new URL('./sources.json', import.meta.url).pathname, null as never)
  const pending = await readJson<{ items: Item[] } | null>(pendingPath, null)
  if (!pending) {
    process.stdout.write('pending.json が無いので何もしない\n')
    return
  }
  const now = new Date()
  const seen = pruneSeen(await readJson<Seen>(seenPath, {}), now, config.seenTtlDays)
  const next = markSeen(
    seen,
    pending.items.flatMap((item) => item.keys),
    now,
  )
  await writeFile(seenPath, `${JSON.stringify(next, null, 2)}\n`)
  await rm(pendingPath)
  process.stdout.write(`${pending.items.length} 件を既報告にした（seen のキー ${Object.keys(next).length} 個）\n`)
}

const command = process.argv[2]
if (command === 'collect') await collect()
else if (command === 'mark') await mark()
else {
  process.stderr.write('usage: node collect.ts <collect|mark>\n')
  process.exit(2)
}
