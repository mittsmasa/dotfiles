import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SlackLink } from '../types'
import {
  SEND_TOOL_PATTERN,
  findPermalink,
  findSlackServer,
  formatPrompt,
  messagesText,
  oneLine,
  parseParentText,
  parsePermalink,
  parseReplies,
  parseUserId,
  tsAfter,
} from './slack'
import type { Reply } from './slack'

// この環境の Slack コネクタ（ツール名 mcp__<server>__slack_* の <server> 部分）。
const SLACK_SERVER = 'e2035da9-9be2-4b7c-8dc1-74f495a22577'
const SEND_TOOL = `mcp__${SLACK_SERVER}__slack_send_message`
const POLL_MS = 60_000
const SELF_TS_LIMIT = 50

const link = atom({ plugin: 'slack-thread-link', key: 'link' } as const, null as SlackLink | null, {
  shape: 'link-1',
})

type $ = EngineInterface

async function fetchThread($: $, l: SlackLink): Promise<{ title?: string; replies: Reply[] }> {
  const result = await $.mcp.call(SLACK_SERVER, 'slack_read_thread', {
    channel_id: l.channel,
    message_ts: l.threadTs,
    oldest: l.lastTs,
    // 所有者が書くまで他の人の返信は既読にしないので、溜まる分を見込んで多めに取る。
    limit: 200,
  })
  const text = messagesText(result.content as { type: string; text?: string }[])
  if (result.isError) throw new Error(text.slice(0, 200))
  const parent = parseParentText(text)

  return { title: parent === undefined ? undefined : oneLine(parent), replies: parseReplies(text) }
}

async function fetchOwnerId($: $): Promise<string> {
  const result = await $.mcp.call(SLACK_SERVER, 'slack_read_user_profile', {})
  const text = messagesText(result.content as { type: string; text?: string }[])
  const id = result.isError ? undefined : parseUserId(text)
  if (!id) throw new Error('ログイン中の Slack ユーザーがわかりませんでした')

  return id
}

/** 紐付け中であることとリンクは入力欄の上の帯に出すので、ステータス行はお知らせだけにする。 */
function showStatus($: $, l: SlackLink | null, note?: string) {
  void $.ui.status(l && note ? `Slack: ${note}` : undefined)
}

let isPolling = false

/**
 * 所有者の新しい発言があれば、それまでに溜まった他の人の返信ごとセッションに渡す。
 * command.run の中からは submit できないので、タイマーから呼ぶ。
 */
