#!/bin/bash
# PreToolUse hook: アプリケーションコードを書こうとしたとき、testable-design skill が未ロードなら
# そのロードを促すリマインダを additionalContext で返す（呼び出しは止めない）。
# テストファイルは test-quality-reminder.sh が担うので対象外にする。
# transcript にロードの痕跡があれば何もしない。セッション中一度だけ発火する（フラグファイルで抑止）。
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""')
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""')

# session_id はフラグのパスに埋め込むので、パスを作れる文字を含むなら何もしない
[[ "$SESSION_ID" =~ ^[A-Za-z0-9_-]+$ ]] || exit 0
FLAG="${TMPDIR:-/tmp}/claude-soc-${SESSION_ID}"

# 既にこのセッションで一度発火済みなら何もしない
[ -f "$FLAG" ] && exit 0

is_code_file() {
  case "$(basename "$1")" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.py|*.go|*.rb|*.php|*.kt|*.java|*.swift|*.rs) return 0 ;;
  esac
  return 1
}

# test-quality-reminder.sh と同じ判定
is_test_file() {
  local path="$1" base
  base=$(basename "$path")
  case "$base" in
    *.test.*|*.spec.*|*_test.*|test_*.py|*Test.*|*Tests.*|*_spec.rb) return 0 ;;
  esac
  case "/$path" in
    */__tests__/*|*/tests/*|*/test/*|*/spec/*|*/e2e/*) return 0 ;;
  esac
  return 1
}

is_code_file "$FILE_PATH" || exit 0
is_test_file "$FILE_PATH" && exit 0

# スラッシュコマンド起動か Skill ツール起動の痕跡があればロード済み
if [ -n "$TRANSCRIPT" ] \
   && grep -qE 'command-name>/?testable-design<|"skill": ?"testable-design"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

touch "$FLAG"
jq -n '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: "アプリケーションコードを書こうとしています。Skill ツールで testable-design をロードし、その観点（変わる理由が同じものは集め、違うものは離す / 共通部にフラグや分岐を足す前に、呼び出し元を分けるほうが自然でないか比べる / 分けすぎない）を当ててください。この呼び出しで書いた内容も、ロード後に同じ観点で見直してください。このリマインダはセッション中一度のみ表示されます。"
  }
}'
exit 0
