# Workflow Rules (Tier 3: 最大構成)

## フロー

```
consult → research → plan → (plan review loop) → implement → (verify loop) → done
```

## Session Scoping

- 1セッション1ゴール（調査 OR 実装、両方やらない）
- 多フェーズ作業は調査・計画・実装を別セッションに分離
- サブエージェント（Task tool / Explore agent）でコンテキスト温存
- セッションをまたぐ作業は TaskCreate で追跡

## tmux 戦略

| ペイン | 用途 | フェーズ |
|---|---|---|
| main.0 | Claude Code メイン | 全フェーズ |
| main.1 | dev server / watch 常駐 | implement, verify |
| main.2 | 動作確認コマンド実行 | verify |
| review window | hook が動的生成・破棄、別 claude で plan レビュー | review |

## CRITICAL: Phase 0 — Consult（受付）

**タスクを受け取ったら、ツール呼び出し・調査・エージェント起動より前に、必ず以下を出力すること。例外なし。**

> **規模判定**
> - 推定ステップ数 / 影響ファイル数 / 設計判断有無 / 探索+実装混在
> - → 実行モード: 直接実行(1-2step,1-2file) / 簡易フロー(3-5step,方針明確) / フルフロー(3+step,設計判断あり)

タスクが自明に見えても省略しない。規模判定のコストはゼロ、飛ばすリスクは高い。

## Phase 1: Research（調査）

対象コードと関連領域を読み `$WORKFLOW_DIR/research.md` にまとめる。

**調査の深さはタスクの規模に比例させる。** 過剰に広く深く調べない。必要十分な情報を得たら止める。「徹底的に」「網羅的に」調査するのではなく、実装判断に必要な情報を効率的に集める。

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

Research 完了時に自動評価。**2つ以上該当で警告発動**:

| シグナル | 基準 |
|---|---|
| 推定ステップ数 | 10+ |
| 影響ファイル数 | 8+ |
| 複数モジュール | 独立コンポーネント 3+ |
| 探索+実装混在 | 「調べてから実装を決める」パターン |
| 終了条件の曖昧さ | 定量的完了基準が定義できない |
| 広範囲キーワード | 「すべて」「全体」「一通り」「各コンポーネント」 |

**警告時**: スコープとリスクを伝え、分割戦略（垂直/水平/MVP/スパイク+本実装）を提案。承認を得てから Plan へ。
ユーザーが明示的にスキップ指示した場合のみ省略可。

## Phase 2: Plan（計画策定）

`research.md` に基づき `$WORKFLOW_DIR/plan.md` を作成。

```markdown
# Plan: [タスク名]
## 目的
## 方針
## 実装ステップ
- [ ] Step N: [作業内容] — 対象: `path/to/file`
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

動作確認項目は**実行可能で検証可能**に（具体コマンド＋期待結果。手動確認はその旨明記）。

## Phase 3: Plan Review Loop（hook自動実行）

`plan.md` 書き込みを `plan-review-automation` hook が検知し自動レビュー。

**hook の動作:**
1. plan.md のハッシュを計算、前回と比較（変更なしならスキップ）
2. tmux review ウィンドウを新規作成、別プロセスの `claude` CLI でレビュー:
   ```bash
   tmux new-window -t work -n review
   tmux send-keys -t work:review \
     "claude --print --system-prompt '$(cat $WORKFLOW_DIR/.review-prompt)' \
       'ファイルを読んでレビューしてください: $WORKFLOW_DIR/research.md $WORKFLOW_DIR/plan.md' \
       > $WORKFLOW_DIR/review-round-$ROUND.md" Enter
   ```
3. 結果を plan.md に書き戻し: `<!-- auto-review: verdict=pass|needs_revision; hash=<sha256>; round=N -->`
4. review ウィンドウを `tmux kill-window -t work:review` で閉じる

**レビュー6観点**: 完全性 / 具体性 / 順序妥当性 / リスク対応 / 確認網羅性 / スコープ適切さ

**制御**:
- pass → Plan Status: complete → ユーザーに承認を求める
- needs_revision → 指摘反映（→ 次の hook トリガー）、Round インクリメント
- 最大3ラウンド（超過時はユーザーに提示）
- 各ラウンド結果は `$WORKFLOW_DIR/review-round-N.md` に保存

**Hash 整合性**: Approval 時に plan.md のハッシュとマーカー内ハッシュを比較。不一致なら再レビュー自動トリガー。

## Phase 4: Approval（承認）

**CRITICAL: 承認は人間のみ。** Claude の自己承認禁止。承認前の実装着手禁止。

plan.md を fresh でユーザーに提示し、承認を求める（ツール選択基準は `rules/pane-strategy.md` 参照）。

## Phase 5: Implement（実装）

前提: Plan Status=complete, Review Status=pass, Approval Status=approved

1. plan.md のステップを順に実行、完了ごとにチェック更新
2. **plan に書かれていないことはやらない。** リファクタ、改善、「ついでに」の修正は実装スコープ外
3. 計画外の変更が必要な場合: 軽微→実施し plan に追記 / 中程度以上→中断し plan 更新・再レビュー検討
4. 全ステップ完了後、Phase 6（Verify）に自ら進む。ユーザーに確認を委ねず、自分で動作確認まで完走する

## Phase 6: Verify Loop（動作確認）

plan.md の確認項目を全実行。pane 2 でコマンド送信・結果取得:
```bash
tmux send-keys -t work:main.2 'npm run test' Enter
tmux capture-pane -t work:main.2 -p
```

- PASS / FAIL / SKIP(手動確認) で記録
- FAIL → 原因特定・修正 → **全項目**再実行
- 最大5リトライ（超過時はユーザーに報告）
- 結果は `$WORKFLOW_DIR/verify-results.md` に記録

## Phase 7: Completion（完了）

全ステップ完了 + 全確認 PASS/SKIP → Plan Status: done
作業サマリー報告（変更概要/確認結果/SKIP手動確認依頼/フォローアップ）。

---

## Implementation Guard

plan.md の Approval=approved, Review=pass, hash一致を満たさない限り:
- `$WORKFLOW_DIR` 外へのソースコード書き込みをブロック
- 実装系 Bash をブロック
- research.md / plan.md 自体の編集は常に許可

## Task Completion Protocol

作業停止前の必須チェック: タスク完全達成 / テスト・ビルド成功 / コミット依頼完了
失敗中・次ステップあり・コミット未完了 → 継続。ユーザー期待値を一方的に下げない。

## 環境変数

`WORKFLOW_DIR`: 成果物出力先（未設定時は `.workflow/`）
