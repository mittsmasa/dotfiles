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

### タスク識別と中央集約（成果物を作る場合の最初の作業）

簡易フロー以上（research/plan/verify-results を作る場合）は、Research に入る前に成果物の置き場所を用意する。

1. **task-id を決める**: `{YYYY-MM-DD}-{slug}`（slug はタスク内容を表す短い kebab-case）。
2. **中央 task dir を作る**: `~/.claude/workflow/{task-id}/`。
3. **`.workflow` symlink を張る**: リポジトリ直下に `.workflow` が無ければ、上記 task dir への symlink を作る（`ln -s ~/.claude/workflow/{task-id} <repo>/.workflow`）。既に `.workflow` が実ディレクトリとして存在する場合は移行しない（過去の別タスク成果物が入っているのが通常で、現タスク task-id dir へ自動マージすると別タスクの research/plan が混入する）。当該リポジトリは次タスクから symlink 運用に切り替える。旧成果物の中央移行は手動で行う。
4. 以降の Phase は従来どおり `$WORKFLOW_DIR`（=`.workflow/`）に書く。symlink 透過で実体は中央へ入る。

直接実行モード（成果物を作らない）はこの手順をスキップしてよい。

### 調査内容

`$WORKFLOW_DIR/research.md` に: 調査対象 / 現状の理解 / 影響範囲 / 技術的制約・リスク / スコープ評価。深さはタスク規模に比例。判断に必要な情報で止める。

**Scope Guard**（完了時自動評価、2つ以上該当で警告）: ステップ 10+ / ファイル 8+ / 独立コンポーネント 3+ / 探索+実装混在 / 終了条件曖昧 / 広範囲キーワード（すべて・全体 等）。警告時は分割戦略（垂直/水平/MVP/スパイク+本実装）を提案し承認を得てから Plan へ。

## Phase 2: Plan

`$WORKFLOW_DIR/plan.md` を作成。必須セクション: 目的 / 方針 / 実装ステップ（チェックリスト）/ 変更対象ファイル / リスクと対策 / 動作確認項目 / Review Status / Approval。

- 動作確認項目は**実行可能で検証可能**に（具体コマンド + 期待結果。手動確認はその旨明記）
- ヘッダ: `Review Status: pending / Round: 0 / Last Review Hash: (none)` と `Plan Status: draft / Approval Status: pending`

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

plan.md の確認項目を全実行（マルチプレクサなら別ペイン、bare なら Bash 直接）。PASS / FAIL / SKIP(手動) で記録。FAIL → 修正 → **全項目**再実行（最大 5 リトライ）。結果は `$WORKFLOW_DIR/verify-results.md` へ。

## Phase 7: Completion

全ステップ完了 + 全確認 PASS/SKIP → Plan Status: done。サマリー報告（変更概要 / 確認結果 / SKIP 手動確認依頼 / フォローアップ）。

---

## Implementation Guard

Approval=approved, Review=pass, hash 一致を満たさない限り `$WORKFLOW_DIR` 外へのソース書き込みと実装系 Bash をブロック。research.md / plan.md の編集は常に許可。

## Task Completion Protocol

停止前に: タスク完全達成 / テスト・ビルド成功 / コミット依頼完了。失敗中・次ステップあり・コミット未完了 → 継続。期待値を一方的に下げない。

## 環境変数

`WORKFLOW_DIR`: 成果物出力先（未設定時 `.workflow/`）。通常 `.workflow/` は Phase 1 で張った中央 task dir（`~/.claude/workflow/{task-id}/`）への symlink であり、書き込みは symlink 透過で中央に入る。dashboard はこの中央 dir を直接走査する。
