#!/bin/bash
# PostToolUse hook: private registry の 401 / NODE_AUTH_TOKEN 未解決を検知したら
# fnox exec -- の前置を促す。
#
# Bash ツールのシェルは shell snapshot（関数定義と PATH のみ）から初期化されるため、
# .zshrc で export した環境変数は届かない。fnox activate が登録する _fnox_hook も
# precmd/chpwd 経由なので非対話シェルでは発火しない。シェル設定側では直せないので、
# コマンド側で fnox exec -- を前置させる。
set -uo pipefail

INPUT=$(cat)

# パッケージマネージャを実行したコマンドだけを対象にする。入力全体を grep すると、
# このスクリプト自体やログを cat しただけで誤発火する。
# fnox exec -- を前置済みなら、このヒントは役に立たないので出さない。
CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
[[ "$CMD" =~ (^|[[:space:]\;\|\&\(])(pnpm|npm|yarn)[[:space:]] ]] || exit 0
[[ "$CMD" == *"fnox exec"* ]] && exit 0

# 判定は tool_response（出力）だけで行う。JSON エスケープされたままで問題ないパターンだけを使う。
#
# 「Failed to replace env in config: ${NODE_AUTH_TOKEN}」は取得を伴わない pnpm コマンド
# （lint / test / type-check）でも必ず出るため、単体では条件にしない。実際に認証が
# 要求されて失敗したときだけ発火させる。
RESPONSE=$(printf '%s' "$INPUT" | jq -c '.tool_response // ""')
if printf '%s' "$RESPONSE" | grep -qE 'ERR_PNPM_FETCH_401|No authorization header was set|npm\.pkg\.github\.com[^"]*(Unauthorized|401)'; then
  jq -n '{
    systemMessage: "private registry の認証に失敗しています。fnox exec -- の前置が必要です。",
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: "このコマンドは private registry の認証に失敗している。NODE_AUTH_TOKEN は fnox の global（keychain 保存）にあり、~/.npmrc の ${NODE_AUTH_TOKEN} がそれを参照している。`fnox exec -- <command>` を前置して再実行すること（例: `fnox exec -- pnpm install`）。Bash ツールのシェルは shell snapshot から初期化され .zshrc の export を引き継がないため、シェル設定をいじっても解決しない。gh auth token など別経路の認証情報を持ち出す必要もない。"
    }
  }'
  exit 0
fi

exit 0
