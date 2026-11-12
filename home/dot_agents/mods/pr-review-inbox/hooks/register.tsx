import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import type { Finding, Inbox, Review, ReviewPayload } from '../types'
import { actionsOf, primaryOf } from './posting'
import {
  SEVERITY_TONE,
  bandText,
  bandTone,
  clockText,
  deepDivePrompt,
  isDue,
  isGithubUrl,
  rowLabel,
  shortName,
  splitPlace,
  toneOf,
} from './reviews'
import {
  activate,
  addComment,
  fetchNow,
  isToolCallAllowed,
  makeConfig,
  markRead,
  onTurnComplete,
  openConfirm,
  openFinding,
  requeue,
  retry,
  saveEdit,
  select,
  send,
  setMode,
  showBody,
  showHumanReview,
  toggle,
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
const HUMAN_REVIEW_SHOWN = 2
// A description longer than this many lines is folded until asked for.
const BODY_SHOWN_LINES = 12

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
    const { Box, Text, Button, Link, Input, Markdown } = $.ui.resolve(e)
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
    const isOpen = isDue(new Date(await $.clock.now()), offset)

    // The left edge of a block: one cell wide, as tall as what stands beside it.
    const bar = (color: string) => <Box width={1} flexShrink={0} backgroundColor={color} />

    const heading = (text: string) => (
      <Box marginTop="md">
        <Text size="caption" dimColor>
          {text}
        </Text>
      </Box>
    )

    // ---- the confirm screen: the whole request, exactly as it will be sent ----
    const confirm = (review: Review, payload: ReviewPayload, isSending: boolean, error?: string) => {
      const name = shortName(review.key, ready.repos)

      return (
        <Box flexDirection="column">
          <Text weight="medium">送信の確認</Text>
          <Text>
            <Text mono>{name.number}</Text> {name.repo} に {payload.event} レビューを送ります。
            {payload.event === 'APPROVE' ? 'この PR を承認します。' : ''}
          </Text>
          {heading(`インライン ${payload.comments.length} 件`)}
          {payload.comments.map(comment => (
            <Box flexDirection="column" marginTop="sm">
              <Text mono size="caption" dimColor>
                {comment.path}:{comment.line}
              </Text>
              <Text>{comment.body}</Text>
            </Box>
          ))}
          {heading(payload.body === undefined ? '本文（なし）' : '本文')}
          {payload.body !== undefined && <Text>{payload.body}</Text>}
          {error !== undefined && (
            <Box marginTop="md">
              <Text color="error">送信できませんでした: {error}</Text>
            </Box>
          )}
          {isSending ? (
            <Box marginTop="md">
              <Text dimColor>送信しています…</Text>
            </Box>
          ) : (
            <Box flexDirection="row" gap="md" marginTop="md" alignItems="center">
              <Button key="send" variant="primary" label="送信する" onPress={() => void send($, ready, review.key)} />
              <Button key="back" plain label="戻る" onPress={() => void setMode($, undefined)} />
            </Box>
          )}
        </Box>
      )
    }

    // ---- one finding: a line when closed; its text and controls when open ----
    const finding = (review: Review, one: Finding, isEditable: boolean) => {
      const place = splitPlace(one.file, one.line)
      const isShown = state.openFindingId === one.id
      const isEditing = isEditable && mode?.kind === 'edit' && mode.id === one.id
      const tags = [
        one.source === 'human' ? undefined : one.severity,
        one.criteriaId,
        one.isUnsure ? '要確認' : undefined,
        one.source === 'human' ? '自分' : undefined,
        one.isAdopted ? undefined : '外した',
      ].filter(Boolean)

      return (
        <Box flexDirection="row" gap="sm" marginTop="sm">
          {bar(one.isAdopted ? SEVERITY_TONE[one.severity] : 'inactive')}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Button key={`open:${one.id}`} plain onPress={() => void openFinding($, one.id)}>
                <Text mono weight="medium" strikethrough={!one.isAdopted} dimColor={!one.isAdopted}>
                  {place.name || '場所なし'}
                </Text>
              </Button>
              <Text size="caption" dimColor>
                {tags.join(' · ')}
              </Text>
            </Box>
            <Text dimColor={!one.isAdopted}>{one.reason}</Text>
            {isShown && place.dir !== '' && (
              <Text mono size="caption" dimColor>
                {place.dir}
              </Text>
            )}
            {isShown && one.isAdopted && !isEditing && (
              <Box borderStyle="single" borderDimColor paddingX="sm" marginTop="xs">
                <Text>{one.comment}</Text>
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
                <Button key={`edit-cancel:${one.id}`} plain label="やめる" onPress={() => void setMode($, undefined)} />
              </Box>
            )}
            {isShown && isEditable && !isEditing && (
              <Box flexDirection="row" gap="md" marginTop="xs">
                {one.isAdopted && (
                  <Button
                    key={`edit:${one.id}`}
                    plain
                    label="編集"
                    onPress={() => void setMode($, { kind: 'edit', id: one.id })}
                  />
                )}
                <Button
                  key={`toggle:${one.id}`}
                  plain
                  label={one.isAdopted ? '外す' : '戻す'}
                  onPress={() => void toggle($, review.key, one.id)}
                />
              </Box>
            )}
          </Box>
        </Box>
      )
    }

    const detail = (review: Review) => {
      const actions = actionsOf(review, state.withDiff.includes(review.key))
      const primary = primaryOf(actions)
      const isEditable = review.status === 'done' && review.postedAt === undefined
      const adopted = review.findings.filter(one => one.isAdopted).length
      const total = review.findings.length
      const points = state.isHumanReviewOpen ? review.humanReview : review.humanReview.slice(0, HUMAN_REVIEW_SHOWN)
      const hidden = review.humanReview.length - points.length
      const bodyLines = (review.body ?? '').trim() === '' ? [] : (review.body as string).split('\n')
      const isBodyFolded = !state.isBodyOpen && bodyLines.length > BODY_SHOWN_LINES

      return (
        <Box flexDirection="column">
          {heading('概要')}
          {bodyLines.length === 0 ? (
            <Text dimColor>本文なし</Text>
          ) : (
            <Markdown
              key="body"
              text={isBodyFolded ? bodyLines.slice(0, BODY_SHOWN_LINES).join('\n') : bodyLines.join('\n')}
            />
          )}
          {isBodyFolded && (
            <Button key="more-body" plain label="続きを表示" onPress={() => void showBody($)} />
          )}
          {review.status === 'done' &&
            heading(
              total === 0 ? '指摘' : isEditable ? `指摘 · ${total} 件中 ${adopted} 件を送る` : `指摘 · ${total} 件`,
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
              <Button key="add-cancel" plain label="やめる" onPress={() => void setMode($, undefined)} />
            </Box>
          )}
          {isEditable && mode?.kind !== 'add' && (
            <Box marginTop="sm">
              <Button
                key="add"
                plain
                label="+ コメントを追加"
                onPress={() => void setMode($, { kind: 'add', place: '' })}
              />
            </Box>
          )}
          {review.status === 'done' && review.skipped.length > 0 && (
            <Box marginTop="sm">
              <Text size="caption" dimColor>
                省いたもの: {review.skipped.join('、')}
              </Text>
            </Box>
          )}
          {points.length > 0 && heading('人間が見る観点')}
          {points.map(point => (
            <Text dimColor>・ {point}</Text>
          ))}
          {hidden > 0 && (
            <Button key="more-points" plain label={`ほか ${hidden} 件`} onPress={() => void showHumanReview($)} />
          )}
          <Box flexDirection="row" gap="md" marginTop="md" alignItems="center" flexWrap="wrap">
            {actions.includes('comment') && (
              <Button
                key="comment"
                variant={primary === 'comment' ? 'primary' : 'secondary'}
                label={`COMMENT で送る (${adopted})`}
                onPress={() => void openConfirm($, ready, review.key, 'COMMENT')}
              />
            )}
            {actions.includes('approve') && (
              <Button
                key="approve"
                variant={primary === 'approve' ? 'primary' : 'secondary'}
                label="Approve で送る"
                onPress={() => void openConfirm($, ready, review.key, 'APPROVE')}
              />
            )}
            {actions.includes('rereview') && (
              <Button key="rereview" label="再レビュー" onPress={() => void requeue($, ready, review.key)} />
            )}
            {review.status === 'failed' && (
              <Button key="retry" label="やり直す" onPress={() => void retry($, ready, review.key)} />
            )}
            {review.postedUrl !== undefined && review.postedUrl.startsWith('https://github.com/') && (
              <Link href={review.postedUrl} label="送ったレビューを開く" />
            )}
          </Box>
          <Box flexDirection="row" gap="md" marginTop="sm" alignItems="center" flexWrap="wrap">
            {isGithubUrl(review.url) && <Link href={review.url} label="GitHub で開く" />}
            {isGithubUrl(review.url) && (
              <Button
                key="deep-dive"
                plain
                label="深掘りする"
                onPress={() => void $.prompt.fill({ text: deepDivePrompt(review.url), mode: 'replace' })}
              />
            )}
            <Button key="read" plain label="既読" onPress={() => void markRead($, review.key)} />
          </Box>
        </Box>
      )
    }

    if (selected && (mode?.kind === 'confirm' || mode?.kind === 'sending')) {
      return confirm(selected, mode.payload, mode.kind === 'sending', mode.kind === 'confirm' ? mode.error : undefined)
    }

    const row = (review: Review) => {
      const name = shortName(review.key, ready.repos)
      const isSelected = review.key === selected?.key
      const tone = toneOf(review)

      return (
        <Box
          key={`row-box:${review.key}`}
          flexDirection="row"
          gap="sm"
          marginTop="sm"
          {...(false ? { borderStyle: 'round', borderColor: 'suggestion', paddingRight: 'sm' } : {})}
        >
          {bar(tone)}
          <Box flexDirection="column" flexGrow={1}>
            <Box flexDirection="row" justifyContent="space-between" gap="sm">
              <Button
                key={`row:${review.key}`}
                plain
                onPress={() => void select($, isSelected ? undefined : review.key)}
              >
                <Text mono weight={isSelected ? 'bold' : 'medium'}>
                  {name.number}
                </Text>{' '}
                <Text size="caption" dimColor>
                  {name.repo}
                </Text>
              </Button>
              <Text size="caption" color={tone}>
                {rowLabel(review, offset)}
              </Text>
            </Box>
            <Text wrap="truncate-end" dimColor={selected !== undefined && !isSelected}>
              {review.title}
            </Text>
          </Box>
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
            {isOpen ? '' : ' · 時間外'}
          </Text>
          <Button key="fetch" plain label="更新" onPress={() => void fetchNow($, ready)} />
        </Box>
        {state.fetchError !== undefined && <Text color="error">取得に失敗しました: {state.fetchError}</Text>}
        {visible.length === 0 && !state.isFetching && (
          <Box marginTop="sm">
            <Text dimColor>レビュー待ちはありません。</Text>
          </Box>
        )}
        {visible.map(row)}
        {selected && detail(selected)}
      </Box>
    )
  })
}
