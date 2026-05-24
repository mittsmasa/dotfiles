# Workflow Rules (Tier 3)

フロー: `consult → research → plan → review → implement → verify → done`

## Session Scoping

- 1セッション1ゴール（調査か実装、混ぜない）
- 多フェーズは TaskCreate / サブエージェントで分離
- セッションまたぎは TaskCreate で追跡

## ペイン戦略

tmux / cmux があれば main.0=Claude / main.1=dev server / main.2=動作確認 の 3 ペイン構成。詳細は `rules/pane-strategy.md`。

## CRITICAL: Phase 0 — Consult（受付）

**タスクを受け取ったら、ツール呼び出し・調査・エージェント起動より前に、必ず以下を出力すること。例外なし。タスクが自明に見えても省略しない。**

> **規模判定**
> - 推定ステップ数 / 影響ファイル数 / 設計判断有無 / 探索+実装混在
> - → モード: 直接実行(1-2step,1-2file) / 簡易フロー(3-5step,方針明確) / フルフロー(3+step,設計判断あり)

## Phase 1: Research

### タスク識別と中央集約（全モード共通、Phase 0 直後）

**モード問わず**、Phase 0 規模判定の直後にタスクを中央集約する。これで直接実行モードのタスクも workflow-dashboard の In Progress に出る。

1. **task-id を決める**: `{YYYY-MM-DD}-{slug}`（slug はタスク内容を表す短い kebab-case）。
2. **中央 task dir を作る**: `~/.claude/workflow/{task-id}/`（`mkdir -p` のみで OK）。
3. **`meta.json` を最小作成**: `{"title": "<タスクの一行要約>", "cwd": "<実作業ディレクトリ>"}`。dashboard の card タイトルに使われる。`createdAt` は `workflow-meta-hook.sh` が md 書き込み時に自動補完するので手動で書かなくてよい。
4. **`.workflow` symlink は任意**: リポジトリ内で短縮パス（`.workflow/plan.md` 等）を使いたい場合のみ `ln -s ~/.claude/workflow/{task-id} <repo>/.workflow` を張る。symlink が無くても全 hook / dashboard は中央 task dir を直接読むので機能する。既に `.workflow` が実ディレクトリとして存在する場合は移行しない（過去の別タスク成果物の混入を避けるため。旧成果物の中央移行は手動）。

モード別の追加成果物:
- **直接実行モード**: 上記 1-3 のみ。research / plan は不要。Phase 6 で `verify-results.md` を簡略でも書き、Phase 7 で末尾に `- Status: done` を追記して完了
- **簡易フロー / フルフロー**: 続く Phase 1 / Phase 2 で `research.md` / `plan.md` を書く

### 調査内容

`$WORKFLOW_DIR/research.md` に: 調査対象 / 現状の理解 / 影響範囲 / 技術的制約・リスク / スコープ評価。深さはタスク規模に比例。判断に必要な情報で止める。

**Scope Guard**（完了時自動評価、2つ以上該当で警告）: ステップ 10+ / ファイル 8+ / 独立コンポーネント 3+ / 探索+実装混在 / 終了条件曖昧 / 広範囲キーワード（すべて・全体 等）。警告時は分割戦略（垂直/水平/MVP/スパイク+本実装）を提案し承認を得てから Plan へ。

## Phase 2: Plan

`$WORKFLOW_DIR/plan.md` を作成。必須セクション: 目的 / 方針 / 実装ステップ（チェックリスト）/ 変更対象ファイル / リスクと対策 / 動作確認項目 / Review Status / Approval。

- 動作確認項目は**実行可能で検証可能**に（具体コマンド + 期待結果。手動確認はその旨明記）
- ヘッダ: `Review Status: pending` と `Plan Status: draft / Approval Status: pending`（hash / round はレビュー hook が末尾マーカー `<!-- auto-review: ... -->` に記録するので plan.md には書かない）

## Phase 3: Plan Review Loop（hook 自動）

