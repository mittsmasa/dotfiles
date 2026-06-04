# Workflow Rules (Tier 3)

フロー: `consult → research → plan → review → implement → verify → done`

## Session Scoping

- 1 セッション 1 ゴール（調査/実装を混ぜない）
- 多フェーズは TaskCreate / サブエージェントで分離
- セッションまたぎは TaskCreate で追跡

## ペイン戦略

tmux/cmux があれば main.0=Claude / main.1=dev server / main.2=動作確認。詳細は `rules/pane-strategy.md`。

## CRITICAL: Phase 0 — Consult

**タスク受領時、ツール呼び出し・調査・エージェント起動より前に必ず以下を出力。自明でも省略禁止。**

> **規模判定**
> - 推定ステップ数 / 影響ファイル数 / 設計判断有無 / 探索+実装混在
> - → モード: 直接実行 (1-2step, 1-2file) / 簡易フロー (3-5step, 方針明確) / フルフロー (3+step, 設計判断あり)

## Phase 1: Research

### タスク中央集約（全モード共通、Phase 0 直後）

dashboard の In Progress に出すため、モード問わず以下を実行:

1. `task-id` 決定: `{YYYY-MM-DD}-{slug}`（kebab-case）
2. 中央 task dir 作成: `mkdir -p ~/.claude/workflow/{task-id}/`
3. `meta.json` 最小作成: `{"title":"<一行要約>","cwd":"<実作業 dir>"}`。`createdAt` / `branch` は hook が自動補完
4. `.workflow` symlink は任意（リポジトリ内で短縮パスが欲しい場合のみ `ln -s`）。既に実 dir として存在するなら移行しない
5. **dependsOn 判定**: `cwd` が git リポジトリで HEAD が `main`/`master` 以外から派生している場合、`~/.claude/workflow/*/meta.json` を grep して同じ派生元 `branch` を持つ task-id を探し、その PR が未マージなら `dependsOn: ["<task-id>", ...]` を meta.json に書く。該当なし or main 直系なら書かない
6. **cwd 分離判定**: dependsOn を 1 つ以上書いた場合、その派生元タスクと同じ作業ディレクトリを共有しない。`git worktree add .claude/worktrees/{slug} {branch}` で専用 worktree を切り、`meta.cwd` をその worktree パスにする。理由: dashboard は 1 ディレクトリにつき現在チェックアウト中の 1 ブランチしか観測できず、cwd を共有するとブランチ切替で先行タスクの PR 検出が壊れ、PR Open → PR Pending に誤降格する

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
- ヘッダ（行頭 `- ` 付きの canonical 書式で書く。hook の sed と dashboard の `derivePhase` がこの形を前提）: `- Review Status: pending` / `- Plan Status: draft` / `- Approval Status: pending`（hash/round は hook が末尾 `<!-- auto-review: ... -->` に記録、手動記載不要）

### UI / フロントエンド実装を含む場合（必須）

plan に UI / フロントエンド（web コンポーネント / ページ / 画面 / artifact 等）の実装が含まれるなら:

1. **`frontend-design` skill を必ず意識する**。設計前に skill の Design Thinking（Purpose / Tone / Constraints / Differentiation）を通し、"AI slop"（凡庸で量産的な UI）を避ける方針を plan に反映する
2. **plan.md にワイヤフレームを必ず掲載する**。ASCII 図などで主要画面のレイアウト・要素配置・状態（空 / ローディング / エラー等）を示す。レビューア・人間が承認時に UI の構造を視認できる粒度で書く

## Phase 3: Plan Review Loop（hook 自動）

`plan.md` 書き込みを `~/.claude/scripts/plan-review-hook.sh` が検知し **simplicity（veto 権）/ correctness / verifiability** の 3 レビュアを並列実行。

- pass → `- Plan Status: complete` → ユーザー承認へ
- needs_revision → applier が plan.md 編集 → 再レビュー（最大 3 ラウンド）
- error（全 skipped）→ ユーザー報告

main session の介入は `Approval Status: needs_human_review` 時のみ。詳細は hook スクリプト冒頭参照。

## Phase 4: Approval

