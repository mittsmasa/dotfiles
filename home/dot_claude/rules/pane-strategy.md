# ペイン・ツール使い分けルール

## 判断の軸

**「その出力を人間が読んで判断するか」が分岐点。**

- 人間に読ませたい（ファイル全体）→ **fresh**
- 計画書承認・差分確認 → **difit**
- エージェント消費 / バックグラウンド実行 → **cmux / tmux ペイン**

## 使い分け表

| 場面 | ツール | 理由 |
|---|---|---|
| plan.md の承認 / 編集後の再提示 | difit | 差分が読みやすい（`workflow.md` Phase 4 参照） |
| ファイルをユーザーに読ませる（コードレビュー依頼） | fresh | 人間が判断する |
| コード箇所のピンポイント提示 | fresh (`file:line:col@"msg"`) | 注意を向ける |
| 自動レビュー・サブエージェント | cmux / tmux ペイン | エージェント間 |
| dev server / watch 常駐 | tmux ペイン | バックグラウンド |
| テスト・ビルド実行 + 結果回収 | tmux ペイン | コマンド実行 + 出力取得 |

## ワークフローでの適用例

- Phase 3（自動レビュー）: tmux / cmux ペイン
- Phase 4（人間承認）: difit。**plan.md 編集ごとに開き直す**
- Phase 6（動作確認）: tmux / cmux ペイン
- Phase 7（完了報告）: SKIP 項目があれば fresh で提示

## 別ペイン操作の実践

### send には必ず Enter を含める

送るだけでは実行されない。明示的に Enter / `\n` を含める。

```bash
tmux send-keys -t <target> 'echo hi' Enter
cmux send --surface surface:N $'echo hi\n'
```

### 前のコマンド完了を確認してから次を送る

起動に時間がかかるプロセス（claude / node / docker 等）を send したら、`tmux capture-pane` / `cmux read-screen` でプロンプトを確認してから次を送る。確認せずに送ると入力が結合する。

### 対話的 CLI / TUI は別ペインで操作する

envchain の対話入力や claude TUI などはメインから触れない。別ペインで起動して send で操作する。

### Claude Code TUI への長文 submit

別ペインの Claude TUI に長文（複数行・日本語混じり）を `send-keys 'text' Enter` で送ると、テキストは入るが submit されないことがある（Enter が改行として扱われる）。確実な手順:

```bash
tmux send-keys -t <target> Escape Escape          # 既存入力をクリア
printf '%s' "$PROMPT" | tmux load-buffer -        # ペーストバッファに載せる
tmux paste-buffer -t <target>
sleep 1
tmux send-keys -t <target> C-m                    # C-m で submit（Enter ではなく）
```

短い英数字 1 行なら `send-keys 'text' Enter` で十分。長文で submit が効かないときに切り替える。

## 注意

「人間に見せる」と「エージェントが使う」が両方あるケースでは、まず tmux で実行・結果回収し、判断を仰ぐ箇所だけ fresh で示す。
