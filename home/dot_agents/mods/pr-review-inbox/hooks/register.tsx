import { atom, read } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { Finding, Inbox, PastThread, Review, ReviewPayload } from '../types'
import { DIFF_PAGE_ROWS, pageCountOf, rowsOf, safeText, shownRows } from './diff'
import type { DiffRow } from './diff'
import { DEFAULT_APPROVE_COMMENT, actionsOf } from './posting'
import {
  SEVERITY_TONE,
  bandText,
  bandTone,
  clockText,
  countsText,
  deepDivePrompt,
  historyText,
  isDue,
  isGithubUrl,
  linesText,
  rowLabel,
  shortName,
  splitPlace,
  threadTags,
  threadTone,
  threadsHeading,
  toneOf,
  windowText,
} from './reviews'
import {
  activate,
  addComment,
  adoptAll,
  approveWith,
  closeDiffView,
  deepDiveContext,
  fetchNow,
  isToolCallAllowed,
  makeConfig,
  markRead,
  onTurnComplete,
  openConfirm,
  openDiffFile,
  openDiffView,
  openFinding,
  requeue,
  retry,
  saveEdit,
  select,
  send,
  setApproveComment,
  setMode,
  startLineComment,
  toggle,
  toggleBody,
  toggleWhitespace,
  turnDiffPage,
} from './run'
import type { Config } from './run'

// The same atom run.ts writes: the validator reads an atom's reference only
// in the file that uses it, so each side declares it.
const inboxAtom = atom(
  { plugin: 'pr-review-inbox', key: 'inbox' } as const,
  { reviews: [], isFetching: false, withDiff: [] } as Inbox,
  { shape: 'inbox-2' },
)

// Whether this session runs the inbox; run.ts writes it.
const activeAtom = atom({ plugin: 'pr-review-inbox', key: 'isActive' } as const, false)

const PANE = 'review-inbox'
const TITLE = 'PR レビュー'
// The left edge of a row: its colour alone says how heavy the row is.
const EDGE = '▍'
// A description longer than this many lines is folded until asked for.
const BODY_SHOWN_LINES = 3
// The line number's column on the diff screen, in cells.
const LINE_NUMBER_WIDTH = 6
// A row's tint: the theme's own diff colours hide the text on the desktop app,
// so the tint is a thin wash the text of either theme reads through.
const TINT = { add: '#2ea04326', remove: '#f8514926' } as const
const SEVERITIES = ['blocker', 'recommended', 'suggestion'] as const
// A text cut to a few lines' worth, with the mark of what was left out.
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)
// Leading spaces drawn as no-break spaces: a surface that folds spaces keeps the indent.
const indented = (text: string) => text.replace(/^ +/, spaces => '\u00a0'.repeat(spaces.length))

/**
 * Puts the deep-dive request in the prompt box: the pull request, and where
 * the pre-read left its checkout and its result, for the session it asks for.
 * A surface that draws its own composer (the desktop app) refuses the fill, so
 * the request goes to the clipboard instead, and failing that it is shown to
 * be copied by hand.
 */
async function deepDive($: EngineInterface, config: Config, review: Review, surface: RenderSurface) {
  const text = deepDivePrompt(review.url, await deepDiveContext($, config, review.key))
  if ((await $.prompt.fill({ text, mode: 'replace' })).isFilled) return
  const copied = await $.ui.copy({ text, surface })
  $.ui.toast(
    copied.isCopied
      ? '深掘りの依頼文をコピーしました。入力欄に貼って送ってください'
      : `入力欄に入れられませんでした。次の文を送ってください: ${text}`,
    { timeoutMs: 10_000 },
  )
}

