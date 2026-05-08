# Worktree 運用ルール

## 基本フロー

別ブランチで独立した作業をしたいときは、リポジトリで以下を実行する。

```sh
git worktree add <repo>/.claude/worktrees/<name> -b worktree-<name>
```

その後、tmux / cmux なら別ペインで `claude` を起動して並走させる。bare 環境ならターミナルを別途立ち上げる。

SessionStart hook (`~/.claude/scripts/detect-multiplexer.sh`) が新しい worktree 配下に `.serena/` と `.env.local` 系をメインリポジトリから自動コピーする（冪等）。**Claude が手動でコピーする必要はない。**

## 使いどころ

- 独立した複数タスクを並走させたいとき（`rules/autonomy.md` の並列化条件参照）
- 本流ブランチに触れず試したい変更があるとき

## 終了と cleanup

作業終了後は以下のいずれかで処理する。

- PR 化してマージ後に `git worktree remove <path>` / `git branch -d worktree-<name>`
- 破棄するなら `git worktree remove <path>` / `git branch -D worktree-<name>`

## 注意

`.env.local` 系には秘密情報が含まれる可能性がある。コピー先の `.claude/worktrees/` は gitignore 済みであるべき。新しい種類の設定ファイルをコピーしたい場合は `detect-multiplexer.sh` の worktree_bootstrap を拡張する。