async function poll($: $): Promise<void> {
  if (isPolling) return
  isPolling = true
  try {
    const l = await read($, link)
    if (!l) return
    const ownerId = l.ownerId ?? (await fetchOwnerId($))
    const { title, replies } = await fetchThread($, l)
    // 古い紐付けに足りない値はここで補う。
    if (!l.ownerId || (title !== undefined && title !== l.title)) {
      await update($, link, cur => (cur && cur.threadTs === l.threadTs ? { ...cur, ownerId, title: title ?? cur.title } : cur))
    }
    const fresh = replies.filter(
      r => tsAfter(r.ts, l.lastTs) && !l.selfTs.includes(r.ts),
    )
    const newest = fresh.at(-1)?.ts
    if (newest && fresh.some(r => r.userId === ownerId)) {
      // submit はターンが始まるまで resolve しない。その間 isPolling が次の重複を止める。
      // 既読位置は渡せてから進め、失敗したら次のポーリングでもう一度渡す。
      await $.prompt.submit({ text: formatPrompt(l.url, fresh, ownerId) })
      await update($, link, cur =>
        cur && cur.threadTs === l.threadTs && tsAfter(newest, cur.lastTs)
          ? { ...cur, lastTs: newest }
          : cur,
      )
      showStatus($, l)
    } else {
      showStatus($, l, fresh.length > 0 ? `他の人の返信 ${fresh.length} 件を保留中` : undefined)
    }
  } catch (err) {
    showStatus($, await read($, link), `失敗: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    isPolling = false
  }
}

async function linkThread($: $, url: string): Promise<string> {
  const ref = parsePermalink(url)
  if (!ref) return 'Slack のパーマリンクを渡してください（例: https://xxx.slack.com/archives/C.../p...）。'
  // 紐付けた時点までの返信は既読にする。
  const ownerId = await fetchOwnerId($)
  const draft: SlackLink = { url, ...ref, ownerId, lastTs: ref.threadTs, selfTs: [] }
  const { title, replies } = await fetchThread($, draft)
  const next: SlackLink = { ...draft, title, lastTs: replies.at(-1)?.ts ?? ref.threadTs }
  await update($, link, () => next)
  showStatus($, next)

  return `このセッションを Slack スレッドに紐付けました。${POLL_MS / 1000} 秒ごとに確かめ、あなたの発言があったら、他の人の返信も文脈として一緒に渡します。`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'slack-link',
      description: 'Slack スレッドを紐付ける（<URL> / off / now / 引数なしで状態表示）',
    })
    showStatus($, await read($, link))
    // 読み込み直後にも一度確かめ、冒頭などの表示をすぐ埋める。
    $.clock.after(0, () => {
      void poll($)
    })
    $.clock.every(POLL_MS, () => {
      void poll($)
    })

    return next(e)
  })

  // 入力したメッセージに Slack のパーマリンクがあり、まだ何も紐付いていなければ、そのスレッドに紐付ける。
  // 紐付け中なら切り替えない（参考に貼っただけの URL で切り替わらないように）。
  on('prompt.submit', async ($, e, next) => {
    const url = e.origin.kind === 'composer' && !e.command ? findPermalink(e.text) : undefined
    if (url && !(await read($, link))) {
      try {
        await linkThread($, url)
        void $.ui.toast('このメッセージの Slack スレッドに紐付けました。')
      } catch (err) {
        void $.ui.toast(`Slack スレッドに紐付けられませんでした: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    return next(e)
  })

  on('command.run', { command: 'slack-link' }, async ($, e) => {
    const arg = e.args.trim()
    try {
      if (arg === '') {
        const l = await read($, link)
        if (!l) return { text: '紐付けている Slack スレッドはありません。' }
        return { text: `紐付け中: ${l.url}\n冒頭: ${l.title ?? '（まだ取得していません）'}` }
      }
      if (arg === 'off') {
        await update($, link, () => null)
        showStatus($, null)
        return { text: 'Slack スレッドとの紐付けを外しました。' }
      }
      if (arg === 'now') {
        if (!(await read($, link))) return { text: '紐付けている Slack スレッドはありません。' }
        $.clock.after(0, () => {
          void poll($)
        })
        return { text: '新しい返信を確かめます。あれば次のターンで渡します。' }
      }

      return { text: await linkThread($, arg) }
    } catch (err) {
      return { text: `失敗しました: ${err instanceof Error ? err.message : String(err)}` }
    }
  })

  // 入力欄のすぐ上の帯に、紐付け中のスレッドへのリンクを出す。
  // 入力欄下のモード表示は押せる領域ではなかったので、クリックを受ける帯に置く。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const l = await read($, link)
    if (!l || e.props.hasSurvey) return next(e)
    const { Box, Link, Text } = $.ui.resolve(e)

    // 冒頭は残りの幅に 1 行で収め、はみ出す分は末尾を省略する。リンクは右端に寄せる。
    return (
      <Box flexDirection="row" width="100%" gap={1}>
        <Box flexShrink={0}>
          <Text dimColor>Slack 連携中 ·</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">{l.title ?? ''}</Text>
        </Box>
        <Box flexShrink={0}>
          <Link key="thread" href={l.url} label="スレッドを開く" />
        </Box>
      </Box>
    )
  })

  // このセッションが紐付け先に投稿したら、その返信を既読扱いにして自分で拾わないようにする。
  on('tool.call', { tool: SEND_TOOL }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const l = await read($, link)
      const input = e as unknown as { channel_id?: string; thread_ts?: string }
      if (!l || input.channel_id !== l.channel || input.thread_ts !== l.threadTs) return ran
      const own = (await fetchThread($, l)).replies.at(-1)?.ts
      if (own) {
        await update($, link, cur =>
          cur && cur.threadTs === l.threadTs
            ? { ...cur, selfTs: [...cur.selfTs, own].slice(-SELF_TS_LIMIT) }
            : cur,
        )
      }
    } catch {
      // 既読の記録に失敗しても投稿そのものは成功しているので、結果はそのまま返す。
    }

    return ran
  })
}
