# ペイン・ツール使い分けルール

## 判断の軸

**「その出力を人間が読んで判断するか」が分岐点。**

- 人間の目に触れさせたい → **fresh**
- エージェントが消費する / バックグラウンド実行 → **cmux / tmux ペイン**

## 使い分け表

| 場面 | ツール | 理由 |
|---|---|---|
| ユーザーにファイルを読んでもらう（plan 承認、差分確認、コードレビュー依頼） | fresh | 人間が内容を読んで判断する |
| ユーザーにコード箇所を示す（質問、注意喚起） | fresh (`file:line:col@"msg"`) | ピンポイントで注意を向ける |
| 自動レビュー・サブエージェント起動 | cmux / tmux ペイン | エージェント間のやりとり |
| dev server / watch 常駐 | tmux ペイン | バックグラウンドプロセス |
| テスト・ビルド実行と結果回収 | tmux ペイン | コマンド実行 + 出力取得 |

## ワークフローでの適用例

- **Phase 3（自動レビュー）**: tmux review ウィンドウ — エージェントが plan を評価する場面
- **Phase 4（人間承認）**: fresh で plan.md を提示 — 人間が読んで承認する場面
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

## 注意

- 「人間に見せる」と「エージェントが使う」が両方あるケース（例: テスト失敗の原因をユーザーに相談）では、まず tmux で実行・結果回収し、判断を仰ぐ必要がある箇所だけ fresh で示す
- ワークフロー外（直接実行モード、簡易フロー）でもこの基準は同じ
