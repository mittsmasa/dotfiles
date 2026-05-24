# ペイン・ツール使い分け

## 判断軸

**「その出力を人間が判断するか」が分岐。** 人間に読ませる → fresh / 計画書承認・差分 → difit / エージェント消費・バックグラウンド → cmux/tmux ペイン。

## 使い分け表

| 場面 | ツール |
|---|---|
| plan.md 承認 / 編集後の再提示 | difit（編集ごとに開き直す） |
| ファイルを人間に読ませる | fresh |
| コード箇所のピンポイント提示 | fresh (`file:line:col@"msg"`) |
| 自動レビュー・サブエージェント | cmux/tmux ペイン |
| dev server / watch 常駐 | tmux ペイン |
| テスト・ビルド + 結果回収 | tmux ペイン |

## ワークフロー対応

- Phase 3 自動レビュー: cmux/tmux ペイン
- Phase 4 人間承認: difit（plan.md 編集ごとに開き直す）
- Phase 6 動作確認: cmux/tmux ペイン
- Phase 7 SKIP 項目提示: fresh

## 別ペイン操作の原則

- `send` には必ず Enter/`\n` を含める（送るだけでは実行されない）
- 起動が重いプロセス（claude/node/docker）は `capture-pane` / `read-screen` でプロンプト確認後に次を送る
- 対話的 CLI/TUI は別ペインで起動して `send` で操作
- Claude TUI に長文を送って submit が効かないときは `load-buffer` → `paste-buffer` → `C-m`（`Enter` は改行扱い）

具体コマンドは `using-cmux` skill 参照。

## 注意

「人間に見せる」と「エージェント使用」が両方あるケースは、tmux で実行・結果回収し、判断箇所だけ fresh で示す。