**承認は人間のみ。自己承認禁止。承認前の実装着手禁止。** plan.md は difit で提示。**編集ごとに開き直す**（古い内容での承認事故防止）。承認後 `- Approval Status: approved` に書き換えて Phase 5 へ。

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

## Phase 7: Completion

**前提**（`Status: done` 前に満たす）:
- `meta.cwd` の worktree に未コミット差分ゼロ（`git status --porcelain` が空）
- いずれか: PR 作成 + URL 確認済み / `meta.json` に `"noPr": true`

未充足なら dashboard は `pr-pending` に降格。

### dashboard 列対応

| plan/verify 状態 | PR / dirty | 列 |
|---|---|---|
| 無し or `Approval: approved` | - | In Progress |
| `Plan Status: complete`（承認待ち） | - | Review |
| `Status: done` | dirty=true、または PR 無し + `noPr` 未宣言 | PR Pending |
| `Status: done` | dirty=false かつ `noPr=true` | Done |
| PR 紐付き | open | PR Open |
| PR 紐付き | merged | Done |

判定実装は `server.ts` の `derivePhase`。挙動変更時は表と関数を両方更新。

仕上げ:
- `verify-results.md` 末尾に `- Status: done`（全モード必須、dashboard 遷移シグナル）
- plan.md がある場合は `- Plan Status: done` に更新

### `noPr` 宣言

PR を作らないタスク（ローカル設定、調査のみ、chezmoi 経由で自動 push される `~/.claude/` 配下編集等）は `meta.json` に明示:

```json
{ "title": "...", "cwd": "...", "noPr": true }
```

宣言忘れは `pr-pending` 降格。手動で `meta.json` を直せば回復。

ただし `cwd` が `~/.claude/` 配下のタスクは `workflow-meta-hook.sh` が新規 `meta.json` 生成時に `noPr: true` を自動補完（既存には触らない）。

サマリー報告（変更概要 / 確認結果 / SKIP 手動依頼 / フォローアップ）。

---

## 並列実行: dynamic workflow（Scope Guard 連動オプトイン）

Claude の Workflow ツール（`agent()` / `parallel()` / `pipeline()` をスクリプトで回す multi-agent orchestration）を、特定フェーズの実行エンジンとして任意発動で使う。常用しない。

### 発動条件（すべて満たす）

1. Phase 1 の Scope Guard が警告（2 つ以上該当）を出した
2. 対象が次のいずれか: Research の多面探索 / Verify の多項目並列 / 設計案の judge panel
3. Claude が「ここは並列が効く」と提案し、ユーザーが承認した（autonomy.md の設計判断ゲートに従う。自動起動はしない）

この workflow.md に発動条件を明記することをもって、Workflow ツールの explicit opt-in 要件を満たす standing opt-in とする。発動はフェーズ単位の都度承認制。

### 適用してよいフェーズ

| フェーズ | 使い方 |
|---|---|
| Research | サブシステムごとに並列読み込み → research.md に集約 |
| Verify | plan.md の動作確認項目ごとに並列検証 |
| 設計探索 | 複数方針を独立生成 → 評価・統合（judge panel） |

### 不可侵

- Phase 3 Plan Review Loop には使わない。hook（`plan-review-hook.sh`）が既に並列レビューを担う。二重化しない。
- Phase 4 Approval は人間のみ。dynamic workflow に承認を委ねない。
- コスト節度（過剰実装回避）を優先。Scope Guard 非警告のタスクには使わない。

## Implementation Guard

Approval=approved, Review=pass, hash 一致を満たさない限り `$WORKFLOW_DIR` 外へのソース書き込みと実装系 Bash をブロック。research.md / plan.md 編集は常に許可。

## Task Completion Protocol

停止前確認: タスク完全達成 / テスト・ビルド成功 / コミット依頼完了。失敗中・次ステップあり・未コミットなら継続。期待値を一方的に下げない。

## 環境変数

`WORKFLOW_DIR`: 成果物出力先。真のソースは `~/.claude/workflow/{task-id}/`、`.workflow` symlink は任意の短縮パス。hook は未設定時 `tool_input.file_path` の親 dir を `pwd -P` で実体解決、symlink 経由でも中央 dir に到達。dashboard も中央 dir を直接走査。env 経由オーバーライドはテスト用途のみ。
