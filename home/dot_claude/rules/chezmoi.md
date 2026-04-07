# chezmoi 自動同期ルール

## 概要

`~/.claude/` 配下など chezmoi 管理下のファイルを編集した場合、PostToolUse hook が自動的に `chezmoi re-add` → commit → pull --rebase → push を実行する。

## エラー時の対応

hook が失敗した場合（stderr に `[chezmoi-sync] ERROR` が出力される）、以下の手順で対応すること:

1. **pull --rebase failed**: リモートとの conflict が発生している。`chezmoi git -- status` で状態を確認し、ユーザーに状況を伝えて対応を相談する。
2. **push failed**: 認証エラーやネットワーク障害の可能性がある。ユーザーに報告する。
3. **re-add failed**: ファイルの状態が不正な可能性がある。`chezmoi diff` で差分を確認してユーザーに報告する。

## セッション開始時

新しいセッションの開始時、chezmoi 管理ファイルを編集する前に `chezmoi git -- pull --rebase` を実行してリモートの最新状態を取得すること。

## 注意事項

- hook はシェルスクリプトとして自動実行されるため、Claude が手動で chezmoi コマンドを実行する必要はない（hook がエラーになった場合を除く）
- `chezmoi re-add` ではなく `chezmoi add` を使わないこと（既存テンプレートを上書きしてしまう）
