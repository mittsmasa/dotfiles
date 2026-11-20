import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  type Advisory,
  dedupKeys,
  extractCves,
  filterUnseen,
  matchesKeywords,
  normalizeUrl,
  parseFeed,
  passesAdvisoryFilter,
  pruneSeen,
  withinWindow,
} from './lib.ts'

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Feed</title><link>https://example.com/</link>
<item>
  <title><![CDATA[npm package &quot;foo&quot; hijacked]]></title>
  <link>https://example.com/posts/foo/?utm_source=rss</link>
  <pubDate>Wed, 18 Nov 2026 10:00:00 GMT</pubDate>
  <description>&lt;p&gt;Fixes CVE-2026-1234.&lt;/p&gt;</description>
</item>
</channel></rss>`

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Feed</title>
<link rel="self" href="https://example.com/feed.atom"/>
<entry>
  <title type="html">Next.js advisory</title>
  <link rel="alternate" href="https://example.com/next"/>
  <published>2026-11-19T00:00:00Z</published>
  <summary>Middleware bypass</summary>
</entry>
</feed>`

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>JPCERT</title><items><rdf:Seq/></items></channel>
<item rdf:about="https://example.jp/at/2026/0001.html">
  <title>Node.js の脆弱性に関する注意喚起</title>
  <link>https://example.jp/at/2026/0001.html</link>
  <dc:date>2026-11-17T09:00:00+09:00</dc:date>
</item>
</rdf:RDF>`

describe('parseFeed', () => {
  const cases = [
    {
      format: 'RSS 2.0',
      xml: RSS,
      expected: {
        title: 'npm package "foo" hijacked',
        url: 'https://example.com/posts/foo/?utm_source=rss',
        published: 'Wed, 18 Nov 2026 10:00:00 GMT',
        summary: 'Fixes CVE-2026-1234.',
      },
    },
    {
      format: 'Atom',
      xml: ATOM,
      expected: {
        title: 'Next.js advisory',
        url: 'https://example.com/next',
        published: '2026-11-19T00:00:00Z',
        summary: 'Middleware bypass',
      },
    },
    {
      format: 'RSS 1.0 (RDF)',
      xml: RDF,
      expected: {
        title: 'Node.js の脆弱性に関する注意喚起',
        url: 'https://example.jp/at/2026/0001.html',
        published: '2026-11-17T09:00:00+09:00',
        summary: '',
      },
    },
  ]
  for (const { format, xml, expected } of cases) {
    test(`${format} のエントリを 1 件取り出す`, () => {
      assert.deepEqual(parseFeed(xml), [expected])
    })
  }
})

describe('withinWindow', () => {
  const now = new Date('2026-11-20T00:00:00Z')
  const cases = [
    { published: '2026-11-13T00:00:00Z', kept: true, note: 'ちょうど 7 日前は残る' },
    { published: '2026-11-12T23:59:59Z', kept: false, note: '7 日より 1 秒古いと落ちる' },
    { published: 'not a date', kept: true, note: '日付が読めないものは残す' },
  ]
  for (const { published, kept, note } of cases) {
    test(note, () => {
      assert.equal(withinWindow([{ published }], now, 7).length, kept ? 1 : 0)
    })
  }
})

describe('matchesKeywords', () => {
  const keywords = ['react', 'next.js', 'npm', 'サプライチェーン']
  const cases = [
    { text: 'Critical flaw in React Server Components', matched: true, note: '大文字小文字を区別しない' },
    { text: 'Next.js middleware bypass', matched: true, note: '記号を含むキーワードに一致する' },
    { text: 'Chain reaction in the market', matched: false, note: '単語の一部には一致しない' },
    { text: 'ソフトウェアサプライチェーン攻撃が拡大', matched: true, note: '日本語は部分一致する' },
    { text: 'Windows の脆弱性', matched: false, note: 'どのキーワードも含まなければ一致しない' },
  ]
  for (const { text, matched, note } of cases) {
    test(note, () => {
      assert.equal(matchesKeywords(text, keywords), matched)
    })
  }
})

describe('passesAdvisoryFilter', () => {
  const watch = ['next', '@nestjs/*']
  const base: Advisory = {
    ghsaId: 'GHSA-xxxx-xxxx-xxxx',
    cveId: null,
    severity: 'high',
    summary: '',
    url: '',
    published: '',
    packages: [],
  }
  const cases = [
    { packages: ['next'], severity: 'moderate', passes: true, note: '監視パッケージなら critical でなくても通る' },
    { packages: ['@nestjs/core'], severity: 'high', passes: true, note: 'scope のワイルドカードに一致する' },
    { packages: ['nextjs-helper'], severity: 'high', passes: false, note: '監視外の high は落ちる' },
    { packages: ['unknown-pkg'], severity: 'critical', passes: true, note: '監視外でも critical は通る' },
  ]
  for (const { packages, severity, passes, note } of cases) {
    test(note, () => {
      assert.equal(passesAdvisoryFilter({ ...base, packages, severity }, watch), passes)
    })
  }
})

describe('normalizeUrl', () => {
  const cases = [
    { raw: 'https://Example.com/posts/foo/?utm_source=rss#top', expected: 'https://example.com/posts/foo' },
    { raw: 'https://example.com/posts/foo', expected: 'https://example.com/posts/foo' },
    { raw: 'not a url', expected: 'not a url' },
  ]
  for (const { raw, expected } of cases) {
    test(`${raw} を ${expected} にする`, () => {
      assert.equal(normalizeUrl(raw), expected)
    })
  }
})

test('extractCves は大文字にそろえて重複を除く', () => {
  assert.deepEqual(extractCves('cve-2026-1234 and CVE-2026-1234, CVE-2025-99999'), ['CVE-2026-1234', 'CVE-2025-99999'])
})

test('URL が違っても CVE が既報告なら除外する', () => {
  const reported = { keys: dedupKeys({ url: 'https://a.example/x', title: 'CVE-2026-1234 in foo', summary: '' }) }
  const other = { keys: dedupKeys({ url: 'https://b.example/y', title: 'foo flaw', summary: 'tracked as CVE-2026-1234' }) }
  const seen = Object.fromEntries(reported.keys.map((key) => [key, '2026-11-19T00:00:00Z']))
  assert.deepEqual(filterUnseen([other], seen), [])
})

test('pruneSeen は期限より古いキーだけを消す', () => {
  const seen = { 'url:old': '2026-10-20T23:59:59Z', 'url:new': '2026-10-21T00:00:00Z' }
  assert.deepEqual(pruneSeen(seen, new Date('2026-11-20T00:00:00Z'), 30), { 'url:new': '2026-10-21T00:00:00Z' })
})
