#!/usr/bin/env bash
# workflow-meta-hook.sh
# ~/.claude/workflow/{task}/ 配下の md 書き込み（plan/research/verify-results）を検知し、
# その task dir の meta.json を生成・マージ更新する PostToolUse hook。
#
# meta.json は md から導けない安定情報のみを持つ:
#   cwd       - タスクを実行したリポジトリ（worktree）の作業ディレクトリ
#   createdAt - 初回生成時刻（ISO8601 UTC、以降不変）
#
# 環境変数:
#   META_HOOK_CWD - cwd を明示指定（bootstrap 用）。未指定なら実行時 $PWD。
#
# 設計上の注意:
#   - meta.json の書き込みはシェルリダイレクト経由。Claude の Write ツールを
#     使わないため PostToolUse は再発火しない（再入ループなし）。
#   - 既存 meta.json の createdAt は不変。cwd は既存が非空なら保持。
#   - dependsOn / pr 等の手書きフィールドはマージで残す（cwd/createdAt のみ更新）。
#   - 非対象ファイル・エラー時は常に exit 0（Claude をブロックしない）。

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")
[[ -z "$FILE_PATH" ]] && exit 0

case "$(basename "$FILE_PATH")" in
  plan.md | research.md | verify-results.md) ;;
  *) exit 0 ;;
esac

# task dir = 書き込まれた md の親ディレクトリ。~/.claude/workflow/ 配下のみ対象
TASK_DIR=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd -P)
[[ -z "$TASK_DIR" ]] && exit 0
WORKFLOW_ROOT="$HOME/.claude/workflow"
case "$TASK_DIR/" in
  "$WORKFLOW_ROOT"/*) ;;
  *) exit 0 ;;
esac

META="$TASK_DIR/meta.json"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

EXIST_CREATED=""
EXIST_CWD=""
if [[ -f "$META" ]]; then
  EXIST_CREATED=$(jq -r '.createdAt // empty' "$META" 2>/dev/null || echo "")
  EXIST_CWD=$(jq -r '.cwd // empty' "$META" 2>/dev/null || echo "")
fi

CREATED="${EXIST_CREATED:-$NOW}"
# cwd: 既存が非空ならそれを保持。空/未設定なら META_HOOK_CWD か実行時 $PWD で更新
if [[ -n "$EXIST_CWD" ]]; then
  CWD="$EXIST_CWD"
else
  CWD="${META_HOOK_CWD:-$PWD}"
fi

# 一時ファイルに書いてから mv（jq 失敗時に meta.json を壊さない）。
# 既存 meta.json があれば dependsOn/pr 等を残し cwd/createdAt のみマージ更新。
TMP=$(mktemp "${TMPDIR:-/tmp}/workflow-meta.XXXXXX") || exit 0
if [[ -f "$META" ]]; then
  jq --arg cwd "$CWD" --arg created "$CREATED" \
    '.cwd = $cwd | .createdAt = $created' "$META" >"$TMP" 2>/dev/null
else
  jq -n --arg cwd "$CWD" --arg created "$CREATED" \
    '{cwd: $cwd, createdAt: $created}' >"$TMP" 2>/dev/null
fi
if [[ -s "$TMP" ]]; then
  mv "$TMP" "$META"
else
  rm -f "$TMP"
fi

exit 0
