# Workflow Rules (Tier 3: 最大構成)

## Overview

タスクを受け付けたら、以下のフェーズを順に実行する。
各フェーズには自律的な品質ゲートがあり、条件を満たすまで次のフェーズへ進めない。

```
consult → research → plan → (plan review loop) → implement → (verify loop) → done
```

## Session Scoping

- 1セッション1ゴール（調査 OR 実装、両方やらない）
- 多フェーズの作業は調査・計画・実装を別セッションに分離する
- サブエージェント（Task tool / Explore agent）をコードベース調査に活用し、メインコンテキストを温存する
- セッションをまたぐ作業は TaskCreate で進捗を追跡する

## tmux レイアウトとペイン戦略

### 基本レイアウト（セッション開始時に構築）

```
tmux session: "work"

window 0: "main"
┌──────────────┬──────────────┐
│ pane 0       │ pane 1       │
│ claude code  │ dev server   │
│ (メイン操作)  │ (常駐)       │
├──────────────┴──────────────┤
│ pane 2                      │
│ verify / ad-hoc commands    │
└─────────────────────────────┘

window 1: "review" (hook が動的に生成・破棄)
┌─────────────────────────────┐
│ claude (fresh context)      │
│ plan review 専用             │
└─────────────────────────────┘
```

### セットアップ

```bash
tmux new-session -s work -n main
tmux split-window -h -t work:main
tmux send-keys -t work:main.1 'npm run dev' Enter
tmux split-window -v -t work:main.0
tmux select-pane -t work:main.0
```

### ペインの用途とフェーズ対応

| ペイン | 用途 | 使用フェーズ |
| --- | --- | --- |
| main.0 | Claude Code メインセッション | 全フェーズ |
| main.1 | dev server / watch 等の常駐プロセス | implement, verify |
| main.2 | 動作確認コマンドの実行・結果取得 | verify |
| review window | 別コンテキストの claude による plan レビュー | review (hook が自動管理) |

## Phase 0: Consult（相談・受付）

タスクを受け付けたら、まず実行モードを判定する。

| 条件 | 実行モード |
| --- | --- |
| 1-2 ステップ、1-2 ファイル | 直接実行（このワークフロー不要） |
| 3-5 ステップ、方針が明確 | 簡易ワークフロー（research → implement） |
| 3+ ステップ、設計判断を伴う | **フルワークフロー（必須）** |
| Scope Guard 検知 | スコープ警告 → 分割戦略の提示 |

### 規模判定（省略不可）

タスク受付直後、他の一切の行動（調査・実装含む）より前に以下を出力する:

> **規模判定**
> - 推定ステップ数: N
> - 推定影響ファイル数: N
> - 設計判断: あり/なし
> - 探索+実装の混在: あり/なし
> - → 実行モード: 直接実行 / 簡易フロー / フルフロー

## Phase 1: Research（調査）

### 目的

対象コードと関連領域を深く読み、`research.md` にまとめる。

### 出力: `$WORKFLOW_DIR/research.md`

```markdown
# Research: [タスク名]

## 調査対象
- 調査したファイル・モジュールの一覧

## 現状の理解
- 現在の実装がどうなっているか

## 影響範囲
- 変更が波及するモジュール・ファイル

## 技術的制約・リスク
- 注意すべき依存関係、破壊的変更の可能性

## スコープ評価
- 推定ステップ数: N
- 推定影響ファイル数: N
- スコープ判定: small / medium / large / x-large
```

### Scope Guard（スコープ警告）

Research 完了時に以下を自動評価する。**2つ以上該当でスコープ警告を発動**:

| シグナル | 基準 |
| --- | --- |
| 推定ステップ数 | 10 ステップ以上 |
| 影響ファイル数 | 8 ファイル以上 |
| 複数モジュール | 3 つ以上の独立コンポーネントへの変更 |
| 探索+実装の混在 | 「調べてから実装を決める」パターン |
| 終了条件の曖昧さ | 定量的な完了基準が定義できない |
| 広範囲キーワード | 「すべて」「全体」「一通り」「各コンポーネント」 |

**警告発動時の行動:**

1. スコープの大きさとリスクをユーザーに簡潔に伝える
2. 以下の分割戦略から適切なものを提案する:
   - **垂直分割**: 機能単位で独立したタスクに分ける
   - **水平分割**: レイヤー単位（データ層 → ロジック層 → UI層）で段階実行
   - **MVP戦略**: 最小限の変更で価値を出し、段階的に拡張
   - **スパイク+本実装**: 探索フェーズと実装フェーズを明確に分離
3. ユーザーの承認を得てから Plan フェーズへ進む

**例外**: ユーザーが明示的にスコープ警告を不要と指示した場合のみスキップ可能

## Phase 2: Plan（計画策定）

### 目的

`research.md` に基づき、具体的な実装計画を作成する。

### 出力: `$WORKFLOW_DIR/plan.md`

