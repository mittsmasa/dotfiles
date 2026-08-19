# Workflow Rules (Tier 3)

フロー: `consult → research → plan → review → implement → verify → done`

## Session Scoping

1 セッション 1 ゴール（調査/実装を混ぜない）。多フェーズは TaskCreate / サブエージェントで分離し、セッションまたぎは TaskCreate で追跡する。

## ペイン戦略

tmux があれば main.0=Claude / main.1=dev server / main.2=動作確認。詳細は `~/.agents/AGENTS.md` の「ペイン・ツール使い分け」節。

## CRITICAL: Phase 0 — Consult

**タスク受領時、ツール呼び出し・調査・エージェント起動より前にモードを 1 行で宣言する。自明でも省略禁止。**

> **規模判定** → モード: 直接実行（1-2 step・1-2 file）/ 簡易フロー（3-5 step・方針明確）/ フルフロー（3+ step・設計判断あり）— 理由を一言添える

## Phase 1: Research

### task dir（全モード共通、Phase 0 直後）

`task-id` を `{YYYY-MM-DD}-{slug}`（kebab-case）で決め、`mkdir -p ~/.claude/workflow/{task-id}/`。

**適用除外**: リポジトリのファイルを変更しない依頼（質問への回答、既存コード・ドキュメントの説明、翻訳・要約、チャット内で完結する相談）は task dir を作らない。記録すべき「作業」ではなく、儀式が成果を上回るため。判断に迷うなら作る側に倒す。

モード別追加:
- **直接実行**: 上記のみ。Phase 6 で `verify-results.md` 簡略版、Phase 7 で `- Status: done` 追記
- **簡易/フル**: 続けて `research.md` / `plan.md` を書く

### 調査内容（簡易/フルのみ）

`$WORKFLOW_DIR/research.md`: 調査対象 / 現状理解 / 影響範囲 / 制約・リスク / スコープ評価。

**範囲は絞り、深さは妥協しない。** 調べる範囲は「判断に必要な情報で止める」が、その範囲内は表面で済ませない。対象を**深く**読み、何をするか・どう動くか・その**細部と固有のクセ**（依存 / 前提 / 例外パス / 周辺との結合）まで掴む。「深く」「細部まで」「intricacies まで」と意識的に課さないと skim（流し読み）する。流し読みは実装段階で周辺システムとの不整合を招く（最大の失敗要因）。research.md はユーザーのレビュー面 — 理解の正否を検証・修正できる粒度で書く。

**Scope Guard**（2 つ以上該当で警告）: ステップ 10+ / ファイル 8+ / 独立コンポーネント 3+ / 探索+実装混在 / 終了条件曖昧 / 広範囲キーワード（「すべて」「全体」等）。警告時は分割戦略（垂直/水平/MVP/スパイク+本実装）または dynamic workflow による並列処理を提案し承認後 Plan へ。→ 詳細は末尾「並列実行: dynamic workflow」。

## Phase 2: Plan

`$WORKFLOW_DIR/plan.md` 必須セクション: 目的 / 方針 / 実装ステップ（チェックリスト）/ 変更対象ファイル / リスクと対策 / 動作確認項目 / Review Status / Approval。

- 動作確認項目は実行可能・検証可能に（具体コマンド + 期待結果。手動はその旨明記）
- ヘッダ（行頭 `- ` 付きの canonical 書式で書く。hook の sed がこの形を前提）: `- Review Status: pending` / `- Plan Status: draft` / `- Approval Status: pending`（hash/round は hook が末尾 `<!-- auto-review: ... -->` に記録、手動記載不要）

### UI / フロントエンド実装を含む場合（必須）

plan に UI / フロントエンド（web コンポーネント / ページ / 画面 / artifact 等）の実装が含まれるなら:

1. **`frontend-design` skill を必ず意識する**。設計前に skill の Design Thinking（Purpose / Tone / Constraints / Differentiation）を通し、"AI slop"（凡庸で量産的な UI）を避ける方針を plan に反映する
2. **plan.md にワイヤフレームを必ず掲載する**。ASCII 図などで主要画面のレイアウト・要素配置・状態（空 / ローディング / エラー等）を示す。レビューア・人間が承認時に UI の構造を視認できる粒度で書く

## Phase 3: Plan Review Loop（hook 自動）

`plan.md` 書き込みを `~/.claude/scripts/plan-review-hook.sh` が検知し **simplicity（veto 権）/ correctness / verifiability** の 3 レビュアを並列実行。

