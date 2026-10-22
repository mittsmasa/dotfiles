#!/bin/bash
# UserPromptSubmit hook: チャット応答の量の規律を毎ターン注入する。
# skill（concise-japanese-writing）はロードが一度きりで長いセッションでは効きが薄れるため、
# 応答量のルールだけを毎ターン additionalContext で注入する。
# 例外判定（詳細を求められたら展開してよい）は hook 側では判定できないため、
# 文面内の条件としてモデルに委ねる。
set -uo pipefail

# stdin（hook 入力 JSON）は使わないが、読み捨てて SIGPIPE を避ける
cat > /dev/null

jq -n '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: "【応答量の規律・毎ターン自動注入】ユーザーに見せる応答本文は、方針と結論だけを 5 行・300 字以内で書く。コードブロック、図、肉付けの箇条書きは出さない。直前のユーザー発言が詳細・具体例・コードを明示的に求めている場合のみ、その箇所に限って展開してよい。thinking、ツール呼び出し、ファイルや PR に書く成果物の本文はこの制限の対象外。"
  }
}'
exit 0