```markdown
# Plan: [タスク名]

## 目的
- このタスクで達成すること（1-2文）

## 方針
- 採用するアプローチとその理由

## 実装ステップ
- [ ] Step 1: [具体的な作業内容] — 対象: `path/to/file`
- [ ] Step 2: [具体的な作業内容] — 対象: `path/to/file`
- [ ] ...

## 変更対象ファイル
- `path/to/file1` — 変更内容の概要
- `path/to/file2` — 変更内容の概要

## リスクと対策
- リスク1 → 対策
- リスク2 → 対策

## 動作確認項目
- [ ] 確認1: [具体的な確認コマンドまたは手順と期待結果]
- [ ] 確認2: [具体的な確認コマンドまたは手順と期待結果]
- [ ] 確認3: ...

## Review Status
- Status: pending
- Round: 0
- Last Review Hash: (none)

## Approval
- Plan Status: draft
- Approval Status: pending
```

### 動作確認項目の要件

動作確認項目は、**実行可能で検証可能**であること:

- 具体的なコマンドが記載されている（例: `npm run test`, `npm run build`, `curl localhost:3000/api/health`）
- 期待される結果が明記されている（例: 「exit code 0」「レスポンスに `status: ok` を含む」）
- 手動確認が必要な場合はその旨を明記する

## Phase 3: Plan Review Loop（計画レビュー反復 — Hook自動実行）

### 目的

plan.md の品質をサブエージェントで**まっさらなコンテキスト**からレビューし、計画が収束するまで自動的に反復する。

### Hook による自動トリガー

`plan.md` への書き込み（Write / Edit / MultiEdit）を検知し、`plan-review-automation` hook が自動実行される。

**hook の動作:**

1. `plan.md` の内容ハッシュを計算する
2. 前回レビュー時のハッシュと比較し、変更がなければスキップ
3. 変更があれば tmux の review ウィンドウを新規作成し、別プロセスの `claude` CLI を起動:
   ```bash
   # hook 内部の処理イメージ
   tmux new-window -t work -n review
   tmux send-keys -t work:review \
     "claude --print --system-prompt '$(cat $WORKFLOW_DIR/.review-prompt)' \
       'ファイルを読んでレビューしてください: $WORKFLOW_DIR/research.md $WORKFLOW_DIR/plan.md' \
       > $WORKFLOW_DIR/review-round-$ROUND.md" Enter
   ```
4. レビュー完了後、結果を `plan.md` の `Review Status` セクションに書き戻す:
   - `Review Status: pass` または `Review Status: needs_revision`
   - `<!-- auto-review: verdict=pass|needs_revision; hash=<sha256>; round=N -->`
5. review ウィンドウを自動で閉じる:
   ```bash
   tmux kill-window -t work:review
   ```

**ポイント**: review ウィンドウは完全に別プロセスの claude なので、メインセッションのコンテキストから完全に独立している。メインセッションはレビュー中もブロックされない。

### レビュアーの評価観点

サブエージェントは以下の6観点で plan.md を評価する:

1. **完全性**: research.md で特定された影響範囲がすべて plan に反映されているか
2. **具体性**: 各ステップが十分に具体的で、実装者が迷わないか
3. **順序の妥当性**: ステップの依存関係と実行順序は正しいか
4. **リスク対応**: 特定されたリスクに対する対策は十分か
5. **動作確認の網羅性**: 変更内容に対して動作確認項目は十分か
6. **スコープの適切さ**: 不要な変更が含まれていないか、必要な変更が漏れていないか

### レビューループの制御

- **verdict が `pass`**: Plan Status を `complete` に自動更新 → ユーザーに承認を求める
- **verdict が `needs_revision`**:
  1. 指摘事項を plan.md に反映（この書き込みが次の hook トリガーになる）
  2. Review Status の Round が自動インクリメント
  3. hook が再実行され、新しいサブエージェントでレビュー
- **最大ラウンド数: 3回** — 3回で収束しない場合、残課題をユーザーに提示して判断を仰ぐ
- 各ラウンドのレビュー結果は `$WORKFLOW_DIR/review-round-N.md` に自動保存される

### Hash 整合性チェック

- plan.md の `<!-- auto-review: ... hash=... -->` マーカーにより、レビュー後の改変を検知する
- Approval 時に現在の plan.md のハッシュとマーカー内のハッシュを比較
- **不一致の場合**: レビューが無効化され、再レビューが自動トリガーされる

### レビュー結果の記録

各ラウンドの結果は以下の形式で自動保存:

```markdown
# Review Round N

## Verdict: pass / needs_revision

## Issues
- [severity] category: description → suggestion

## Changes Made (needs_revision の場合)
- plan.md のどこをどう修正したか
```

## Phase 4: Approval（承認）

**CRITICAL: 承認は人間のみが行う。**

- ユーザーが明示的に「approve」「承認」「OK」「進めて」等と発言した場合のみ、Approval Status を `approved` に変更する
- Claude が自己判断で承認してはならない
- 承認前の実装着手は禁止

## Phase 5: Implement（実装）

### 前提条件（すべて満たすこと）

