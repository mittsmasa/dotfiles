import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

import {
  findSlackServer,
  oneLine,
  parseParentText,
  parsePermalink,
  parseReplies,
  parseUserId,
  tsAfter,
} from '../hooks/slack'

// コネクタをつなぎ直すと変わる値。mod はセッションの MCP ツール一覧から引く。
const SERVER = '11111111-2222-3333-4444-555555555555'
const URL = 'https://x.slack.com/archives/C07QD6X30Q2/p1794214480861519?thread_ts=1793849534.425339'
const OWNER = 'U04DPHUN275'
const OTHER = 'U03A6KQJH8D'
const PARENT = '<@U04DPHUN275|mitsuhashi>\nお疲れ様です。\n1点ご相談が  あります。'
const TITLE = '@mitsuhashi お疲れ様です。 1点ご相談が あります。'

const reply = (ts: string, userId: string, name: string, text: string) =>
  `--- Reply 1 of 1 ---\nFrom: ${name} <${name}@example.com> (${userId})\nTime: 2026-11-09 17:54:29 JST\nMessage TS: ${ts}\n${text}\n`

const textResult = (text: string) => ({ content: [{ type: 'text', text }], isError: false })

const thread = (replies: readonly string[]) =>
  textResult(
    JSON.stringify({
      messages: `=== THREAD PARENT MESSAGE ===\nFrom: a (${OTHER})\nMessage TS: 1793849534.425339\n${PARENT}\nReactions: eyes (1)\n\n=== THREAD REPLIES (${replies.length} total) ===\n\n${replies.join('\n')}`,
    }),
  )

