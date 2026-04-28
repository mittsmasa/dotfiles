#!/usr/bin/env bash
# Claude Code Notification hook の視覚通知側。
# stdin の JSON の message フィールドを抽出し、OS 別にトーストを出す。
# 失敗しても hook 全体を止めないよう、常に exit 0 で終わる。
set -uo pipefail

PAYLOAD="$(cat)"
MESSAGE="$(printf '%s' "$PAYLOAD" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("message",""))' 2>/dev/null || true)"
[[ -z "$MESSAGE" ]] && MESSAGE="通知です"

TITLE="Claude Code"

notify_macos() {
  # osascript の文字列に含めると壊れる文字をエスケープ
  local msg="${MESSAGE//\\/\\\\}"
  msg="${msg//\"/\\\"}"
  local title="${TITLE//\\/\\\\}"
  title="${title//\"/\\\"}"
  osascript -e "display notification \"$msg\" with title \"$title\"" 2>/dev/null || true
}

notify_wsl() {
  local pwsh
  if command -v powershell.exe >/dev/null 2>&1; then
    pwsh="powershell.exe"
  elif [[ -x "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe" ]]; then
    pwsh="/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  else
    return 0
  fi
  # PowerShell スクリプトを heredoc で組み立て、UTF-16LE Base64 で渡す
  # title/msg は @'...'@ here-string に埋め込むため、変数展開も特殊文字エスケープも不要
  local ps_script
  ps_script=$(cat <<EOF
\$title = @'
$TITLE
'@
\$msg = @'
$MESSAGE
'@
\$appId = "ClaudeCode.Notify"
\$regPath = "HKCU:\\SOFTWARE\\Classes\\AppUserModelId\\\$appId"
if (-not (Test-Path \$regPath)) {
  New-Item -Path \$regPath -Force | Out-Null
  New-ItemProperty -Path \$regPath -Name "DisplayName" -Value "Claude Code" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path \$regPath -Name "ShowInSettings" -Value 0 -PropertyType DWord -Force | Out-Null
}
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
\$tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
\$nodes = \$tpl.GetElementsByTagName("text")
[void]\$nodes.Item(0).AppendChild(\$tpl.CreateTextNode(\$title))
[void]\$nodes.Item(1).AppendChild(\$tpl.CreateTextNode(\$msg))
\$toast = [Windows.UI.Notifications.ToastNotification]::new(\$tpl)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier(\$appId).Show(\$toast)
EOF
)
  local encoded
  encoded=$(printf '%s' "$ps_script" | iconv -f UTF-8 -t UTF-16LE 2>/dev/null | base64 -w0) || return 0
  "$pwsh" -NoProfile -ExecutionPolicy Bypass -EncodedCommand "$encoded" 2>/dev/null || true
}

notify_linux() {
  command -v notify-send >/dev/null 2>&1 && notify-send "$TITLE" "$MESSAGE" || true
}

case "$(uname -s)" in
  Darwin)
    notify_macos
    ;;
  Linux)
    if grep -qiE '(microsoft|wsl)' /proc/version 2>/dev/null; then
      notify_wsl
    else
      notify_linux
    fi
    ;;
esac

exit 0
