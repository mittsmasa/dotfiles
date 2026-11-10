export type SlackLink = {
  url: string
  channel: string
  threadTs: string
  /** 紐付けた Slack アカウントの所有者。この人の発言でターンを始める。古い紐付けにはない。 */
  ownerId?: string
  /** セッションに渡し終えた、いちばん新しい返信の ts。 */
  lastTs: string
  /** このセッション自身が投稿した返信の ts。ポーリングで拾わない。 */
  selfTs: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'slack-thread-link': { link: Shaped<SlackLink | null> }
  }
}
