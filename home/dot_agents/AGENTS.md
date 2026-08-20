# 共有ルール（Claude Code / Copilot CLI / Codex CLI 共通）

このファイルは複数のコーディングエージェントで共有する。エージェント固有の実行機構（hook、スラッシュコマンド等）への言及がある箇所は、そのエージェント上でのみ有効。他のエージェントは該当箇所を読み飛ばして構わない。

正本はこのファイル（`~/.agents/AGENTS.md`）。ホーム直下の `~/AGENTS.md` が symlink として張ってあり、cwd から上に辿って `AGENTS.md` を探すタイプのエージェント（Codex CLI 等）はここで拾う。Claude Code は `~/.claude/CLAUDE.md` の `@~/AGENTS.md` 経由で読む。`~/.codex/` `~/.copilot/` は現在未作成 — それらを導入したら同じ実体への symlink を張る。**編集は必ずこの実体ファイルに対して行う。**

## ワークフロー必須（Claude Code）

タスクを受け取ったら、何よりも先に `~/.claude/rules/workflow.md` の Phase 0（規模判定）を実行する。調査・ツール呼び出し・エージェント起動はその後。

## skills の編集について

このファイル配下と `skills/` の実体はすべて `~/.agents/` 以下にある。各エージェントの `skills/` ディレクトリ（`~/.claude/skills/`, `~/.codex/skills/` 等）はそこへのシンボリックリンク。

**skill を編集するときは、必ず実体パス（`~/.agents/skills/<name>/...`）を直接開いて編集する。** シンボリックリンク経由のパス（例: `~/.claude/skills/<name>/...`）で編集すると、dotfiles 管理ツール（chezmoi）が変更を検知できず、同期が静かに漏れることがある。

**GitHub リポジトリから skill を導入するときは `gh skill install <owner>/<repo> --agent claude-code --scope user` を使う。** npm の `skills` パッケージは使わない。

## Worktree 運用ルール

### 基本フロー

別ブランチで独立した作業をしたいときは、リポジトリで以下を実行する。

```sh
git worktree add <repo>/.claude/worktrees/<name> -b worktree-<name>
```

その後、tmux なら別ペインで対話エージェントを起動して並走させる。bare 環境ならターミナルを別途立ち上げる。

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

**エージェント消費・バックグラウンドで動かす処理は tmux ペインに逃がす。**

### 使い分け表

| 場面 | ツール |
|---|---|
| 自動レビュー・サブエージェント | tmux ペイン |
| dev server / watch 常駐 | tmux ペイン |
| テスト・ビルド + 結果回収 | tmux ペイン |

### 別ペイン操作の原則

- `send` には必ず Enter/`\n` を含める(送るだけでは実行されない)
- 起動が重いプロセス(claude/codex/node/docker)は `capture-pane` でプロンプト確認後に次を送る
- 対話的 CLI/TUI は別ペインで起動して `send` で操作

具体コマンドは `tmux` のマニュアルを参照。

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

## 調査と主張

調べる深さは workflow.md Phase 1 の担当。ここは **調べた結果をどう述べるか** の規律。

### 存在しないと言う前に探す

- ツール / 機能 / API / 社内サービスが「存在しない」「対応していない」と述べる前に、リポジトリまたは org を grep し、**確認したファイルパスか URL を示す**
- 探して見つからなかったなら「grep したが見つからなかった（探索範囲: X）」と書く。「存在しない」と「見つけられなかった」を区別する

### 一次情報を引く

- サードパーティの挙動（claude.ai コネクタの認証方式、ベンダーの言語対応、ライブラリの API など）は、検索結果の要約ではなく**公式ドキュメントのページかコード本体**を引く
- 一次情報に当たれていないなら、断定せず「未検証」と明示する。未検証の情報の上に実装方針を積まない

### 車輪を再発明しない

- 自前ヘルパーを書く前に、標準ライブラリ / プラットフォーム API / 使用中ライブラリのドキュメントを探す（`URLSearchParams`、testing-library の `unhover(document.body)` 等）
- 「ドキュメントを探したが該当が無かったので自前で書く」なら、探した場所を書く

### 見積もりを出すとき

- **レビュー / QA の工数を必ず含める**。実装工数だけの見積もりは出さない
- 仕様書（Notion / issue）と実装のずれをコード上で見つけたら、見積もりに埋もれさせず独立した項目として指摘する

## 実装前の自問

- 実装前に「なぜこの変更が必要か」「なぜこの範囲か」を一文で言えるか自問し、言えないなら書かない
- 言えても、その一文をコードやコミットメッセージに書き足す必要はない。判断の根拠であって説明義務ではない

## ローカル検証の前提

UI の見た目を確認するフローは `ui-verify` skill が持つ。**UI / フロントエンドの動作確認は必ず `ui-verify` を経由する。** `ui-verify` が判断フロー（self-check → 必要なら annotate）を持ち、内部で `playwright-cli`（`@playwright/cli`、mise 管理）を呼ぶ。`playwright-cli` を直接叩くのは、`ui-verify` からコマンド詳細を引きたいときだけ。以下はその手前の環境の話。

- **ポートを決めつけない。** 複数 worktree が同時に走るため、3000 / 3001 / 5173 は別プロジェクトのものかもしれない。`lsof -i -P | grep LISTEN` か dev server の起動ログで、cwd と突き合わせて確認する
- **広範囲のプロセス kill をしない。** `pkill` / `killall` は settings.json で deny 済み。自分が起動した PID を `kill <pid>` で落とす
- **`open <url>` でブラウザを開かない。** 新しいブラウザが立ち上がってログインセッションを失う。`playwright-cli` かブラウザ MCP を使う
- **スキーマに触れる機能を検証する前に、ローカル DB に未適用のマイグレーションを流す**

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
- **主観・趣味が絡む選択**（命名、モチーフ、キャラクター、トーン、デザインの方向性）: 「条件に合う」候補を並べる前に、ユーザー自身の好みと**実例**（好きな作品・既存の参照）を聞く。条件適合で最適化した提案は趣味の代わりにならない

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

## pnpm install が 401 で落ちる場合（fnox の secrets）

`pnpm install` が private registry で `ERR_PNPM_FETCH_401` になる、または
`WARN Issue while reading "~/.npmrc". Failed to replace env in config: ${NODE_AUTH_TOKEN}` が出るときは、
**fnox の global に `NODE_AUTH_TOKEN` がある**（keychain 保存の GitHub Packages read-only PAT）。
`~/.npmrc` の `${NODE_AUTH_TOKEN}` がこれを参照している。

`fnox exec --` を前置すれば通る。

```sh
fnox exec -- pnpm install
```

登録済みの secrets は `fnox list` で確認できる。`pnpm lint` / `pnpm test` など取得を伴わないコマンドは前置不要。

### なぜ届かないのか

agent の実行するシェルは対話シェルではないため、`fnox activate` が登録する `_fnox_hook`（precmd / chpwd フック経由）が
発火せず、secrets がロードされない。Claude Code の場合はさらに、Bash ツールが `~/.claude/shell-snapshots/` の
snapshot から初期化される。**snapshot に入るのは関数定義と PATH だけ**で、`.zshrc` で export した環境変数は
一切引き継がれない（`GITHUB_TOKEN` / `FNOX_SHELL` も同様に届かない）。
つまり `.zshrc` をどう書き換えても解決しないので、コマンド側で `fnox exec --` を前置する。
