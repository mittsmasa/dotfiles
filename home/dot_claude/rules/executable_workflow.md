# Workflow Rules (Tier 3)

## フロー

```
consult → research → plan → review → implement → verify → done
```

## Session Scoping

- 1セッション1ゴール（調査か実装、混ぜない）
- 多フェーズ作業はサブエージェント / TaskCreate でコンテキスト温存
- セッションをまたぐ作業は TaskCreate で追跡

## ペイン戦略

マルチプレクサ（tmux / cmux）が使えるなら main.0=Claude / main.1=dev server / main.2=動作確認 の 3 ペイン構成を使う。bare 環境では Bash で直接実行。詳細は `rules/pane-strategy.md`。

## CRITICAL: Phase 0 — Consult（受付）

**タスクを受け取ったら、ツール呼び出し・調査・エージェント起動より前に、必ず以下を出力すること。例外なし。**

> **規模判定**
> - 推定ステップ数 / 影響ファイル数 / 設計判断有無 / 探索+実装混在
> - → モード: 直接実行(1-2step,1-2file) / 簡易フロー(3-5step,方針明確) / フルフロー(3+step,設計判断あり)

タスクが自明に見えても省略しない。

## Phase 1: Research（調査）

`$WORKFLOW_DIR/research.md` にまとめる。**調査の深さはタスク規模に比例**。網羅的にではなく、判断に必要な情報で止める。

```markdown
# Research: [タスク名]
## 調査対象
## 現状の理解
## 影響範囲
## 技術的制約・リスク
## スコープ評価
- 推定ステップ数 / 影響ファイル数 / スコープ判定: small|medium|large|x-large
```

### Scope Guard

完了時に自動評価。**2つ以上該当で警告**:

| シグナル | 基準 |
|---|---|
| 推定ステップ数 | 10+ |
| 影響ファイル数 | 8+ |
| 複数モジュール | 独立コンポーネント 3+ |
| 探索+実装混在 | 「調べてから決める」パターン |
| 終了条件曖昧 | 定量的完了基準なし |
| 広範囲キーワード | 「すべて」「全体」「一通り」等 |

警告時はスコープとリスクを伝え、分割戦略（垂直/水平/MVP/スパイク+本実装）を提案。承認を得てから Plan へ。

## Phase 2: Plan（計画策定）

`$WORKFLOW_DIR/plan.md` を作成。

```markdown
# Plan: [タスク名]
## 目的
## 方針
## 実装ステップ
- [ ] Step N: [作業] — 対象: `path/to/file`
## 変更対象ファイル
- `path/to/file` — 変更概要
## リスクと対策
## 動作確認項目
- [ ] [具体コマンド + 期待結果]
## Review Status
- Status: pending / Round: 0 / Last Review Hash: (none)
## Approval
- Plan Status: draft / Approval Status: pending
```

動作確認項目は**実行可能で検証可能**に（具体コマンド + 期待結果。手動確認はその旨明記）。

## Phase 3: Plan Review Loop（hook 自動）

`plan.md` の書き込みを PostToolUse hook (`~/.claude/scripts/plan-review-hook.sh`) が検知し、3 本のレビュア（**simplicity** / **correctness** / **verifiability**）を並列実行。simplicity は veto 権あり。

- **pass** → Plan Status: complete → ユーザーに承認を求める
- **needs_revision** → applier session が plan.md を直接編集（指摘反映 or escalate）。次回 hook 発火で再レビュー
- **error**（全レビュアが skipped）→ ユーザーに報告
- 最大 3 ラウンド

main session が介入するのは applier が `Approval Status: needs_human_review` を出したときだけ。それ以外のループは hook 内で完結。

詳細仕様（aggregator のロジック、マーカー記法、applier の編集対象、hash 整合性チェックなど）は `~/.claude/scripts/plan-review-hook.sh` の冒頭コメント参照。

## Phase 4: Approval（承認）

**承認は人間のみ。Claude の自己承認禁止。承認前の実装着手禁止。**

plan.md は **difit** で提示する（`pane-strategy.md` 参照）。**plan.md が編集されるたびに開き直す**（古い内容で承認される事故を防ぐ）。

ユーザーが承認した時点で `Approval Status: pending` → `approved` に書き換え、Phase 5 へ。

## Phase 5: Implement（実装）

前提: Plan Status=complete, Review Status=pass, Approval Status=approved

1. plan.md のステップを順に実行、完了ごとにチェック更新
2. **plan に書かれていないことはやらない。** リファクタ・「ついで」修正・改善はスコープ外
3. 計画外の変更が必要な場合: 軽微 → 実施し plan に追記 / 中程度以上 → 中断し plan 更新・再レビュー検討
4. 全ステップ完了後、Phase 6 に自ら進む。確認まで完走する

## Phase 6: Verify Loop（動作確認）

plan.md の確認項目を全実行（マルチプレクサ利用時は別ペインで、bare 環境では Bash で直接。手順は `pane-strategy.md`）。

- PASS / FAIL / SKIP(手動) で記録
- FAIL → 原因特定・修正 → **全項目**再実行
- 最大 5 リトライ（超過時はユーザーに報告）
- 結果は `$WORKFLOW_DIR/verify-results.md` に記録

## Phase 7: Completion（完了）

全ステップ完了 + 全確認 PASS/SKIP → Plan Status: done。
作業サマリー報告（変更概要 / 確認結果 / SKIP 手動確認依頼 / フォローアップ）。

---

## Implementation Guard

plan.md の Approval=approved, Review=pass, hash 一致を満たさない限り:
- `$WORKFLOW_DIR` 外へのソースコード書き込みをブロック
- 実装系 Bash をブロック
- research.md / plan.md 自体の編集は常に許可

## Task Completion Protocol

作業停止前: タスク完全達成 / テスト・ビルド成功 / コミット依頼完了。失敗中・次ステップあり・コミット未完了 → 継続。ユーザーの期待値を一方的に下げない。

## 環境変数

`WORKFLOW_DIR`: 成果物出力先（未設定時は `.workflow/`）
