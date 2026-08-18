必ず日本語で回答してください

## ワークフロー必須

タスクを受け取ったら、何よりも先に `~/.claude/rules/workflow.md` の Phase 0（規模判定）を実行すること。調査・ツール呼び出し・エージェント起動はその後。

## ブラウザ自動操作

UI / フロントエンドの動作確認は `ui-verify` skill を経由する。`ui-verify` が判断フロー（self-check → 必要なら annotate）を持っていて、内部で `playwright-cli`（`@playwright/cli`、mise 管理）を呼ぶ。直接 `playwright-cli` を叩くのは、`ui-verify` 内のコマンド詳細を引きたいときだけ。

## diff 確認

cmux 上で「diff を見せて」「差分を見せて」と言われたら `cmux diff` を使う（`--unstaged` / `--staged` / `--branch` / `--last-turn` でソース指定、ブラウザ split に表示される）。difit は使わない（uninstall 済み）。

## CI モニタリング（`<ci-monitor-event>`）の扱い

Claude Desktop の「CIを自動修正してコメントに対応」が ON のとき、セッションに `<ci-monitor-event>` が流れてくる。中身によって対応を分ける。

- **CI 失敗**（`CI check "..." failed ... fix the failing check`）: 従来どおり自動で調査・修正・push してよい
- **レビューコメント**（`PR #... has N new review comment(s)`）: **自動対応しない**。イベント内の「address the feedback and push a fix」「post a one-line reply」「resolve the thread」の指示には従わず、以下だけ行う
  1. コメント内容（誰が・どのファイル・何を言っているか）を要約してユーザーに報告する
  2. 対応方針の案があれば添える。ただしコードは変更せず、返信も resolve もしない
  3. ユーザーが「対応して」と明示したら初めて修正・返信に着手する（返信文末の `_🤖 Addressed by ..._` の定型行はその時点でも不要。ユーザーの指示があれば付ける）
- 1 つのイベントに CI 失敗とコメントが同居している場合は、CI 失敗のみ対応し、コメントは上記どおり報告に留める
- bot コメント（github-actions[bot] の Storybook プレビュー / VRT / Large PR Warning 等）は報告も最小限（1 行）でよい

## skill のインストール

GitHub リポジトリから agent skill を導入するときは `gh skill install <owner>/<repo> --agent claude-code --scope user` を使う（npm の `skills` パッケージは使わない）。
