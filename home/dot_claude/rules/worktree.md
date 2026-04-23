# Worktree 運用ルール

## 基本フロー

別ブランチで独立した作業をしたいときは `claude --worktree <name>` を使う。メインセッションはそのままに、別ペインで独立した Claude セッションを起動して並走させる。

起動は `/wt` skill 経由で行う。skill が cmux / tmux を判定してペイン分割 → `claude --worktree <name>` を流す。

```text
メインセッション ──[/wt <name>]──▶ 右ペインで claude --worktree <name>
                                   │
                                   ├─ <repo>/.claude/worktrees/<name>/ が作成される
                                   ├─ ブランチ worktree-<name> が切られる
                                   └─ SessionStart hook が .serena / .env.local を自動コピー
```

## SessionStart hook による自動コピー

`~/.claude/scripts/detect-multiplexer.sh` が SessionStart 時に以下を行う:

- cwd に `.claude/worktrees/` が含まれるかで worktree 判定
- 該当した場合、`git worktree list --porcelain` でメインリポジトリを特定
- `.serena/` が main にあり、worktree になければコピー
- `.env.local` 系（`**/.env.local`, `**/.env.*.local`）も同様に `git ls-files --others --ignored --exclude-standard` 経由で検出してコピー
- コピーは冪等。既に存在すればスキップ。失敗しても stderr に warning を出すのみで hook 自体は成功扱い

**Claude が手動でコピー操作をする必要はない。** hook が裏で済ませている前提で作業を始めてよい。

## /wt の使いどころ

- ユーザーから明示的に `/wt <name>` を受けたとき
- 独立した複数タスクを並走させたいとき（`rules/autonomy.md` の並列化条件参照）
- 本流ブランチに触れず試したい変更があるとき

## 環境別の前提

| 環境 | ペイン分割 | /wt 挙動 |
|---|---|---|
| Mac (cmux) | `cmux new-split right` + `cmux send` の 2 段階 | 右ペインで起動 |
| WSL/Linux (tmux) | `tmux split-window -h 'claude --worktree <name>'` で 1 段階 | 右ペインで起動 |
| bare (multiplexer なし) | 利用不可 | エラーメッセージで案内 |

## 衝突時の扱い

`/wt <name>` 実行前に `git worktree list` でチェックする。既存の場合:
- 同名 worktree に入り直すか
- 別名を付けるか
- `git worktree remove` してから切り直すか

をユーザーに確認する。勝手に上書きしない。

## 終了と cleanup

`claude --worktree` セッションを終了すると、変更がない場合は worktree ディレクトリとブランチが自動 cleanup される。変更があった場合は残るので、後から:
- PR にしてマージ
- `git worktree remove <path>` で手動削除
- 必要ならブランチも `git branch -D worktree-<name>`

のどれかで処理する。

## 並列化ポリシー（要約）

- 独立した 2+ タスクが明示的に依頼された場合、Claude は `/wt` を複数回呼んで並列 worktree を作ってよい
- 上限は 3 並列。4 以上は事前にユーザーに確認する
- 詳細は `rules/autonomy.md`

## 注意

- `.env.local` 系にはローカル固有の秘密情報が含まれる可能性がある。コピー先（worktree ディレクトリ）が gitignore されていることを前提とする（`.claude/worktrees/` はプロジェクトで ignore 済みであるべき）
- hook が新しい種類の gitignore 対象設定ファイルをコピーできるようにしたい場合は、`detect-multiplexer.sh` の worktree_bootstrap を拡張する
