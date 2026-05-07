# ペイン・ツール使い分けルール

## 判断の軸

**「その出力を人間が読んで判断するか」が分岐点。**

- 人間に読ませたい（ファイル全体）→ **fresh**
- 計画書承認・差分確認 → **difit**
- エージェント消費 / バックグラウンド実行 → **cmux / tmux ペイン**

## 使い分け表

| 場面 | ツール |
|---|---|
| plan.md の承認 / 編集後の再提示 | difit（編集ごとに開き直す） |
| ファイルをユーザーに読ませる | fresh |
| コード箇所のピンポイント提示 | fresh (`file:line:col@"msg"`) |
| 自動レビュー・サブエージェント | cmux / tmux ペイン |
| dev server / watch 常駐 | tmux ペイン |
| テスト・ビルド + 結果回収 | tmux ペイン |

## ワークフローでの適用

- Phase 3（自動レビュー）: tmux / cmux ペイン
- Phase 4（人間承認）: difit、plan.md 編集ごとに開き直す
- Phase 6（動作確認）: tmux / cmux ペイン
- Phase 7（SKIP 項目の提示）: fresh

## 別ペイン操作の原則

- `send` には必ず Enter / `\n` を含める（送るだけでは実行されない）
- 起動に時間がかかるプロセス（claude / node / docker 等）は `capture-pane` / `read-screen` でプロンプトを確認してから次を送る
- 対話的 CLI / TUI（envchain, claude TUI 等）は別ペインで起動して send で操作
- Claude TUI に長文を送って submit が効かないときは、`load-buffer` → `paste-buffer` → `C-m` で送る（`Enter` だと改行扱いになる）

具体的な tmux / cmux コマンドは `using-cmux` skill 側を参照。

## 注意

「人間に見せる」と「エージェントが使う」が両方あるケースでは、まず tmux で実行・結果回収し、判断を仰ぐ箇所だけ fresh で示す。