- pass → `- Plan Status: complete` → ユーザー承認へ
- needs_revision → applier が plan.md 編集 → 再レビュー（最大 3 ラウンド）
- error（全 skipped）→ ユーザー報告

verdict 確定後、中間生成物（`.raw` / `.exit` / 抽出 json / `*-peers.md` / `plan.md.bak`）は自動削除される。集約レポート `review-round-N.md` は残る。verdict=error のときは原因調査のため削除しない。

**レビュアの指摘はユーザーの明示的な決定に優先しない。** applier がユーザーの決定事項を削った場合は復活させ、その旨を plan.md に明記してユーザーに報告する。

main session の介入は `Approval Status: needs_human_review` 時のみ。詳細は hook スクリプト冒頭参照。

## Phase 4: Approval

**承認は人間のみ。自己承認禁止。承認前の実装着手禁止。**

チャットでユーザーが承認したら `- Approval Status: approved` に書き換えて Phase 5 へ。`needs_human_review` に遷移した場合は、その場でユーザーに提示して判断を仰ぐ。

## Phase 5: Implement

前提: Plan Status=complete, Review Status=pass, Approval Status=approved

1. plan.md のステップ順に実行、完了ごとにチェック更新
2. **plan 外作業禁止**。リファクタ・「ついで」修正は対象外
3. 計画外変更: 軽微 → 実施し追記 / 中程度以上 → 中断し plan 更新
4. 全完了で Phase 6 へ

## Phase 6: Verify

全モード共通で `$WORKFLOW_DIR/verify-results.md` を書く。

- **簡易/フル**: plan.md の動作確認項目を全実行、PASS/FAIL/SKIP(手動) 記録。FAIL → 修正 → **全項目**再実行（最大 5 リトライ）
- **直接実行**: 簡易ログのみ（手動確認結果でも可）

### テストを削除・リファクタしたとき

- **エラー分岐のカバレッジを落とさない。** vi.mock の整理、toast アサーションの削除などでアサーションを消すときは、削除ではなく置き換える
- カバレッジの増減は `verify-results.md` と PR description の両方に書く。「変化なし」なら変化なしと書く
- テストリファクタ後は CI を再実行し、実行回数と結果を報告してからレビューを依頼する

## Phase 7: Completion

`Status: done` の前に満たす前提と仕上げ:

- 作業ディレクトリに未コミット差分ゼロ（`git status --porcelain` が空）。PR が必要なタスクなら PR 作成 + URL 確認済み
- `verify-results.md` 末尾に `- Status: done`（全モード必須）。plan.md がある場合は `- Plan Status: done` に更新
- サマリー報告（変更概要 / 確認結果 / SKIP 手動依頼 / フォローアップ）

---

## 並列実行: dynamic workflow（Scope Guard 連動オプトイン）

Claude の Workflow ツール（`agent()` / `parallel()` / `pipeline()` によるマルチエージェント実行）を、特定フェーズの実行エンジンとして任意発動で使う。常用しない。

**発動条件（すべて満たす）**: ① Phase 1 の Scope Guard が警告（2 つ以上該当）を出した ② 対象が Research の多面探索 / Verify の多項目並列 / 設計案の judge panel のいずれか ③ Claude が「ここは並列が効く」と提案し、ユーザーが承認した（`~/.agents/AGENTS.md` の Autonomy Rules「止まるべき場面 > 3. 設計判断」に従う。自動起動はしない）。この節に発動条件を明記することをもって Workflow ツールの explicit opt-in 要件を満たす standing opt-in とし、発動はフェーズ単位の都度承認制とする。

**不可侵**: Phase 3 Plan Review Loop には使わない（hook が既に並列レビューを担う。二重化しない）。Phase 4 Approval は人間のみ、dynamic workflow に委ねない。Scope Guard 非警告のタスクには使わない（過剰実装回避を優先）。

## Task Completion Protocol

停止前確認: タスク完全達成 / テスト・ビルド成功 / コミット依頼完了。失敗中・次ステップあり・未コミットなら継続。期待値を一方的に下げない。

## 環境変数

- `WORKFLOW_DIR`: 成果物出力先。真のソースは `~/.claude/workflow/{task-id}/`。hook は未設定時 `tool_input.file_path` の親 dir を `pwd -P` で実体解決する。env 経由オーバーライドはテスト用途のみ
- `PLAN_REVIEW_KEEP_ARTIFACTS`: 非空なら Phase 3 の中間生成物を掃除しない（テスト用途）
