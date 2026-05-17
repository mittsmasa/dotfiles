#!/bin/bash
# PreToolUse hook: 他人が読む日本語ドキュメントを書こうとしたら
# concise-japanese-writing skill のロードを促すリマインダを additionalContext で返す。
# セッション中の最初の一回だけ発火する（フラグファイルで抑止）。
set -uo pipefail

INPUT=$(cat)
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')
FLAG="/tmp/claude-concise-jp-${SESSION_ID}"

# 既にこのセッションで一度発火済みなら何もしない
[ -f "$FLAG" ] && exit 0

# 日本語文字（ひらがな・カタカナ・CJK 漢字）を含むか
has_japanese() {
  printf '%s' "$1" | grep -qP '[\x{3040}-\x{30ff}\x{4e00}-\x{9fff}]'
}

emit_reminder() {
  touch "$FLAG"
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "次のツール呼び出しで、第三者が読む日本語の本文を書こうとしています。本文を生成する前に Skill ツールで concise-japanese-writing を必ずロードし、そのルール（一文一義 / 40〜60字目安 / 結論先出し / 抽象語と冗長表現の削減）に従ってください。このリマインダはセッション中一度のみ表示されます。"
    }
  }'
  exit 0
}

case "$TOOL_NAME" in
  Bash)
    CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
    # gh pr|issue create|edit|comment|review かつ --body を含むときだけ
    if [[ "$CMD" =~ gh[[:space:]]+(pr|issue)[[:space:]]+(create|edit|comment|review) ]] \
       && [[ "$CMD" == *"--body"* ]]; then
      if has_japanese "$CMD"; then
        emit_reminder
      fi
    fi
    ;;
  Write|Edit|NotebookEdit)
    FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')
    case "$FILE_PATH" in
      *.md|*.mdx|*.txt|*.rst) ;;
      *) exit 0 ;;
    esac
    case "$TOOL_NAME" in
      Write)        CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // ""') ;;
      Edit)         CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // ""') ;;
      NotebookEdit) CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_source // ""') ;;
    esac
    if has_japanese "$CONTENT"; then
      emit_reminder
    fi
    ;;
esac

exit 0
