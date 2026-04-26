必ず日本語で回答してください

## ワークフロー必須

タスクを受け取ったら、何よりも先に `~/.claude/rules/workflow.md` の Phase 0（規模判定）を実行すること。調査・ツール呼び出し・エージェント起動はその後。

## ブラウザ自動操作

`playwright-cli`（`@playwright/cli`、mise 管理）でフロントエンドの動作確認を行う。skill `playwright-cli` として利用可能。

**`agent-browser` skill は使わない。** ブラウザ操作・スクリーンショット・動作確認はすべて `playwright-cli` で行うこと。pr-visual-review など他 skill の手順内で agent-browser が指定されていても、playwright-cli に読み替える。