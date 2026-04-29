# ペイン・ツール使い分けルール

## 判断の軸

**「その出力を人間が読んで判断するか」が分岐点。**

- 人間の目に触れさせたい（ファイル全体を読ませる） → **fresh**
- 計画書（plan.md）の承認・編集差分の確認 → **difit**
- エージェントが消費する / バックグラウンド実行 → **cmux / tmux ペイン**

## 使い分け表

| 場面 | ツール | 理由 |
|---|---|---|
| **plan.md の承認 / 編集後の再提示** | **difit** | 差分ビューが読みやすい。詳細は `rules/workflow.md` Phase 4 |
| ユーザーにファイルを読んでもらう（コードレビュー依頼など） | fresh | 人間が内容を読んで判断する |
| ユーザーにコード箇所を示す（質問、注意喚起） | fresh (`file:line:col@"msg"`) | ピンポイントで注意を向ける |
| 自動レビュー・サブエージェント起動 | cmux / tmux ペイン | エージェント間のやりとり |
| dev server / watch 常駐 | tmux ペイン | バックグラウンドプロセス |
| テスト・ビルド実行と結果回収 | tmux ペイン | コマンド実行 + 出力取得 |

## ワークフローでの適用例

- **Phase 3（自動レビュー）**: tmux review ウィンドウ — エージェントが plan を評価する場面
- **Phase 4（人間承認）**: **difit** で plan.md を提示 — 人間が差分ビューで読んで承認する場面。**plan.md が編集されるたびに difit を開き直す**（古い内容で承認される事故を防ぐ）
- **Phase 6（動作確認）**: tmux ペイン — テスト実行と結果回収
- **Phase 7（完了報告）**: SKIP 項目がある場合、該当箇所を fresh で提示

## 別ペイン操作の実践ルール（cmux / tmux 共通）

### send では必ず Enter を含める

コマンドを送るだけでは入力されるだけで実行されない。明示的に Enter を送ること。

```bash
# cmux
cmux send --surface surface:N $'echo hello\n'     # OK: \n が Enter
# tmux
tmux send-keys -t work:main.1 'echo hello' Enter   # OK: Enter を明示
```

### 前のコマンドの完了を確認してから次を送る

起動に時間がかかるプロセス（claude, node, docker 等）を send した後は、画面を読み取って起動完了を確認してから次の入力を送る。確認せずに送ると、前のコマンドと結合されたり、シェルプロンプトに誤入力される。

```bash
# cmux
cmux send --surface surface:N $'claude\n'
# read-screen で ❯ プロンプト表示を確認してから次を送る
cmux send --surface surface:N $'hello\n'

# tmux
tmux send-keys -t work:main.1 'claude' Enter
# capture-pane で ❯ プロンプト表示を確認してから次を送る
tmux send-keys -t work:main.1 'hello' Enter
```

### 対話的 CLI は別ペインで操作する

envchain --set のようなインタラクティブ入力が必要なツールや、claude のような TUI は、別ペインで起動して send で操作する。メインの Claude Code セッションからは対話的入力ができないが、別ペイン経由なら send/send-key で操作できる。

### Claude Code TUI に長文プロンプトを送るときは paste-buffer + C-m

別ペインで動いている Claude Code TUI（`claude --worktree` 等）に長文プロンプトを送るとき、`tmux send-keys 'long text' Enter` は **テキストは入るが submit されない** ことがある（特に日本語混じり・複数行・長文）。`Enter` キーを Claude TUI が改行として扱うため。

確実に動く手順:

```bash
# 1. 既存の入力をクリア
tmux send-keys -t '<target>' Escape Escape

# 2. プロンプト本文を tmux のペーストバッファ経由で貼り付け
printf '%s' "$PROMPT" | tmux load-buffer -
tmux paste-buffer -t '<target>'

# 3. C-m で submit（Enter ではなく C-m / キャリッジリターンの raw 信号）
sleep 1
tmux send-keys -t '<target>' C-m

# 4. 受信確認
sleep 3
tmux capture-pane -t '<target>' -p -S -20  # Infusing... 等が出ていれば OK
```

**短い 1 行の英数字コマンド** なら `send-keys 'text' Enter` で済む（シェルへの送信や cmux と同じ）。**Claude TUI に対する数行以上のプロンプト** で submit が効かなかったら、即この方式に切り替える。

## 注意

- 「人間に見せる」と「エージェントが使う」が両方あるケース（例: テスト失敗の原因をユーザーに相談）では、まず tmux で実行・結果回収し、判断を仰ぐ必要がある箇所だけ fresh で示す
- ワークフロー外（直接実行モード、簡易フロー）でもこの基準は同じ
