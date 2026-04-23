---
name: wt
description: "git worktree を切って別ペインで Claude セッションを起動する。cmux / tmux 環境で `claude --worktree <name>` を並走させたいときにトリガー。キーワード: 'worktree' '別ペインで作業' 'ワークツリーを切って' '並列で作業' '/wt'。"
---

# wt

`claude --worktree <name>` を別ペインで起動する skill。メインのセッションはそのまま、worktree 側で独立した作業を並走させるためのもの。

## 前提

- カレントディレクトリは git リポジトリ内であること
- ターミナルは cmux か tmux のいずれか（bare 環境では使えない）
- `claude --worktree <name>` は `<repo>/.claude/worktrees/<name>/` にディレクトリを作り、`worktree-<name>` ブランチで session を開始する
- `.serena/` と `.env.local` 系は SessionStart hook (`detect-multiplexer.sh`) が自動コピーするので、skill 側では何もしない

## 引数

`<name>` — worktree 名。省略された場合はユーザーに命名を確認する（例: `issue-123`, `feat-auth-rewrite`）。スラッシュや空白は避ける。

## 手順

### 1. 環境チェック

```bash
# git リポジトリかどうか
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "Not a git repository"; exit 1; }

# マルチプレクサ判定
if [ -n "${CMUX_SOCKET_PATH:-}" ]; then
  MPLEX=cmux
elif [ -n "${TMUX:-}" ]; then
  MPLEX=tmux
else
  echo "Neither cmux nor tmux detected. Start one and re-launch Claude inside it."
  exit 1
fi
```

bare 環境だった場合、ユーザーに「cmux または tmux のセッション内で Claude を起動してください」と案内して終わる。

### 2. 同名 worktree の衝突チェック

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
TARGET="$REPO_ROOT/.claude/worktrees/<name>"

if git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' | grep -Fxq "$TARGET"; then
  echo "worktree already exists: $TARGET"
  # 既存 worktree に入る選択肢をユーザーに提示してよい
fi

if git show-ref --verify --quiet "refs/heads/worktree-<name>"; then
  echo "branch already exists: worktree-<name>"
fi
```

衝突があった場合は、ユーザーに以下を確認する:
- 既存 worktree に入る（= 新規ペインで既存の worktree ディレクトリを開くだけ）
- 別名にする
- cleanup してから切り直す

### 3. 別ペインで起動

#### cmux の場合

```bash
# 右側に分割
cmux new-split right
# 直前に作成された surface を取得
SURFACE=$(cmux list-panes | awk 'END{print $1}')  # 実際には identify + list-panes で最新を確認

# claude --worktree を起動
cmux send --surface "$SURFACE" $'claude --worktree <name>\n'
```

実運用では using-cmux skill を参照し、`cmux identify` / `cmux list-panes` で surface を正確に特定してから `send` すること。

#### tmux の場合

```bash
# 右側に分割して直接 claude を起動
tmux split-window -h "claude --worktree <name>"
```

`split-window` の引数にコマンドを渡せばそのまま起動できる。cmux と違って 2 段階にしなくて済む。

### 4. 起動確認

起動直後は TUI が描画される前なので、少し待ってから画面を読む。

- cmux: `cmux read-screen --surface "$SURFACE"` で `❯` プロンプトや welcome 表示を確認
- tmux: `tmux capture-pane -t <target> -p` で確認

起動が確認できなければ一度待機してから再読取り。3 回試して失敗するようなら、ユーザーに状況を報告する。

### 5. 完了報告

- worktree 名、起動したペインの識別子（surface / pane index）、ブランチ名 (`worktree-<name>`) を報告
- ユーザーが別ペインに切り替えて作業できる状態になったことを伝える

## 並列起動

独立した複数タスクが依頼されたとき、この skill を複数回呼んで並列 worktree を作ってよい（上限は `rules/autonomy.md` を参照）。

並列起動する場合:
- 各 worktree に明確に異なる名前を付ける（例: `feat-a`, `feat-b`）
- cmux なら `new-split` で連続して右ペインを分割、tmux なら `split-window -h` を複数回
- 各セッションにどのサブタスクを任せるかを、起動直後の `send` で明示的に伝える

## Notes

- `claude --worktree` は終了時に変更がなければ worktree ディレクトリとブランチを自動 cleanup する。変更があれば残るので、後から `git worktree remove` するなり PR にするなりで処理する
- `--tmux` オプションは iTerm2 native pane を使う別系統。このワークフローでは採用していない（現状 cmux / tmux ペインで統一している）
- メインセッションから別ペインで起動した Claude は独立したセッション。メインセッションのコンテキストは引き継がれないので、タスク内容は起動時の `send` で明示的に渡すこと