- `Plan Status: complete`
- `Review Status: pass`（最新の review round が pass）
- `Approval Status: approved`

### 実行ルール

1. plan.md の実装ステップを上から順に実行する
2. 各ステップ完了時に plan.md のチェックボックスを更新する
3. ステップの実行中に計画外の変更が必要になった場合:
   - 軽微（typo修正、import追加等）: そのまま実施し plan.md に追記
   - 中程度以上: 実装を中断し、plan.md を更新して再レビューを検討

## Phase 6: Verify Loop（動作確認反復）

### 目的

plan.md に記載された動作確認項目をすべて実行し、全パスするまで修正を繰り返す。

### プロセス

```
動作確認項目を順に実行 → 失敗あり？ → 原因特定・修正 → 全項目を再実行 → ... → 全パス → 完了
```

### 実行ルール

1. plan.md の「動作確認項目」を上から順にすべて実行する
2. **tmux pane 2 を活用**: メインの Claude（pane 0）が pane 2 にコマンドを送信し、結果を取得する:
   ```bash
   # コマンド送信
   tmux send-keys -t work:main.2 'npm run test' Enter
   # 完了待ち後に結果取得
   tmux capture-pane -t work:main.2 -p
   ```
   これによりメインのコンテキストを汚さず、繰り返し確認を実行できる
3. 各項目の結果を記録する:
   - `[PASS]` — 期待通りの結果
   - `[FAIL]` — 期待と異なる結果（実際の結果を記録）
   - `[SKIP]` — 手動確認が必要（ユーザーに委ねる）
3. **1つでも FAIL がある場合**:
   - 失敗原因を特定する
   - 修正を実施する
   - **全項目**を再実行する（修正が他に影響する可能性があるため）
4. **全項目が PASS または SKIP になるまで繰り返す**
5. **最大リトライ: 5回** — 5回で全パスしない場合、状況をユーザーに報告して判断を仰ぐ

### 動作確認結果の記録: `$WORKFLOW_DIR/verify-results.md`

```markdown
# Verification Results

## Run N (timestamp)

| # | 確認項目 | 結果 | 備考 |
|---|---------|------|------|
| 1 | `npm run build` が成功する | PASS | |
| 2 | `npm run test` が全パスする | FAIL | 2件失敗: test-x, test-y |
| 3 | ... | | |

## 修正内容
- [失敗項目に対して何を修正したか]

## Run N+1 (timestamp)
...
```

## Phase 7: Completion（完了）

### 完了条件

- plan.md の全ステップにチェックが入っている
- 動作確認の全項目が PASS または SKIP
- SKIP 項目がある場合はユーザーに手動確認を依頼

### 完了時の行動

1. plan.md の Plan Status を `done` に更新
2. 作業サマリーをユーザーに報告:
   - 実施した変更の概要
   - 動作確認結果の概要
   - SKIP 項目の手動確認依頼（あれば）
   - 注意事項やフォローアップ事項（あれば）

---

## Task Completion Protocol

作業停止前の必須チェック:

- 元のタスクが完全に達成されたか
- テスト・ビルドが成功しているか
- 明示的に依頼されたコミットが完了しているか

**継続すべきケース:**

- テスト/ビルドが失敗している → 修正してリトライ
- 明確な次ステップがある → 実行する
- 明示的なコミット依頼がある → 完了させる
- 要件が曖昧 → ユーザーに確認する

**CRITICAL**: ユーザーの期待値を一方的に下げたり、ステアリングを無効化してはならない。

## Implementation Guard

`plan.md` の `Approval Status: approved` かつ `Review Status: pass` かつ hash 一致を満たさない限り、以下の操作はブロックされる:

- `$WORKFLOW_DIR` 外へのソースコード書き込み（Write / Edit / MultiEdit）
- 実装系の Bash コマンド実行

`research.md` と `plan.md` 自体への編集は承認前でも常に許可される。

---

## 環境変数

- `WORKFLOW_DIR`: ワークフロー成果物の出力先ディレクトリ（例: `.tmp/sessions/abcd1234/`）
  - 未設定の場合はワークフロー生成物をカレントディレクトリの `.workflow/` に作成する

## クイックリファレンス

```
Session Scoping    — 1セッション1ゴール、コンテキスト温存

Phase 0: consult   → タスク受付、実行モード判定
Phase 1: research  → 調査、research.md 作成、スコープ評価
Phase 2: plan      → 計画策定、plan.md 作成（動作確認項目必須）
Phase 3: review    → hook自動レビュー（最大3ラウンド、hash整合性チェック付き）
Phase 4: approval  → 人間による承認（Claude の自己承認禁止）
Phase 5: implement → 承認済み plan に従い実装（Implementation Guard 有効）
Phase 6: verify    → 動作確認項目を全実行（最大5リトライ、全パスまで反復）
Phase 7: complete  → 完了報告、手動確認依頼

Task Completion    — 作業停止前の必須チェック（テスト/ビルド/コミット）
Implementation Guard — plan未承認の実装をブロック
```
