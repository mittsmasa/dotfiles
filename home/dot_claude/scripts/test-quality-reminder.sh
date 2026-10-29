#!/bin/bash
# PreToolUse hook: テストファイルを書こうとしたとき、test-quality skill が未ロードなら
# その呼び出しを deny し、skill をロードしてから書き直すよう促す。
# additionalContext は呼び出しの後に届き、最初のファイルが skill 無しで書かれたまま通るため deny にしている。
# transcript にロードの痕跡があれば何もしない。deny はセッション中一回まで（フラグファイルで抑止）。
set -uo pipefail

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""')
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.notebook_path // ""')
FLAG="/tmp/claude-test-quality-${SESSION_ID}"

# 既にこのセッションで一度 deny 済みなら何もしない
[ -f "$FLAG" ] && exit 0

is_test_file() {
  local path="$1" base
  base=$(basename "$path")
  # fixtures の JSON などを拾わないよう、コードの拡張子に限る
  case "$base" in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.mts|*.cts|*.py|*.go|*.rb|*.php|*.kt|*.java|*.swift) ;;
    *) return 1 ;;
  esac
  case "$base" in
    *.test.*|*.spec.*|*_test.*|test_*.py|*Test.*|*Tests.*|*_spec.rb) return 0 ;;
  esac
  case "/$path" in
    */__tests__/*|*/tests/*|*/test/*|*/spec/*|*/e2e/*) return 0 ;;
  esac
  return 1
}

is_test_file "$FILE_PATH" || exit 0

# スラッシュコマンド起動（<command-name>/test-quality</command-name>）か Skill ツール起動の痕跡があればロード済み
# transcript が読めないときは未ロード扱いにする
if [ -n "$TRANSCRIPT" ] \
   && grep -qE 'command-name>/?test-quality<|"skill": ?"test-quality"' "$TRANSCRIPT" 2>/dev/null; then
  exit 0
fi

touch "$FLAG"
jq -n --arg p "$FILE_PATH" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("テストファイル（" + $p + "）を書く前に、Skill ツールで test-quality をロードしてください。ロード後、その観点（書かない判断 / 実装でなく振る舞いを確かめる / モックは管理外の依存だけ）で中身を見直し、同じファイルを書き直してください。この確認はセッション中一度だけです。")
  }
}'
exit 0
