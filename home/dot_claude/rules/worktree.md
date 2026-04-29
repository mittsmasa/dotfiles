# Worktree 運用ルール

## 基本フロー

別ブランチで独立した作業をしたいときは `/wt <name>` skill を使う。skill が cmux / tmux を判定してペインを切り、`claude --worktree <name>` を起動する。メインセッションはそのまま、別ペインで独立した Claude セッションが走る。

`<repo>/.claude/worktrees/<name>/` が作られ、ブランチ `worktree-<name>` が切られる。SessionStart hook (`~/.claude/scripts/detect-multiplexer.sh`) が `.serena/` と `.env.local` 系をメインリポジトリから自動コピーする（冪等）。**Claude が手動でコピーする必要はない。**

## /wt の使いどころ

- ユーザーから明示的に `/wt <name>` を受けたとき
- 独立した複数タスクを並走させたいとき（`rules/autonomy.md` の並列化条件参照）
- 本流ブランチに触れず試したい変更があるとき

衝突時の扱い・環境別の前提（cmux / tmux / bare）は `/wt` skill 側のドキュメント参照。

## 終了と cleanup

`claude --worktree` 終了時、変更がない worktree は自動 cleanup。変更があった場合は残るので、PR 化 / `git worktree remove <path>` / `git branch -D worktree-<name>` のいずれかで処理する。

## 注意

`.env.local` 系には秘密情報が含まれる可能性がある。コピー先の `.claude/worktrees/` は gitignore 済みであるべき。新しい種類の設定ファイルをコピーしたい場合は `detect-multiplexer.sh` の worktree_bootstrap を拡張する。
