# chezmoi ルール

## 前提

`~/.claude/` 配下など chezmoi 管理下のファイルを編集すると、PostToolUse hook が自動で `chezmoi re-add` → commit → pull --rebase → push する。**Claude が手動で chezmoi を叩く必要はない**（下記エラー時を除く）。

詳細な差分解決ワークフロー（status / untracked 検出 / diff / merge / apply）が必要なときは `/chezmoi-sync` skill を使う。

## 守ること

- セッション開始時、chezmoi 管理ファイルを編集する前に `chezmoi git -- pull --rebase` を一度実行する
- 既存管理下ファイルの更新は `chezmoi re-add`。**`chezmoi add` は使わない**（テンプレを上書きする）。新規追加だけ `chezmoi add`

## hook エラー時の対応

stderr に `[chezmoi-sync] ERROR` が出たら:

- **pull --rebase failed** → `chezmoi git -- status` で状態確認、ユーザーに相談
- **push failed** → 認証 / ネットワーク障害の可能性、ユーザーに報告
- **re-add failed** → `chezmoi diff` で差分確認してユーザーに報告
