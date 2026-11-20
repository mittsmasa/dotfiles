// Pure functions for security-watch. No I/O here; collect.ts owns fetch and file access.

export type FeedEntry = {
  title: string
  url: string
  published: string
  summary: string
}

export type Item = FeedEntry & {
  source: string
  axis: string
  keys: string[]
}

export type Advisory = {
  ghsaId: string
  cveId: string | null
  severity: string
  summary: string
  url: string
  published: string
  packages: string[]
}

/** Seen keys mapped to the ISO time they were first reported. */
export type Seen = Record<string, string>

const DAY_MS = 24 * 60 * 60 * 1000

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16))
    if (code.startsWith('#')) return String.fromCodePoint(Number.parseInt(code.slice(1), 10))
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

function cleanText(raw: string): string {
  const withoutCdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  // Entities are decoded before stripping tags because some feeds escape their HTML.
  return decodeEntities(withoutCdata)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function firstTag(block: string, names: string[]): string | null {
  for (const name of names) {
    const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
    if (match) return match[1]
  }
  return null
}

function entryLink(block: string): string {
  // Atom: <link href="..."/>, preferring rel="alternate" or no rel.
  const atomLinks = [...block.matchAll(/<link\b([^>]*?)\/?>/gi)]
    .map((m) => m[1])
    .filter((attrs) => /href=/i.test(attrs))
  const preferred = atomLinks.find((attrs) => !/rel=/i.test(attrs) || /rel=["']alternate["']/i.test(attrs)) ?? atomLinks[0]
  if (preferred) {
    const href = preferred.match(/href=["']([^"']+)["']/i)
    if (href) return decodeEntities(href[1]).trim()
  }
  // RSS / RDF: <link>...</link>
  const text = firstTag(block, ['link'])
  if (text) return cleanText(text)
  const guid = firstTag(block, ['guid'])
  return guid ? cleanText(guid) : ''
}

/** Parses RSS 2.0, Atom and RSS 1.0 (RDF) feeds with regular expressions. */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? []
  return blocks.map((block) => {
    const published = firstTag(block, ['pubDate', 'published', 'dc:date', 'updated']) ?? ''
    const summary = firstTag(block, ['description', 'summary', 'content:encoded', 'content']) ?? ''
    return {
      title: cleanText(firstTag(block, ['title']) ?? ''),
      url: entryLink(block),
      published: cleanText(published),
      summary: cleanText(summary).slice(0, 400),
    }
  })
}

/** Keeps entries published within `days` before `now`. Entries without a parsable date are kept. */
export function withinWindow<T extends { published: string }>(entries: T[], now: Date, days: number): T[] {
  const from = now.getTime() - days * DAY_MS
  return entries.filter((entry) => {
    const time = Date.parse(entry.published)
    return Number.isNaN(time) || time >= from
  })
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Case-insensitive keyword match. ASCII keywords match on word boundaries so "react" does not match "reaction". */
export function matchesKeywords(text: string, keywords: string[]): boolean {
  return keywords.some((keyword) => {
    if (/^[\x20-\x7e]+$/.test(keyword)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}($|[^a-z0-9])`, 'i').test(text)
    }
    return text.includes(keyword)
  })
}

/** `@scope/*` matches every package of the scope; other patterns match exactly. */
export function matchesPackage(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('/*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern,
  )
}

export function passesAdvisoryFilter(advisory: Advisory, watchPackages: string[]): boolean {
  return advisory.severity === 'critical' || advisory.packages.some((name) => matchesPackage(name, watchPackages))
}

export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    const path = url.pathname.replace(/\/+$/, '')
    return `${url.protocol}//${url.host.toLowerCase()}${path}`
  } catch {
    return raw.trim()
  }
}

export function extractCves(text: string): string[] {
  const found = text.match(/CVE-\d{4}-\d{4,}/gi) ?? []
  return [...new Set(found.map((cve) => cve.toUpperCase()))]
}

export function dedupKeys(entry: { url: string; title: string; summary: string }, ghsaId?: string): string[] {
  const keys = [`url:${normalizeUrl(entry.url)}`]
  if (ghsaId) keys.push(`ghsa:${ghsaId.toUpperCase()}`)
  for (const cve of extractCves(`${entry.title} ${entry.summary}`)) keys.push(`cve:${cve}`)
  return keys
}

export function filterUnseen<T extends { keys: string[] }>(items: T[], seen: Seen): T[] {
  return items.filter((item) => !item.keys.some((key) => key in seen))
}

export function markSeen(seen: Seen, keys: string[], now: Date): Seen {
  const next = { ...seen }
  for (const key of keys) next[key] ??= now.toISOString()
  return next
}

export function pruneSeen(seen: Seen, now: Date, ttlDays: number): Seen {
  const from = now.getTime() - ttlDays * DAY_MS
  return Object.fromEntries(Object.entries(seen).filter(([, at]) => Date.parse(at) >= from))
}

export function advisoryToItem(advisory: Advisory, source: string, axis: string): Item {
  const title = `${advisory.cveId ?? advisory.ghsaId} [${advisory.severity}] ${advisory.packages.join(', ')}: ${advisory.summary}`
  const entry = { title, url: advisory.url, published: advisory.published, summary: '' }
  return { ...entry, source, axis, keys: dedupKeys(entry, advisory.ghsaId) }
}
