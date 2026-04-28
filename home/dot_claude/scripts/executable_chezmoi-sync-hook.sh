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

# gitleaks 必須化: secrets スキャンができないなら何も push させない
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[chezmoi-sync] ERROR: gitleaks not found. Install with: mise use -g gitleaks@latest" >&2
  exit 1
fi

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

# 当該ファイルの source パスのみ stage（add -A による巻き添え push を防ぐ）
SOURCE_PATH=$(chezmoi source-path "$FILE_PATH" 2>/dev/null)
if [[ -z "$SOURCE_PATH" ]]; then
  echo "[chezmoi-sync] ERROR: failed to resolve source path for $FILE_PATH" >&2
  exit 1
fi

chezmoi git -- add -- "$SOURCE_PATH" 2>&1

# Push 前のシークレットスキャン: staged 差分のみ対象
# .chezmoiroot で source-path が git root と異なる場合があるため git toplevel を使う
GIT_ROOT=$(chezmoi git -- rev-parse --show-toplevel 2>/dev/null | tr -d '\r')
if [[ -z "$GIT_ROOT" ]] || [[ ! -d "$GIT_ROOT/.git" ]]; then
  echo "[chezmoi-sync] ERROR: could not resolve chezmoi git toplevel" >&2
  chezmoi git -- reset HEAD -- "$SOURCE_PATH" 2>&1 || true
  exit 1
fi

if ! gitleaks git --staged --no-banner --redact --exit-code 1 "$GIT_ROOT" >&2; then
  echo "[chezmoi-sync] ERROR: gitleaks detected secrets in staged changes. Aborting." >&2
  echo "[chezmoi-sync] Unstaging $SOURCE_PATH. Review the file and remove secrets before retrying." >&2
  chezmoi git -- reset HEAD -- "$SOURCE_PATH" 2>&1 || true
  exit 1
fi

# commit
RELATIVE=$(echo "$FILE_PATH" | sed "s|^$HOME/||")
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
