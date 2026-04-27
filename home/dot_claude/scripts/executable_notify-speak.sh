#!/usr/bin/env bash
# Claude Code Notification hook から呼ばれる。
# stdin の JSON の message フィールドで分岐し、事前生成済み wav を再生する。
# wav は ~/.claude/sounds/{permission,waiting,notify}.wav
set -euo pipefail

PAYLOAD="$(cat)"
MESSAGE="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("message",""))' 2>/dev/null || true)"

case "$MESSAGE" in
  *permission*)              WAV="$HOME/.claude/sounds/permission.wav" ;;
  *"waiting for your input"*) WAV="$HOME/.claude/sounds/waiting.wav" ;;
  *)                         WAV="$HOME/.claude/sounds/notify.wav" ;;
esac

exec paplay "$WAV"
