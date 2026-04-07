#!/usr/bin/env bash
# chezmoi-sync-hook.sh
# PostToolUse hook: Write/Edit/MultiEdit で chezmoi 管理ファイルが変更されたら自動同期する

set -euo pipefail

# stdin から JSON ペイロードを読み込み
INPUT=$(cat)

FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

# file_path がなければスキップ
if [[ -z "$FILE_PATH" ]]; then
  exit 0
fi

# chezmoi 管理下かチェック（source-path が成功すれば管理下）
if ! chezmoi source-path "$FILE_PATH" &>/dev/null; then
  exit 0
fi

# --- 同期実行 ---

echo "[chezmoi-sync] Detected change in managed file: $FILE_PATH" >&2

# re-add で source に反映
if ! chezmoi re-add "$FILE_PATH" 2>&1; then
  echo "[chezmoi-sync] ERROR: chezmoi re-add failed for $FILE_PATH" >&2
  exit 1
fi

# 差分がなければ何もしない
if chezmoi git -- diff --quiet && chezmoi git -- diff --staged --quiet; then
  echo "[chezmoi-sync] No changes to commit." >&2
  exit 0
fi

# commit
RELATIVE=$(echo "$FILE_PATH" | sed "s|^$HOME/||")
chezmoi git -- add -A 2>&1
chezmoi git -- commit -m "Update $RELATIVE" 2>&1

# pull --rebase して push
if ! chezmoi git -- pull --rebase 2>&1; then
  echo "[chezmoi-sync] ERROR: pull --rebase failed. Manual resolution required." >&2
  exit 1
fi

if ! chezmoi git -- push 2>&1; then
  echo "[chezmoi-sync] ERROR: push failed. Manual resolution required." >&2
  exit 1
fi

echo "[chezmoi-sync] Synced: $RELATIVE" >&2
