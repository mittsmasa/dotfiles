# ペイン・ツール使い分け

## 判断軸

**エージェント消費・バックグラウンドで動かす処理は cmux/tmux ペインに逃がす。**

## 使い分け表

| 場面 | ツール |
|---|---|
| 自動レビュー・サブエージェント | cmux/tmux ペイン |
| dev server / watch 常駐 | tmux ペイン |
| テスト・ビルド + 結果回収 | tmux ペイン |

## ワークフロー対応

- Phase 3 自動レビュー: cmux/tmux ペイン
- Phase 6 動作確認: cmux/tmux ペイン

## 別ペイン操作の原則

- `send` には必ず Enter/`\n` を含める（送るだけでは実行されない）
- 起動が重いプロセス（claude/node/docker）は `capture-pane` / `read-screen` でプロンプト確認後に次を送る
- 対話的 CLI/TUI は別ペインで起動して `send` で操作
- Claude TUI に長文を送って submit が効かないときは `load-buffer` → `paste-buffer` → `C-m`（`Enter` は改行扱い）

具体コマンドは `using-cmux` skill 参照。
