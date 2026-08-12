必ず日本語で回答してください

## ワークフロー必須

タスクを受け取ったら、何よりも先に `~/.claude/rules/workflow.md` の Phase 0（規模判定）を実行すること。調査・ツール呼び出し・エージェント起動はその後。

## ブラウザ自動操作

UI / フロントエンドの動作確認は `ui-verify` skill を経由する。`ui-verify` が判断フロー（self-check → 必要なら annotate）を持っていて、内部で `playwright-cli`（`@playwright/cli`、mise 管理）を呼ぶ。直接 `playwright-cli` を叩くのは、`ui-verify` 内のコマンド詳細を引きたいときだけ。

## diff 確認

cmux 上で「diff を見せて」「差分を見せて」と言われたら `cmux diff` を使う（`--unstaged` / `--staged` / `--branch` / `--last-turn` でソース指定、ブラウザ split に表示される）。difit は使わない（uninstall 済み）。

## skill のインストール

GitHub リポジトリから agent skill を導入するときは `gh skill install <owner>/<repo> --agent claude-code --scope user` を使う（npm の `skills` パッケージは使わない）。

## fnox の secrets が要るコマンド

Bash ツールのシェルは `~/.claude/shell-snapshots/` の snapshot から初期化される。snapshot に入るのは**関数定義と PATH だけ**で、`.zshrc` で export した環境変数は引き継がれない（`GITHUB_TOKEN` / `FNOX_SHELL` も届かない）。`fnox activate` が登録する `_fnox_hook` は precmd/chpwd フック経由なので、非対話シェルでは発火しない。

そのため fnox の secrets が要るコマンドは `fnox exec --` を前置する。

```bash
fnox exec -- pnpm install
```

例: private registry から取得する `pnpm install`（`NODE_AUTH_TOKEN` が要る）。`~/.npmrc` の `${NODE_AUTH_TOKEN}` が空のまま送られて 401 になる。`pnpm lint` / `pnpm test` など取得を伴わないコマンドは前置不要。