/** Slack とエンジンの代わりを立て、紐付けまで済ませる。 */
async function setUp($: Engine, on: On, initial: string[]) {
  const world = {
    replies: initial,
    submitted: [] as string[],
    toasts: [] as string[],
    isSubmitFailing: false,
    mcpTools: [`mcp__other__search`, `mcp__${SERVER}__slack_read_thread`, `mcp__${SERVER}__slack_send_message`],
  }
  // セッションが持つ MCP ツールの一覧。mod が読むのは名前だけなので、ほかの値は埋めない。
  on('session.usage', () => ({
    value: { context: { window: 0, breakdown: { mcpTools: world.mcpTools.map(name => ({ name })) } } },
  }) as never)
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'slack-link' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('mcp.call', (_, e) => {
    world.calledServers.push(e.server)
    if (e.tool === 'slack_read_user_profile') {
      return { value: textResult(JSON.stringify({ result: `User ID: ${OWNER}\nUsername: m\n` })) }
    }
    return { value: thread(world.replies) }
  })
  on('prompt.submit', (_, e) => {
    if (world.isSubmitFailing) throw new Error('submit failed')
    world.submitted.push(e.text)
    return { text: e.text }
  })
  on('tool.call', () => ({ result: {} }))
  on('ui.status', () => ({ value: undefined }))
  const clock = mock.clock(on)
  const run = (args: string) =>
    $.command.run({
      command: 'slack-link',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
  const checkNow = async () => {
    await run('now')
    await clock.settle()
  }

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await run(URL)

  return { world, clock, run, checkNow }
}

test('パーマリンクから親スレッドの channel と ts を取り出す', async () => {
  expect(parsePermalink(URL)).toEqual({ channel: 'C07QD6X30Q2', threadTs: '1793849534.425339' })
  expect(parsePermalink('https://x.slack.com/archives/C1/p1793849534425339')).toEqual({
    channel: 'C1',
    threadTs: '1793849534.425339',
  })
  expect(parsePermalink('https://example.com/')).toBe(undefined)
})

test('ts は倍精度で潰れる桁まで比べる', async () => {
  expect(tsAfter('1794214480.861520', '1794214480.861519')).toBe(true)
  expect(tsAfter('1794214480.861519', '1794214480.861519')).toBe(false)
  expect(tsAfter('999999999.999999', '1000000000.000000')).toBe(false)
})

test('親メッセージの本文を取り出し、Slack の記法と改行をほどいて 1 行にする', async () => {
  const text = `=== THREAD PARENT MESSAGE ===\nFrom: a (${OTHER})\nMessage TS: 1.000001\n${PARENT}\nReactions: eyes (1)\n\n=== THREAD REPLIES (0 total) ===\n`
  expect(oneLine(parseParentText(text) ?? '')).toBe(TITLE)
  expect(oneLine('詳細は <https://example.com|こちら> と <https://example.com/b>')).toBe(
    '詳細は こちら と https://example.com/b',
  )
  expect(parseParentText('親のない出力')).toBe(undefined)
})

test('返信から投稿者の ID と表示名を分けて取り出す', async () => {
  expect(parseReplies(reply('1.000001', OWNER, 'mitsuhashi', '本文'))).toEqual([
    { ts: '1.000001', userId: OWNER, name: 'mitsuhashi', text: '本文' },
  ])
  expect(parseUserId(`User ID: ${OWNER}\nUsername: m`)).toBe(OWNER)
})

test('MCP ツール名から Slack コネクタのサーバー名を取り出す', async () => {
  expect(findSlackServer(['mcp__gmail__send', 'mcp__abc-123__slack_read_thread'])).toBe('abc-123')
  // サーバー名に区切りと同じ `__` が入っていても、末尾のツール名で切る。
  expect(findSlackServer(['mcp__plugin__slack__slack_read_thread'])).toBe('plugin__slack')
  expect(findSlackServer(['mcp__abc__slack_send_message', 'Bash'])).toBe(undefined)
})

test('コネクタをつなぎ直してサーバー名が変わっても、新しい名前で読みにいく', async ($, on) => {
  const { world, checkNow } = await setUp($, on, [])
  const RECONNECTED = '99999999-8888-7777-6666-555555555555'
  const called: string[] = []
  on('mcp.call', (_, e) => {
    called.push(e.server)
    return { value: thread(world.replies) }
  })

  world.mcpTools = [`mcp__${RECONNECTED}__slack_read_thread`]
  world.replies = [reply('1794214600.000001', OWNER, 'mitsuhashi', 'つなぎ直したあとの依頼')]
  await checkNow()

  expect(called).toEqual([RECONNECTED])
  expect(world.submitted[0]).toContain('つなぎ直したあとの依頼')
})

test('Slack コネクタがつながっていなければ、紐付けずに理由を返す', async ($, on) => {
  const { world, run } = await setUp($, on, [])
  await run('off')

  world.mcpTools = ['mcp__other__search']

  expect((await run(URL)).text).toBe(
    '失敗しました: Slack コネクタが見つかりませんでした。接続されているか確かめてください',
  )
  expect((await run('')).text).toBe('紐付けている Slack スレッドはありません。')
})

test('他の人の返信だけでは渡さず、本人が書いたら溜まった分ごと時系列で渡す', async ($, on) => {
  const { world, clock } = await setUp($, on, [reply('1794214469.303829', OTHER, '奥村', '既存の返信')])

  world.replies = [...world.replies, reply('1794214500.000001', OTHER, '奥村', '他の人の一件目')]
  await clock.advance(60_000)
  expect(world.submitted.length).toBe(0)

  world.replies = [
    ...world.replies,
    reply('1794214510.000001', OWNER, 'mitsuhashi', '本人の依頼'),
    reply('1794214520.000001', OTHER, '塩原', '他の人の二件目'),
  ]
  await clock.advance(60_000)

  expect(world.submitted.length).toBe(1)
  const prompt = world.submitted[0] ?? ''
  expect(prompt).not.toContain('既存の返信')
  expect(prompt).toContain('[【本人】mitsuhashi]')
  expect(prompt).toContain('[奥村]')
  expect(prompt.indexOf('他の人の一件目')).toBeLessThan(prompt.indexOf('本人の依頼'))
  expect(prompt.indexOf('本人の依頼')).toBeLessThan(prompt.indexOf('他の人の二件目'))

  // 渡した返信は二度渡さない。
  await clock.advance(60_000)
  expect(world.submitted.length).toBe(1)
})

test('セッション自身の投稿は本人の発言でも拾わない', async ($, on) => {
  const { world, clock } = await setUp($, on, [])

  world.replies = [reply('1794214480.861519', OWNER, 'mitsuhashi', 'セッションからの投稿')]
  await $.tool.call({
    tool: `mcp__${SERVER}__slack_send_message`,
    channel_id: 'C07QD6X30Q2',
    thread_ts: '1793849534.425339',
    message: 'セッションからの投稿',
  })
  await clock.advance(60_000)

  expect(world.submitted.length).toBe(0)
})

test('submit に失敗した返信は、次の確認でもう一度渡す', async ($, on) => {
  const { world, checkNow } = await setUp($, on, [])

  world.replies = [reply('1794214600.000001', OWNER, 'mitsuhashi', '依頼')]
  world.isSubmitFailing = true
  await checkNow()
  expect(world.submitted.length).toBe(0)

  world.isSubmitFailing = false
  await checkNow()
  expect(world.submitted.length).toBe(1)
  expect(world.submitted[0]).toContain('依頼')
})

test('紐付け中は入力欄の上の帯にスレッドへのリンクが出て、外すと消える', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const { run } = await setUp($, on, [])
  const mountOn = (surface: 'terminal' | 'desktop', hasSurvey = false) =>
    $.ui.mount({
      plugin: 'slack-thread-link',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey, isWorking: false, maxRows: 6, bodyColumns: 80, scroll: { offset: 0, bodyRows: 6 }, view: {} },
    })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await mountOn(surface)
    const thread = await ui.find({ type: 'Link' })
    expect(thread?.props?.href).toBe(URL)
    // 親メッセージの冒頭を 1 行で、はみ出す分は末尾を省略して出す。
    const title = await ui.find({ type: 'Text', text: /お疲れ様です/ })
    expect(title?.text).toBe(TITLE)
    expect(title?.props?.wrap).toBe('truncate-end')
    await ui.unmount()
  }

  // アンケートが帯を使っているときは譲る。
  const survey = await mountOn('desktop', true)
  expect(await survey.find({ type: 'Link' })).toBe(undefined)
  await survey.unmount()

  await run('off')
  const ui = await mountOn('desktop')
  expect(await ui.find({ type: 'Link' })).toBe(undefined)
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('紐付けを外したら、本人の新着があっても渡さない', async ($, on) => {
  const { world, clock, run } = await setUp($, on, [])

  await run('off')
  world.replies = [reply('1794214500.000001', OWNER, 'mitsuhashi', '新着')]
  await clock.advance(60_000)

  expect(world.submitted.length).toBe(0)
  expect((await run('')).text).toBe('紐付けている Slack スレッドはありません。')
})

test('入力したメッセージにパーマリンクがあれば紐付け、その後の本人の投稿を渡す', async ($, on) => {
  const { world, clock, run } = await setUp($, on, [])
  await run('off')
  const OTHER_URL = 'https://x.slack.com/archives/C99/p1795000000000001?thread_ts=1794999999.000001&cid=C99'
  const type = (text: string) => $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false })

  // 紐付いていなければ、貼ったスレッドに紐付く。返信の URL なら親スレッドに。
  await type(`このスレッド見て ${OTHER_URL} よろしく`)
  expect((await run('')).text).toBe(`紐付け中: ${OTHER_URL}\n冒頭: ${TITLE}`)
  expect(world.toasts).toContain('このメッセージの Slack スレッドに紐付けました。')

  // 紐付け中は、別の URL を貼っても切り替えない。
  await type(`参考: ${URL}`)
  expect((await run('')).text).toContain(`紐付け中: ${OTHER_URL}\n`)

  // 紐付けたあとの本人の投稿は渡される。
  world.replies = [reply('1795000100.000001', OWNER, 'mitsuhashi', 'あとからの依頼')]
  await clock.advance(60_000)
  expect(world.submitted.some(text => text.includes('あとからの依頼'))).toBe(true)
})
