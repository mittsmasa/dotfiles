#!/bin/bash
# Stop hook: 最終応答の行数・字数を TSV に記録する（計測のみ、block しない）。
# concise-response-reminder.sh（毎ターン注入）の効き具合と、
# 「長いが正当な応答」の割合を見るためのデータ収集。block 導入の判断材料にする。
set -uo pipefail

INPUT=$(cat)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // ""')
SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')

[ -f "$TRANSCRIPT" ] || exit 0

LOG_DIR="$HOME/.claude/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/response-length.tsv"
[ -f "$LOG_FILE" ] || printf 'timestamp\tsession_id\tlines\tchars\n' > "$LOG_FILE"

# transcript(JSONL) の末尾から、直近のアシスタント応答の text ブロックを結合して取り出す
LAST_TEXT=$(tail -n 300 "$TRANSCRIPT" | jq -rs '
  [ .[]
    | select(.type == "assistant")
    | [.message.content[]? | select(.type == "text") | .text]
    | select(length > 0)
    | join("\n")
  ] | last // ""' 2>/dev/null) || exit 0

[ -n "$LAST_TEXT" ] || exit 0

LINES=$(printf '%s' "$LAST_TEXT" | grep -c '' || true)
# 文字数は UTF-8 で数える（hook 環境の locale に依存する wc -m は使わない）
CHARS=$(printf '%s' "$LAST_TEXT" | perl -CS -0777 -ne 'print length($_)')

printf '%s\t%s\t%s\t%s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$SESSION_ID" "$LINES" "$CHARS" >> "$LOG_FILE"
exit 0
