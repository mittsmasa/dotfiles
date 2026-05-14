---
name: tmux
description: |
  tmux セッション・ペイン・ウィンドウを Bash 経由で操作するスキル。
  新しいペインで Claude Code を起動したり、dev server を別ペインで
  実行・監視したり、ペインの出力を取得したりできる。

  トリガー: 「tmux」「ペイン」「ペインを作って」「別ペインで」
  「dev server 起動して」「ペインの出力見せて」「並列で作業」
  「新しいペインで claude」「ペイン確認」
---

# tmux 操作スキル

Bash ツールで tmux コマンドを実行し、ペイン・ウィンドウ・セッションを管理する。

## 前提確認

操作前に必ず実行:

```bash
echo $TMUX
tmux list-panes -F '#{pane_index}: #{pane_width}x#{pane_height} #{pane_current_command} #{pane_current_path}'
```

`$TMUX` が空 → tmux 外。ペイン操作不可。ユーザーに `tmux` 内で起動するよう案内する。

## コア操作

```bash
# ペイン分割
tmux split-window -h                             # 右に分割
tmux split-window -v                             # 下に分割
tmux split-window -h -c "/path/to/dir" -l 40%   # ディレクトリ・サイズ指定

# コマンド送信（C-m = Enter）
tmux send-keys -t .1 'pnpm run dev' C-m

# ペイン出力取得
tmux capture-pane -t .1 -p                # 表示中の内容
tmux capture-pane -t .1 -p -S -500        # 直近500行

# ウィンドウ操作
tmux new-window -n mywin -c /path/to/dir
tmux select-window -t mywin

# ペイン閉じる
tmux kill-pane -t .1

# 全ペイン状況
tmux list-panes -a -F '#{session_name}:#{window_index}.#{pane_index} #{pane_current_command} #{pane_current_path}'
```

ペイン指定: `.0` `.1` `.2`（現ウィンドウ内）、`{session}:{window}.{pane}`（完全指定）

## ワークフロー例

### 指定ディレクトリで新ペイン + Claude 起動

```bash
tmux split-window -h -c "/path/to/dir"
tmux send-keys -t '{next}' 'claude' C-m
```

### dev server を別ペインで起動・監視

```bash
tmux split-window -v -l 30%
tmux send-keys -t '{next}' 'pnpm run dev' C-m
# 数秒後に出力確認
tmux capture-pane -t .1 -p -S -50
```

### ペインの出力確認

```bash
tmux capture-pane -t .{index} -p -S -100
```

## 注意事項

- `send-keys` はキー入力シミュレーション。コマンド完了を待たない
- コマンド実行後は `capture-pane` で結果確認してから次の操作へ
- tmux 外から操作する場合は `tmux new-session -d -s dev` でセッション作成が先
