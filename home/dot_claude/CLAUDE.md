必ず日本語で回答してください

## ワークフロー必須

タスクを受け取ったら、何よりも先に `~/.claude/rules/workflow.md` の Phase 0（規模判定）を実行すること。調査・ツール呼び出し・エージェント起動はその後。

## ブラウザ自動操作

UI / フロントエンドの動作確認は `ui-verify` skill を経由する。`ui-verify` が判断フロー（self-check → 必要なら annotate）を持っていて、内部で `playwright-cli`（`@playwright/cli`、mise 管理）を呼ぶ。直接 `playwright-cli` を叩くのは、`ui-verify` 内のコマンド詳細を引きたいときだけ。

## スキルのインストール

GitHub リポジトリからスキルを追加するときは必ず `gh skill install`（`gh skills`）を使う。`npx skills add` 等の別ツールは使わない。パスは `owner/repo` の後にスキル名または repo 内の正確なパス（例: `plugins/<name>/skills/<name>`）を指定し、`--agent claude-code --scope user` を付ける。インストール後、`~/.claude/` 配下の新規ファイルは `chezmoi add`（既存更新なら `re-add`）で管理下に入れる。