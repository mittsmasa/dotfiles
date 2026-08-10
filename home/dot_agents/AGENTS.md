# 共有ルール（Claude Code / Copilot CLI / Codex CLI 共通）

このファイルは複数のコーディングエージェントで共有する。エージェント固有の実行機構（hook、スラッシュコマンド等）への言及がある箇所は、そのエージェント上でのみ有効。他のエージェントは該当箇所を読み飛ばして構わない。

正本はこのファイル（`~/.agents/AGENTS.md`）。各エージェントからはすべて symlink で参照する（`~/.claude/rules/AGENTS.md`, `~/.codex/AGENTS.md`, `~/.copilot/instructions/AGENTS-shared.instructions.md`）。**編集は必ずこの実体ファイルに対して行う。**

## skills の編集について

このファイル配下と `skills/` の実体はすべて `~/.agents/` 以下にある。各エージェントの `skills/` ディレクトリ（`~/.claude/skills/`, `~/.codex/skills/` 等）はそこへのシンボリックリンク。

**skill を編集するときは、必ず実体パス（`~/.agents/skills/<name>/...`）を直接開いて編集する。** シンボリックリンク経由のパス（例: `~/.claude/skills/<name>/...`）で編集すると、dotfiles 管理ツール（chezmoi）が変更を検知できず、同期が静かに漏れることがある。

## Worktree 運用ルール

### 基本フロー

別ブランチで独立した作業をしたいときは、リポジトリで以下を実行する。

```sh
git worktree add <repo>/.claude/worktrees/<name> -b worktree-<name>
```

その後、tmux / cmux なら別ペインで対話エージェントを起動して並走させる。bare 環境ならターミナルを別途立ち上げる。

（Claude Code では SessionStart hook `~/.claude/scripts/detect-multiplexer.sh` が新しい worktree 配下に `.serena/` と `.env.local` 系をメインリポジトリから自動コピーする。他エージェントにこの自動コピー機構はないため、必要なら手動でコピーする。）

### 使いどころ

- 独立した複数タスクを並走させたいとき
- 本流ブランチに触れず試したい変更があるとき

### 終了と cleanup

作業終了後は以下のいずれかで処理する。

- PR 化してマージ後に `git worktree remove <path>` / `git branch -d worktree-<name>`
- 破棄するなら `git worktree remove <path>` / `git branch -D worktree-<name>`

### 注意

`.env.local` 系には秘密情報が含まれる可能性がある。worktree 配下の設定ファイルコピー先は gitignore 済みであるべき。

## ペイン・ツール使い分け

### 判断軸

**エージェント消費・バックグラウンドで動かす処理は cmux/tmux ペインに逃がす。**

### 使い分け表

| 場面 | ツール |
|---|---|
| 自動レビュー・サブエージェント | cmux/tmux ペイン |
| dev server / watch 常駐 | tmux ペイン |
| テスト・ビルド + 結果回収 | tmux ペイン |

### 別ペイン操作の原則

- `send` には必ず Enter/`\n` を含める(送るだけでは実行されない)
- 起動が重いプロセス(claude/codex/node/docker)は `capture-pane` / `read-screen` でプロンプト確認後に次を送る
- 対話的 CLI/TUI は別ペインで起動して `send` で操作

具体コマンドは `cmux --help` / `tmux` のマニュアルを参照。

## chezmoi ルール

### 前提

`~/.claude/` 配下など chezmoi 管理下のファイルを編集すると、Claude Code では PostToolUse hook が自動で `chezmoi re-add` → commit → pull --rebase → push する。**Claude Code ではこの自動同期を手動で叩く必要はない**（エラー時除く）。他エージェントにはこの自動化はないため、編集後は手動で `chezmoi re-add` / `chezmoi apply` を実行する。

### 守ること

- chezmoi 管理ファイルを編集する前に `chezmoi git -- pull --rebase` を一度実行
- 既存管理下ファイル更新は `chezmoi re-add`。**`chezmoi add` は使わない**（テンプレートを上書きするおそれがある）。新規追加だけ `chezmoi add`

### 同期エラー時の対応

- **pull --rebase failed** → `chezmoi git -- status` で状態確認、ユーザーに相談
- **push failed** → 認証/ネットワーク障害の可能性、ユーザーに報告
- **re-add failed** → `chezmoi diff` で差分確認しユーザーに報告

## Autonomy Rules

### 基本方針

**迷ったら進める。** 止まるのは下記「止まるべき場面」のみ。グレーは前進側に倒す。

### 止まるべき場面(該当時のみ承認待ち)

#### 1. 破壊的操作
- ファイル/ディレクトリ削除(`rm -rf` 等)
- `git push --force`, `git reset --hard`, `git branch -D`, `git clean -f`
- uncommitted 変更の上書き
- DB の DROP / TRUNCATE
- 共有プロセスの kill

#### 2. 外部に影響する操作
- `git push`
- PR / Issue の作成・クローズ・コメント
- Slack / メール / 送信系
- 外部 API への書き込み
- 共有インフラ・権限の変更
- 外部 web へのアップロード(pastebin, gist, 図表レンダラ等)

#### 3. 設計判断
- アーキテクチャ選択 / 大きなリファクタ方針
- 新規依存パッケージ追加
- 既存 API の破壊的変更

#### 4. 要件が曖昧
- 複数解釈可能 / 「何をしたいか」が読み取れない / 仕様中核の想定確認が必要

これら以外は聞かずに進める。

### 報告と承認の分離

報告は非ブロッキング。

- **報告**: 過去形・宣言形(「やりました」「次は X」)
- **承認要請**: 「止まるべき場面」該当時のみ
- ユーザーが「待って」と言えば止まる。無言なら進む

### 一時オーバーライド

- 「止まらず一気にやって」「聞かずに進めて」: 設計判断・要件曖昧を一時スキップ。破壊的操作・外部影響は依然確認
- 「慎重に進めて」「都度確認して」: default に戻る

（Claude Code では、フルフローと判定したタスクの実装着手には人間承認が別途必須。詳細は Claude Code 側の workflow ルールを参照。）

## git commit 時に GPG(secretive) 署名で失敗する場合

`git commit` が secretive 経由の GPG 署名で失敗する(agent が対話シェルでなく `.zshrc` が読み込まれていない等)ときは、まず `.zshrc` を読み込んでから commit し直す。リポジトリ固有の問題ではなく、シェル環境依存のため毎回この対処でよい。

```sh
source ~/.zshrc && git commit -m "..."
```

これで解決しない場合のみユーザーに報告する。
