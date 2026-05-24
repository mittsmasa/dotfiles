# chezmoi ルール

## 前提

`~/.claude/` 配下など chezmoi 管理下のファイルを編集すると PostToolUse hook が自動で `chezmoi re-add` → commit → pull --rebase → push する。**Claude が手動で chezmoi を叩く必要はない**（エラー時除く）。差分解決ワークフロー（status / untracked / diff / merge / apply）が必要なら `/chezmoi-sync` skill を使う。

## 守ること

- セッション開始時、chezmoi 管理ファイル編集前に `chezmoi git -- pull --rebase` を一度実行
- 既存管理下ファイル更新は `chezmoi re-add`。**`chezmoi add` は使わない**（テンプレを上書きする）。新規追加だけ `chezmoi add`

## hook エラー時の対応

stderr に `[chezmoi-sync] ERROR` が出たら:

- **pull --rebase failed** → `chezmoi git -- status` で状態確認、ユーザー相談
- **push failed** → 認証/ネットワーク障害の可能性、ユーザー報告
- **re-add failed** → `chezmoi diff` で差分確認しユーザー報告
