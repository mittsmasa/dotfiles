#!/usr/bin/env bash
# workflow-meta-hook.sh
# ~/.claude/workflow/{task}/ 配下の md 書き込み（plan/research/verify-results）を検知し、
# その task dir の meta.json を生成・マージ更新する PostToolUse hook。
#
# meta.json は md から導けない安定情報のみを持つ:
#   cwd       - タスクを実行したリポジトリ（worktree）の作業ディレクトリ
#   createdAt - 初回生成時刻（ISO8601 UTC、以降不変）
#   branch    - cwd 上の git HEAD のブランチ名。dependsOn 検知の手がかり。
#               cwd が git でない or detached HEAD なら省略。
#               既存 meta.json の branch が非空なら保持（手書き優先・リネーム時の事故防止）。
#   noPr      - PR を作らないタスクであることの宣言。
#               新規生成時、cwd が `~/.claude/` 配下なら自動で true を補完する。
#               明示的な手書きも有効（既存 meta.json の noPr は jq マージで保持される）
#
# 環境変数:
#   META_HOOK_CWD - cwd を明示指定（bootstrap 用）。未指定なら実行時 $PWD。
#
# 設計上の注意:
#   - meta.json の書き込みはシェルリダイレクト経由。Claude の Write ツールを
#     使わないため PostToolUse は再発火しない（再入ループなし）。
#   - 既存 meta.json の createdAt は不変。cwd は既存が非空なら保持。
#   - dependsOn / pr / noPr 等の手書き or 拡張フィールドはマージで残す
#     （cwd/createdAt のみ更新。jq の `.cwd = $cwd` は他フィールドを保持する挙動）。
#   - PR 情報は dashboard 側 (server.ts の fetchLivePrs) で graphql から live 取得する。
#     本 hook は PR を一切書き込まない（旧 `gh pr view` ロジックは廃止）。
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

# 既存 meta.json から createdAt / cwd / branch を 1 回の jq で取得
EXIST_CREATED=""
EXIST_CWD=""
EXIST_BRANCH=""
if [[ -f "$META" ]]; then
  { IFS= read -r EXIST_CREATED; IFS= read -r EXIST_CWD; IFS= read -r EXIST_BRANCH; } < <(
    jq -r '.createdAt // "", .cwd // "", .branch // ""' "$META" 2>/dev/null
  )
fi

CREATED="${EXIST_CREATED:-$NOW}"
# cwd: 既存が非空ならそれを保持。空/未設定なら META_HOOK_CWD か実行時 $PWD で更新
if [[ -n "$EXIST_CWD" ]]; then
  CWD="$EXIST_CWD"
else
  CWD="${META_HOOK_CWD:-$PWD}"
fi

# branch: 既存が非空ならそれを保持（手書き優先）。
# 空なら cwd の git HEAD から取得。git でない / detached HEAD / cwd が無いなら空。
if [[ -n "$EXIST_BRANCH" ]]; then
  BRANCH="$EXIST_BRANCH"
elif [[ -n "$CWD" ]] && [[ -d "$CWD" ]]; then
  BRANCH=$(git -C "$CWD" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")
else
  BRANCH=""
fi

# 新規 meta.json 生成時のみ、cwd が `~/.claude/` 配下なら noPr=true を補完する。
# 両側を pwd -P で正規化してから前方一致比較するので、どちらが symlink でも安全。
# 既存 meta.json の noPr は jq マージ式が他フィールドを保持するため触らない。
NO_PR_INIT="false"
if [[ ! -f "$META" ]] && [[ -n "$CWD" ]] && [[ -d "$CWD" ]]; then
  HOME_REAL=$(cd "$HOME/.claude" 2>/dev/null && pwd -P)
  CWD_REAL=$(cd "$CWD" 2>/dev/null && pwd -P)
  if [[ -n "$HOME_REAL" ]] && [[ -n "$CWD_REAL" ]] \
     && { [[ "$CWD_REAL" == "$HOME_REAL" ]] || [[ "$CWD_REAL" == "$HOME_REAL"/* ]]; }; then
    NO_PR_INIT="true"
  fi
fi

# 一時ファイルに書いてから mv（jq 失敗時に meta.json を壊さない）。
# 既存 meta.json があれば dependsOn/pr/noPr 等を残し cwd/createdAt のみマージ更新。
TMP=$(mktemp "${TMPDIR:-/tmp}/workflow-meta.XXXXXX") || exit 0
if [[ -f "$META" ]]; then
  jq --arg cwd "$CWD" --arg created "$CREATED" \
    '.cwd = $cwd | .createdAt = $created' "$META" >"$TMP" 2>/dev/null
else
  jq -n --arg cwd "$CWD" --arg created "$CREATED" --argjson nopr "$NO_PR_INIT" \
    '{cwd: $cwd, createdAt: $created} + (if $nopr then {noPr: true} else {} end)' >"$TMP" 2>/dev/null
fi
if [[ -s "$TMP" ]]; then
  mv "$TMP" "$META"
else
  rm -f "$TMP"
fi

exit 0
