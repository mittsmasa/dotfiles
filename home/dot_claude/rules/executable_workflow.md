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

## ペイン戦略

ターミナルマルチプレクサ（tmux / cmux）が利用可能な場合、以下のペイン構成を使う。
bare 環境ではペイン分割なしで直接実行する。

| ペイン | 用途 | フェーズ |
|---|---|---|
| main.0 | Claude Code メイン | 全フェーズ |
| main.1 | dev server / watch 常駐 | implement, verify |
| main.2 | 動作確認コマンド実行 | verify |

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

## Phase 3: Plan Review Loop（hook自動実行・マルチエージェント並列）

`plan.md` 書き込みを PostToolUse hook (`~/.claude/scripts/plan-review-hook.sh`) が検知し、**3 本のレビュアを並列実行**して観点ごとに判定する。
環境に依存せず動作する（tmux / cmux / bare いずれでも可）。

**3 レビュアの責務分担**（プロンプトは `~/.claude/scripts/plan-review-prompts/<name>.md`）:

| レビュア | 観点 | 特性 |
|---|---|---|
| **simplicity** | YAGNI / 過剰実装 / 不要な抽象・fallback / 計画外スコープ / 削れるステップ | **veto 権あり**: fail なら他がどうあれ needs_revision |
| **correctness** | 影響範囲の漏れ / 順序 / 前提 / リスク対応 / 副作用 / 境界エラー | |
| **verifiability** | 確認項目の実行可能性 / 期待結果の定量性 / 網羅性 / SKIP 妥当性 | |

**hook の動作:**
1. plan.md のハッシュを前回と比較（変更なしならスキップ）
2. 3 本の `claude --print` をバックグラウンド起動 → `wait`
3. 各レビュアの出力から JSON を抽出（コードフェンス対応・素 JSON・抽出フォールバック）
4. **壊れた結果は捨てる**: claude 実行失敗 / JSON パース不能 / verdict 欠落の場合、そのレビュアは `skipped` 扱い。残りで判定
5. **aggregator**:
   - 全レビュア skipped → `verdict=error`
   - simplicity が needs_revision → `needs_revision`（veto）
   - 他のレビュアが needs_revision → `needs_revision`
   - 上記以外 → `pass`
6. plan.md に書き戻し: `<!-- auto-review: verdict=...; hash=...; round=N; skipped=[a,b]; failed=[c] -->`
   - **捨てたレビュアは `skipped=[]` に名指しで残る**ので、ユーザーは何が判定に使われなかったか把握できる

**制御**:
- pass → Plan Status: complete → ユーザーに承認を求める
- needs_revision → 指摘反映（→ 次の hook トリガー）、Round インクリメント
- error（全 skipped）→ ユーザーに報告、Round はインクリメントしつつ放置
- 最大3ラウンド（超過時はユーザーに提示）
- 集約レポートは `$WORKFLOW_DIR/review-round-N.md`、各レビュアの生 JSON は `review-round-N-<name>.json` に保存

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

plan.md の確認項目を全実行。マルチプレクサが利用可能なら別ペインで、なければ直接 Bash で実行:
```bash
# tmux の場合
tmux send-keys -t work:main.2 'pnpm run test' Enter
tmux capture-pane -t work:main.2 -p

# cmux の場合
cmux send --pane <id> 'pnpm run test'
cmux read-screen --pane <id>

# bare の場合
# Bash ツールで直接実行
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
