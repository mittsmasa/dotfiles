#!/bin/bash
# PreToolUse hook: npx 実行を検知したら、単なる permission deny で終わらせず
# pnpm dlx / pnpm exec への代替を明示した理由付きで deny を返す。
# permissions.deny の "Bash(npx:*)" はフェイルセーフとしてそのまま残す。
set -uo pipefail

INPUT=$(cat)
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

if [[ "$CMD" =~ (^|[[:space:]\;\|\&])npx([[:space:]]|$) ]]; then
  jq -n '{
    systemMessage: "npx は使用禁止です。pnpm dlx <package> または pnpm exec <command> を使ってください。",
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "npx はこの環境で禁止されています。パッケージを一時実行したい場合は `pnpm dlx <package>`、プロジェクト内にインストール済みのコマンドを実行したい場合は `pnpm exec <command>` を使ってください。"
    }
  }'
  exit 0
fi

exit 0
