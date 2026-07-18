#!/usr/bin/env bash
# Claude Code Notification hook のエントリポイント。
# stdin の JSON を音声(notify-speak.sh)と視覚(visual-notify.sh)の両方に流す。
# 片方が失敗しても hook 全体を止めないよう exit 0 で終わる。
set -uo pipefail

# 一時的に通知を無効化中。復帰するには次の行を削除する。
exit 0

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

tee >(bash "$DIR/notify-speak.sh" >/dev/null 2>&1 || true) \
    >(bash "$DIR/visual-notify.sh" >/dev/null 2>&1 || true) \
  >/dev/null

exit 0