export const register: Register = (on, options) => {
  let config: Config | undefined

  // A session that only loaded the mod does nothing: no timer, no pane, no gh.
  // The inbox runs in the session where /review-inbox was typed.
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'review-inbox',
      description: 'このセッションで PR レビュー受付を始めて、ペインを開く',
    })
    const ready = await makeConfig($, options)
    config = ready
    // A reload: this session was running the inbox, so it picks it up again.
    if (await read($, activeAtom)) {
      await activate($, ready, 'session.start')
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return next(e)
  })

  on('command.run', { command: 'review-inbox' }, async $ => {
    // Read again: the config file may have been written since the session started.
    const ready = await makeConfig($, options)
    config = ready
    await activate($, ready, 'command')
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'このセッションで PR レビュー受付を始めました。' }
  })

  // The reviewer is this mod's to spawn, never the model's.
  on('agent.offer', { agent: 'pr-review-inbox:reviewer' }, () => ({ isOffered: false }))

  // Guards every subagent's tool calls; the main loop passes untouched.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const isAllowed = await isToolCallAllowed($, config, { tool: e.tool, agentId: e.agentId, args: e })

    return isAllowed
      ? next(e)
      : { deny: 'pr-review-inbox: この PR レビュー受付セッションでは、subagent が使えるのは下読み用の読み取りと結果の書き込みだけです。' }
  }).catch(($, e, next) =>
    e.agentId === undefined || next.called
      ? next(e)
      : { deny: 'pr-review-inbox: ツール呼び出しの確認に失敗しました。' },
  )

  on('turn.complete', async ($, e, next) => {
    const { agentId, answer } = e as { agentId?: string; answer?: unknown }
    if (agentId !== undefined && config) {
      await onTurnComplete($, config, agentId, typeof answer === 'string' ? answer : undefined)
    }

    return next(e)
  })

  // The band: says what waits, and a press opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!(await read($, activeAtom))) return next(e)
    const { reviews } = await read($, inboxAtom)
    const text = e.props.hasSurvey ? undefined : bandText(reviews)
    if (text === undefined) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" gap="sm">
        <Text color={bandTone(reviews)}>{EDGE}</Text>
        <Button
          key="open-pane"
          plain
          onPress={() => void $.ui.open({ id: PANE, title: TITLE, focus: true })}
        >
          {text} · <Text dimColor>開く</Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Input, Markdown, Code } = $.ui.resolve(e)
    const state = await read($, inboxAtom)
    const ready = config
    if (!ready || !(await read($, activeAtom))) {
      return (
        <Box flexDirection="column">
          <Text dimColor>このセッションは PR レビュー受付をしていません。/review-inbox で始めます。</Text>
        </Box>
      )
    }
    const offset = ready.utcOffsetMinutes
    const visible = state.reviews.filter(review => !review.isRead)
    const selected = visible.find(review => review.key === state.selectedKey)
    const mode = selected ? state.mode : undefined
    // The request being confirmed or sent, if any: the detail stays as it is around it.
    const pending = mode?.kind === 'confirm' || mode?.kind === 'sending' ? mode : undefined
    const isOpen = isDue(new Date(await $.clock.now()), offset, ready.schedule)

    // The left edge of a block: one cell wide, as tall as what stands beside it.
    const bar = (color: string) => <Box width={1} flexShrink={0} backgroundColor={color} />

    const heading = (text: string) => (
      <Box marginTop="md">
        <Text size="caption" dimColor>
          {text}
        </Text>
      </Box>
    )

    // ---- the confirm block: stands where the send controls were, so nothing above it moves ----
    // Which finding goes where is on each finding's own row (`placement`); here, the request as a whole.
    const confirm = (review: Review, payload: ReviewPayload, isSending: boolean, error?: string) => {
      const name = shortName(review.key, ready.sources)

      return (
        <Box
          key="confirm"
          flexDirection="column"
          borderStyle="round"
          borderColor="suggestion"
          paddingX="sm"
          marginTop="md"
        >
          <Text weight="medium">送信の確認</Text>
          <Text>
            <Text mono>{name.number}</Text> {name.repo} に{payload.event === 'APPROVE' ? '承認' : 'コメント'}
            として送ります。
          </Text>
          <Text size="caption" dimColor>
            インライン {payload.comments.length} 件 · {payload.body === undefined ? '本文なし' : '本文あり'}
          </Text>
          {payload.body !== undefined && (
            <Box flexDirection="column" marginTop="xs">
              <Text size="caption" dimColor>
                本文
              </Text>
              <Text>{payload.body}</Text>
            </Box>
          )}
          {error !== undefined && (
            <Box marginTop="xs">
              <Text color="error">送信できませんでした: {error}</Text>
            </Box>
          )}
          {isSending ? (
            <Box marginTop="xs">
              <Text dimColor>送信しています…</Text>
            </Box>
          ) : (
            <Box flexDirection="row" gap="md" marginTop="xs" alignItems="center">
              <Button key="send" variant="primary" label="送信する" onPress={() => void send($, ready, review.key)} />
              <Button key="back" variant="secondary" label="戻る" onPress={() => void setMode($, undefined)} />
            </Box>
          )}
        </Box>
      )
    }

    // Where a finding of the pending request goes. A request kept from before
    // placements existed has none: no tag is better than a wrong one.
    const PLACED = { inline: '行に付く', body: '本文へ' } as const
    const placedTag = (id: string) => {
      const placement = pending?.placement
      if (!placement) return undefined
      const place = Object.hasOwn(placement, id) ? placement[id] : undefined

      return place ? PLACED[place] : '外した'
    }

    // ---- one finding: a line when closed; its text and controls when open ----
    const finding = (review: Review, one: Finding, isEditable: boolean) => {
      const place = splitPlace(one.file, one.line)
      const isShown = state.openFindingId === one.id
      const isEditing = isEditable && mode?.kind === 'edit' && mode.id === one.id
      const placed = placedTag(one.id)
      // While a request is pending the row says where the finding goes, in place of what it is.
      // The edge's colour already tells the severity; only a blocker is also written.
      const tags =
        placed !== undefined
          ? [placed]
          : [
              one.source !== 'human' && one.severity === 'blocker' ? one.severity : undefined,
              one.isUnsure ? '要確認' : undefined,
              one.side === 'LEFT' ? '削除行' : undefined,
              one.source === 'human' ? '自分' : undefined,
              one.isAdopted ? undefined : '外した',
            ].filter(Boolean)
      const hunk = isShown && state.openDiff?.id === one.id ? state.openDiff.source : undefined
      // The criterion's id is the reviewer's reference: drawn only once the finding is open.
      const where = [place.dir, one.criteriaId].filter(Boolean).join(' · ')

      return (
        <Box flexDirection="row" gap="sm" marginTop="sm">
          {bar(one.isAdopted ? SEVERITY_TONE[one.severity] : 'inactive')}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Button key={`open:${one.id}`} plain onPress={() => void openFinding($, ready, one.id)}>
                <Text mono weight="medium" strikethrough={!one.isAdopted} dimColor={!one.isAdopted}>
                  {place.name || '場所なし'}
                </Text>
              </Button>
              <Text size="caption" dimColor>
                {tags.join(' · ')}
              </Text>
            </Box>
            <Text dimColor={!one.isAdopted}>{one.reason}</Text>
            {isShown && where !== '' && (
              <Text mono size="caption" dimColor>
                {where}
              </Text>
            )}
            {isShown && one.isAdopted && !isEditing && (
              <Box borderStyle="single" borderDimColor paddingX="sm" marginTop="xs">
                <Text>{one.comment}</Text>
              </Box>
            )}
            {hunk !== undefined && (
              <Box marginTop="xs">
                <Code format="diff" source={hunk} {...(one.file === undefined ? {} : { path: one.file })} />
              </Box>
            )}
            {isShown && isEditing && (
              <Box flexDirection="column" gap="xs" marginTop="xs">
                <Input
                  key={`edit-text:${one.id}`}
                  label="PR に書く文面"
                  value={one.comment}
                  rows={4}
                  submitLabel="保存"
                  autoFocus
                  onSubmit={value => void saveEdit($, review.key, one.id, value)}
                />
                <Box flexDirection="row">
                  <Button
                    key={`edit-cancel:${one.id}`}
                    variant="secondary"
                    label="やめる"
                    onPress={() => void setMode($, undefined)}
                  />
                </Box>
              </Box>
            )}
            {isShown && isEditable && !isEditing && (
              <Box flexDirection="row" gap="md" marginTop="xs">
                {one.isAdopted && (
                  <Button
                    key={`edit:${one.id}`}
                    variant="secondary"
                    label="編集"
                    onPress={() => void setMode($, { kind: 'edit', id: one.id })}
                  />
                )}
                <Button
                  key={`toggle:${one.id}`}
                  variant="secondary"
                  label={one.isAdopted ? '外す' : '戻す'}
                  onPress={() => void toggle($, review.key, one.id)}
                />
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    // The number, the repository, who opened it, and its size: the first line of both screens.
    const headline = (review: Review) => {
      const name = shortName(review.key, ready.sources)

      return (
        <Text>
          <Text mono weight="bold">
            {name.number}
          </Text>{' '}
          <Text size="caption" dimColor>
            {[name.repo, review.author && `@${review.author}`, linesText(review.lines)].filter(Boolean).join(' · ')}
          </Text>
        </Text>
      )
    }

    // ---- the diff screen: the files, one of them open, findings under their lines ----
    // The diff is the pull request's: every part of it is drawn as Text, through safeText.
    const diffScreen = (review: Review, view: NonNullable<Inbox['diffView']>) => {
      const isSendable = review.status === 'done' && review.postedAt === undefined
      // Lines take a comment only while the detail's findings could be changed too.
      const canComment = isSendable && pending === undefined
      const open = view.open
      const showsWhitespace = view.showsWhitespace === true
      // Folded by default: a line that only moved its indent reads as unchanged.
      const all = open ? shownRows(open.source, showsWhitespace) : []
      // Whether the fold hides anything of this file: only then is there something to switch.
      const isFolding = open !== undefined && !showsWhitespace && rowsOf(open.source).length !== all.length
      const pageCount = pageCountOf(all.length)
      const page = Math.min(open?.page ?? 0, pageCount - 1)
      // Only this stretch is drawn: a surface does not draw the tree of a long file whole.
      const rows = all.slice(page * DIFF_PAGE_ROWS, (page + 1) * DIFF_PAGE_ROWS)
      const shown = new Set(rows.flatMap(row => (row.kind === 'add' || row.kind === 'context' ? [row.newLine] : [])))
      const shownLeft = new Set(rows.flatMap(row => (row.kind === 'remove' ? [row.oldLine] : [])))
      const at = mode?.kind === 'add' ? mode.at : undefined
      // A finding on a removed line is placed by the old file's numbers; any other by the new one's.
      const isLeft = (one: Finding) => one.side === 'LEFT'
      const sits = (one: Finding, row: DiffRow) =>
        isLeft(one)
          ? row.kind === 'remove' && row.oldLine === one.line
          : (row.kind === 'add' || row.kind === 'context') && row.newLine === one.line
      const isOnPage = (one: Finding) => one.line !== undefined && (isLeft(one) ? shownLeft : shown).has(one.line)
      // The page of the open file a finding's line is on, when it is on one.
      const pageOf = (one: Finding) => {
        const index = all.findIndex(row => sits(one, row))

        return index < 0 ? undefined : Math.floor(index / DIFF_PAGE_ROWS)
      }

      // A finding where it sits: read here, changed in the detail.
      const note = (one: Finding) => {
        const tags = [
          // Off the rows drawn, the line is all that says where it belongs.
          one.line !== undefined && !isOnPage(one) ? `L${isLeft(one) ? '-' : ''}${one.line}` : undefined,
          one.source === 'human' ? '自分' : '下読み',
          one.source === 'human' ? undefined : one.severity,
          one.isUnsure ? '要確認' : undefined,
          one.isAdopted ? undefined : '外した',
        ].filter(Boolean)
        const target = pageOf(one)

        return (
          <Box key={`note:${one.id}`} flexDirection="row" gap="sm" marginY="xs" marginLeft="md">
            {bar(one.isAdopted ? SEVERITY_TONE[one.severity] : 'inactive')}
            <Box flexDirection="column" flexGrow={1}>
              <Text size="caption" dimColor>
                {tags.join(' · ')}
              </Text>
              <Text strikethrough={!one.isAdopted} dimColor={!one.isAdopted}>
                {one.source === 'human' ? one.comment : one.reason}
              </Text>
              {one.source !== 'human' && one.isAdopted && (
                <Box borderStyle="single" borderDimColor paddingX="sm" marginTop="xs">
                  <Text>{one.comment}</Text>
                </Box>
              )}
              {!isOnPage(one) && target !== undefined && (
                <Box flexDirection="row" marginTop="xs">
                  <Button
                    key={`goto:${one.id}`}
                    variant="secondary"
                    label="この行へ"
                    onPress={() => void turnDiffPage($, target - page)}
                  />
                </Box>
              )}
            </Box>
          </Box>
        )
      }

      const line = (path: string, row: DiffRow, index: number) => {
        if (row.kind === 'hunk') {
          return (
            <Box key={`hunk:${index}`} marginTop="xs">
              <Text mono size="caption" dimColor>
                {safeText(row.text)}
              </Text>
            </Box>
          )
        }
        const newLine = row.kind === 'remove' ? undefined : row.newLine
        // The number a comment on this row goes by: the old file's on a removed row.
        const number = row.kind === 'remove' ? row.oldLine : row.newLine
        const side = row.kind === 'remove' ? ('LEFT' as const) : undefined
        const mark = row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : '\u00a0'
        const text = `${mark} ${indented(safeText(row.text))}`
        const tint = row.kind === 'context' ? undefined : TINT[row.kind]
        const isWriting = at !== undefined && at.file === path && at.line === number && at.side === side

        // As few elements a row as will do: a file has hundreds of rows. The number is the
        // Button, so the code is one mono Text on every row: a Button draws its label in its own face.
        return [
          <Box key={`line-box:${index}`} flexDirection="row" gap="sm" {...(tint ? { backgroundColor: tint } : {})}>
            <Box width={LINE_NUMBER_WIDTH} flexShrink={0}>
              {/* A removed row is named apart: its number may be a new line's too. */}
              {canComment ? (
                <Button
                  key={side ? `line:L${number}` : `line:${number}`}
                  plain
                  dimColor
                  label={String(number)}
                  onPress={() => void startLineComment($, path, number, side)}
                />
              ) : (
                <Text mono size="caption" dimColor>
                  {String(number)}
                </Text>
              )}
            </Box>
            <Text mono size="caption">
              {text}
            </Text>
          </Box>,
          ...review.findings.filter(one => one.file === path && sits(one, row)).map(note),
          isWriting && mode?.kind === 'add' && (
            <Box key="line-comment-box" flexDirection="column" gap="xs" marginY="xs" marginLeft="md">
              <Input
                key="line-comment"
                label={side ? `${number} 行目（削除行）へのコメント` : `${number} 行目へのコメント`}
                rows={3}
                submitLabel="追加"
                autoFocus
                onSubmit={value => void addComment($, review.key, value)}
              />
              {mode.error !== undefined && <Text color="error">{mode.error}</Text>}
              <Box flexDirection="row">
                <Button
                  key="line-comment-cancel"
                  variant="secondary"
                  label="やめる"
                  onPress={() => void setMode($, undefined)}
                />
              </Box>
            </Box>
          ),
        ]
      }

      // The open file's pages: which rows are drawn, and the way to the next and the last ones.
      const pager = (at: 'top' | 'bottom') =>
        pageCount > 1 && (
          <Box key={`pager:${at}`} flexDirection="row" gap="sm" alignItems="center" marginTop="xs">
            {page > 0 && (
              <Button key={`page-prev:${at}`} variant="secondary" label="前へ" onPress={() => void turnDiffPage($, -1)} />
            )}
            <Text size="caption" dimColor>
              {`${page * DIFF_PAGE_ROWS + 1}–${Math.min(all.length, (page + 1) * DIFF_PAGE_ROWS)} 行目 / ${all.length} 行`}
            </Text>
            {page < pageCount - 1 && (
              <Button key={`page-next:${at}`} variant="secondary" label="次へ" onPress={() => void turnDiffPage($, 1)} />
            )}
          </Box>
        )

      // A file's Button is named by its place in the list: a surface cuts a key as long as a path,
      // and a press on the cut key reaches no Button.
      const file = (one: { path: string; added: number; removed: number }, index: number) => {
        const place = splitPlace(one.path, undefined)
        const inFile = review.findings.filter(finding => finding.file === one.path)
        const heaviest = SEVERITIES.find(severity => inFile.some(finding => finding.isAdopted && finding.severity === severity))
        const isShown = open?.path === one.path
        // Findings of this file with no line among the rows drawn: no line, off the diff, on another page.
        const loose = inFile.filter(finding => !isOnPage(finding))
        const counts = [`+${one.added} −${one.removed}`, inFile.length > 0 ? `指摘 ${inFile.length}` : undefined]

        return (
          <Box key={`file-box:${index}`} flexDirection="row" gap="sm" marginTop="sm">
            {bar(heaviest ? SEVERITY_TONE[heaviest] : 'inactive')}
            <Box flexDirection="column" flexGrow={1}>
              <Box flexDirection="row" justifyContent="space-between" gap="sm">
                <Button key={`file:${index}`} plain onPress={() => void openDiffFile($, ready, one.path)}>
                  <Text mono weight="medium">
                    {safeText(place.name)}
                  </Text>
                </Button>
                <Text size="caption" dimColor>
                  {counts.filter(Boolean).join(' · ')}
                </Text>
              </Box>
              {place.dir !== '' && (
                <Text mono size="caption" dimColor>
                  {safeText(place.dir)}
                </Text>
              )}
              {isShown && open.source === '' && <Text dimColor>表示できる差分がありません。</Text>}
              {isShown && open.source !== '' && all.length === 0 && <Text dimColor>空白だけの変更です。</Text>}
              {isShown && (isFolding || showsWhitespace) && (
                <Box flexDirection="row" marginTop="xs">
                  <Button
                    key="whitespace"
                    variant="secondary"
                    label={showsWhitespace ? '空白の変更を隠す' : '空白の変更も表示'}
                    onPress={() => void toggleWhitespace($)}
                  />
                </Box>
              )}
              {isShown && loose.length > 0 && (
                <Box marginTop="xs">
                  <Text size="caption" dimColor>
                    このページに無い指摘
                  </Text>
                </Box>
              )}
              {isShown && loose.map(note)}
              {isShown && pager('top')}
              {isShown && rows.map((row, index) => line(one.path, row, index))}
              {isShown && pager('bottom')}
              {isShown && open.isCut && (
                <Box flexDirection="row" gap="sm" marginTop="xs" flexWrap="wrap">
                  <Text dimColor>長いので途中までです。</Text>
                  {isGithubUrl(review.url) && <Link href={`${review.url}/files`} label="GitHub で続きを見る ↗" />}
                </Box>
              )}
            </Box>
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button key="back-to-detail" variant="secondary" label="← 詳細" onPress={() => void closeDiffView($)} />
          </Box>
          <Box flexDirection="column" marginTop="sm">
            {headline(review)}
            <Text>{review.title}</Text>
          </Box>
          {heading('ファイル')}
          {view.files.length === 0 && <Text dimColor>変更されたファイルがありません。</Text>}
          {view.files.map(file)}
        </Box>
      )
    }

    // ---- one thread I opened in an earlier review: what GitHub knows, and what the pre-read made of it ----
    // Its texts are the pull request's: drawn as plain text, cut short, never as markdown or a link.
    const pastThread = (review: Review, one: PastThread) => {
      const followup = review.followups?.find(each => each.id === one.id)
      const place = splitPlace(one.path, one.line ?? one.originalLine)
      const reply = one.replies[0]

      return (
        <Box key={`thread:${one.id}`} flexDirection="row" gap="sm" marginTop="sm">
          {bar(threadTone(one, followup))}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Text mono weight="medium">
                {place.name}
              </Text>
              <Text size="caption" dimColor>
                {threadTags(one, followup).join(' · ')}
              </Text>
            </Box>
            <Text>{clip(one.comment, 160)}</Text>
            {followup !== undefined && followup.note !== '' && <Text size="caption">下読み: {followup.note}</Text>}
            {reply !== undefined && (
              <Text size="caption" dimColor>
                返信: {clip(reply, 120)}
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    const detail = (review: Review) => {
      const actions = actionsOf(review, state.withDiff.includes(review.key))
      const isSendable = review.status === 'done' && review.postedAt === undefined
      // A pending request shows what was built: its findings are not changed under it.
      const isEditable = isSendable && pending === undefined
      const adopted = review.findings.filter(one => one.isAdopted).length
      const total = review.findings.length
      const skipped = review.status === 'done' ? review.skipped : []
      const bodyLines = (review.body ?? '').trim() === '' ? [] : (review.body as string).split('\n')
      const isBodyLong = bodyLines.length > BODY_SHOWN_LINES
      const isBodyFolded = !state.isBodyOpen && isBodyLong
      const tone = toneOf(review)
      // The verdict and the weight of what is still adopted: the line the whole detail hangs from.
      const counts = review.status === 'done' ? countsText(review.findings.filter(one => one.isAdopted)) : ''
      const verdict = [rowLabel(review, offset), counts].filter(Boolean).join(' · ')

      return (
        <Box flexDirection="column">
          <Box flexDirection="column" marginTop="sm">
            {headline(review)}
            <Text>{review.title}</Text>
            <Box flexDirection="row" gap="sm" alignItems="center" flexWrap="wrap" marginTop="xs">
              {isGithubUrl(review.url) && (
                <Button
                  key="deep-dive"
                  variant="secondary"
                  label="深掘りする"
                  onPress={press => void deepDive($, ready, review, press.surface)}
                />
              )}
              {state.withDiff.includes(review.key) && (
                <Button
                  key="diff-view"
                  variant="secondary"
                  label="差分を見る"
                  onPress={() => void openDiffView($, ready, review.key)}
                />
              )}
              <Button key="read" variant="secondary" label="片付ける" onPress={() => void markRead($, ready, review.key)} />
              {/* A link cannot be drawn as a button: it stays a link, last, with the mark of one that leaves. */}
              {isGithubUrl(review.url) && <Link href={review.url} label="GitHub で開く ↗" />}
            </Box>
            <Box key="verdict" flexDirection="row" gap="sm" marginTop="xs">
              {bar(tone)}
              <Text color={tone} weight="medium">
                {verdict}
              </Text>
            </Box>
          </Box>
          {review.history && (
            <Text key="history" size="caption" dimColor>
              {historyText(review.history, offset)}
            </Text>
          )}
          {heading('概要')}
          {bodyLines.length === 0 ? (
            <Text dimColor>本文なし</Text>
          ) : (
            <Markdown
              key="body"
              text={isBodyFolded ? bodyLines.slice(0, BODY_SHOWN_LINES).join('\n') : bodyLines.join('\n')}
            />
          )}
          {isBodyLong && (
            <Box flexDirection="row" marginTop="xs">
              <Button
                key="more-body"
                variant="secondary"
                label={isBodyFolded ? '続きを表示' : '折りたたむ'}
                onPress={() => void toggleBody($)}
              />
            </Box>
          )}
          {review.history && review.history.threads.length > 0 && heading(threadsHeading(review.history, review.followups ?? []))}
          {review.history?.threads.map(one => pastThread(review, one))}
          {review.history?.more !== undefined && (
            <Text size="caption" dimColor>
              ほか {review.history.more} 件
            </Text>
          )}
          {review.status === 'done' &&
            heading(
              total === 0 ? '指摘' : isSendable ? `指摘 · ${total} 件中 ${adopted} 件を送る` : `指摘 · ${total} 件`,
            )}
          {review.status === 'done' && total === 0 && (
            <Text dimColor>機械チェックと基準の範囲では指摘なし。</Text>
          )}
          {review.findings.map(one => finding(review, one, isEditable))}
          {isEditable && mode?.kind === 'add' && (
            <Box flexDirection="column" gap="xs" marginTop="sm">
              <Input
                key="add-place"
                label="場所"
                placeholder="src/foo.ts:12（省略可）"
                value={mode.place}
                onInput={value => void setMode($, { kind: 'add', place: value })}
                onSubmit={value => void setMode($, { kind: 'add', place: value })}
              />
              <Input
                key="add-body"
                label="本文"
                rows={3}
                submitLabel="追加"
                onSubmit={value => void addComment($, review.key, value)}
              />
              {mode.error !== undefined && <Text color="error">{mode.error}</Text>}
              <Box flexDirection="row">
                <Button key="add-cancel" variant="secondary" label="やめる" onPress={() => void setMode($, undefined)} />
              </Box>
            </Box>
          )}
          {isEditable && mode?.kind !== 'add' && (
            <Box flexDirection="row" gap="sm" marginTop="sm">
              <Button
                key="add"
                variant="secondary"
                label="+ コメントを追加"
                onPress={() => void setMode($, { kind: 'add', place: '' })}
              />
              {total > 0 && (
                <Button
                  key="adopt-all"
                  variant="secondary"
                  label={adopted > 0 ? 'すべて外す' : 'すべて戻す'}
                  onPress={() => void adoptAll($, review.key, adopted === 0)}
                />
              )}
            </Box>
          )}
          {isSendable && pending !== undefined && (
            // Holds the row the editing controls had, so what is below does not move.
            <Box marginTop="sm">
              <Text size="caption" dimColor>
                確認中は編集できません。直すときは「戻る」を押してください。
              </Text>
            </Box>
          )}
          {/* What the reviewer verified is kept on the review, not drawn: nobody read it here. */}
          {skipped.length > 0 && (
            <Box marginTop="md">
              <Text size="caption" dimColor>
                省いたもの: {skipped.join('、')}
              </Text>
            </Box>
          )}
          {pending !== undefined &&
            confirm(
              review,
              pending.payload,
              pending.kind === 'sending',
              pending.kind === 'confirm' ? pending.error : undefined,
            )}
          {pending === undefined && actions.includes('approve') && heading('PR コメント')}
          {pending === undefined && actions.includes('approve') && (
            <Box flexDirection="column" marginTop="xs">
              {/* The field's own submit is the approval: the comment goes with it, through the confirm. */}
              <Input
                key="approve"
                placeholder="承認に添える文面（空なら本文なし）"
                value={state.approveComment ?? DEFAULT_APPROVE_COMMENT}
                rows={2}
                submitLabel="承認して送る"
                onInput={value => void setApproveComment($, value)}
                onSubmit={value => void approveWith($, ready, review.key, value)}
              />
            </Box>
          )}
          {pending === undefined && (
            <Box flexDirection="row" gap="md" marginTop="sm" alignItems="center" flexWrap="wrap">
              {actions.includes('comment') && (
                <Button
                  key="comment"
                  variant="secondary"
                  label={`コメントで送る (${adopted})`}
                  onPress={() => void openConfirm($, ready, review.key, 'COMMENT')}
                />
              )}
              {actions.includes('rereview') && (
                <Button key="rereview" label="もう一度レビューする" onPress={() => void requeue($, ready, review.key)} />
              )}
              {review.status === 'failed' && (
                <Button key="retry" label="もう一度レビューする" onPress={() => void retry($, ready, review.key)} />
              )}
              {review.postedUrl !== undefined &&
                review.postedUrl.startsWith('https://github.com/') &&
                <Link href={review.postedUrl} label="送ったレビューを開く ↗" />}
            </Box>
          )}
        </Box>
      )
    }

    const row = (review: Review) => {
      const name = shortName(review.key, ready.sources)
      const tone = toneOf(review)

      return (
        <Box key={`row-box:${review.key}`} flexDirection="row" gap="sm" marginTop="sm">
          {bar(tone)}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Button key={`row:${review.key}`} plain onPress={() => void select($, review.key)}>
                <Text mono weight="medium">
                  {name.number}
                </Text>{' '}
                <Text size="caption" dimColor>
                  {name.repo}
                </Text>
              </Button>
              <Text size="caption" color={tone}>
                {/* A pull request I reviewed before comes back for another look. */}
                {review.history && review.postedAt === undefined ? '再レビュー · ' : ''}
                {rowLabel(review, offset)}
              </Text>
            </Box>
            <Text wrap="truncate-end">{review.title}</Text>
          </Box>
        </Box>
      )
    }

    // A selected review takes the whole pane; the list folds to the line that leads back to it.
    if (selected && state.diffView?.key === selected.key) return diffScreen(selected, state.diffView)
    if (selected) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row">
            <Button
              key="back-to-list"
              variant="secondary"
              label={`← 一覧 (${visible.length})`}
              onPress={() => void select($, undefined)}
            />
          </Box>
          {state.fetchError !== undefined && <Text color="error">取得に失敗しました: {state.fetchError}</Text>}
          {detail(selected)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap="sm">
          <Text size="caption" dimColor>
            {state.isFetching
              ? '取得しています…'
              : state.lastFetchedAt
                ? `最終取得 ${clockText(state.lastFetchedAt, offset)}`
                : 'まだ取得していません'}
            {isOpen ? '' : ` · 時間外 · ${windowText(ready.schedule)}だけ自動取得`}
          </Text>
          <Button key="fetch" variant="secondary" label="更新" onPress={() => void fetchNow($, ready)} />
        </Box>
        {state.fetchError !== undefined && <Text color="error">取得に失敗しました: {state.fetchError}</Text>}
        {visible.length === 0 && !state.isFetching && (
          <Box marginTop="sm">
            <Text dimColor>レビュー待ちはありません。</Text>
          </Box>
        )}
        {visible.map(row)}
      </Box>
    )
  })
}