`plan.md` 書き込みを PostToolUse hook (`~/.claude/scripts/plan-review-hook.sh`) が検知し、**simplicity**（veto 権あり）/ **correctness** / **verifiability** の 3 レビュアを並列実行。

- pass → Plan Status: complete → ユーザー承認へ
- needs_revision → applier が plan.md を編集 → 次 hook で再レビュー（最大 3 ラウンド）
- error（全 skipped）→ ユーザーに報告

main session の介入は `Approval Status: needs_human_review` 時のみ。詳細仕様は hook スクリプト冒頭コメント参照。

## Phase 4: Approval

**承認は人間のみ。自己承認禁止。承認前の実装着手禁止。** plan.md は difit で提示。**編集のたびに開き直す**（古い内容で承認される事故を防ぐ）。承認後 `Approval Status: approved` に書き換えて Phase 5 へ。

## Phase 5: Implement

前提: Plan Status=complete, Review Status=pass, Approval Status=approved

1. plan.md のステップを順に実行、完了ごとにチェック更新
2. **plan 外の作業禁止。** リファクタ・「ついで」修正・改善はスコープ外
3. 計画外変更: 軽微 → 実施し追記 / 中程度以上 → 中断し plan 更新
4. 全ステップ完了後、Phase 6 に自ら進む

## Phase 6: Verify

**全モード共通**で `$WORKFLOW_DIR/verify-results.md` を書く（マルチプレクサなら別ペインで、bare なら Bash 直接で実行）。

- **簡易フロー / フルフロー**: plan.md の動作確認項目を全実行。PASS / FAIL / SKIP(手動) で記録。FAIL → 修正 → **全項目**再実行（最大 5 リトライ）
- **直接実行モード**: 実施した変更が意図通り動くかの簡易ログ（手動確認結果でも可）を書く。plan.md が無いので項目数は最小で構わない

## Phase 7: Completion

全ステップ完了 + 全確認 PASS/SKIP →

**前提条件**（`Status: done` を書く前に満たす）:
- `meta.cwd` の worktree に未コミット差分がゼロ（`git -C $cwd status --porcelain` が空）
- 次のいずれか:
  - PR を作るタスク: PR を作成して URL を確認済み
  - PR を作らないタスク: `meta.json` に `"noPr": true` を追記

満たさない場合、dashboard は `Status: done` を書いても `pr-pending` 列に降格する。

- `verify-results.md` 末尾に `- Status: done` を追記（**全モード必須**。これが dashboard の Done 遷移シグナル）
- plan.md がある場合のみ `Plan Status: done` に更新

### `noPr` 宣言の書き方

PR を作らないタスク（例: ローカル設定変更、調査のみ、chezmoi 経由で自動 push される `~/.claude/` 配下の編集）では `meta.json` に明示する:

```json
{
  "title": "...",
  "cwd": "...",
  "noPr": true
}
```

宣言を忘れたタスクは `pr-pending` に降格する。手で `meta.json` を直せば回復する。

サマリー報告（変更概要 / 確認結果 / SKIP 手動確認依頼 / フォローアップ）。

---

## Implementation Guard

Approval=approved, Review=pass, hash 一致を満たさない限り `$WORKFLOW_DIR` 外へのソース書き込みと実装系 Bash をブロック。research.md / plan.md の編集は常に許可。

## Task Completion Protocol

停止前に: タスク完全達成 / テスト・ビルド成功 / コミット依頼完了。失敗中・次ステップあり・コミット未完了 → 継続。期待値を一方的に下げない。

## 環境変数

`WORKFLOW_DIR`: 成果物出力先。`.workflow` symlink を張った場合は `.workflow/`、張らない場合は中央 task dir（`~/.claude/workflow/{task-id}/`）を直接指す。`plan-review-hook.sh` / `workflow-meta-hook.sh` は環境変数が未設定なら `tool_input.file_path` の親 dir を採用するため、symlink の有無に関わらず動く。dashboard も中央 dir を直接走査する。
