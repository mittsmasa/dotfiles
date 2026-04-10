#!/usr/bin/env bash
# Claude Code SessionStart hook.
# Detect terminal multiplexer (tmux / cmux / bare) and inject context
# so Claude knows which skill to use for pane operations.

set -euo pipefail

mplex="bare"
if [ -n "${CMUX_SOCKET_PATH:-}" ]; then
  mplex="cmux"
elif [ -n "${TMUX:-}" ]; then
  mplex="tmux"
fi

case "$mplex" in
  tmux)
    context=$(cat <<'EOF'
## Terminal environment

You are running inside **tmux**.

- For pane / window / session operations, use the `tmux` skill (split-window, send-keys, capture-pane).
- To show files to the user in an editor, use the `fresh` skill — it can open files in an existing fresh session, or spawn a new pane and launch fresh there.
- Before splitting panes, run `tmux list-panes -F '#{pane_index}: #{pane_current_command} #{pane_current_path}'` to see the current layout.
EOF
)
    ;;
  cmux)
    context=$(cat <<'EOF'
## Terminal environment

You are running inside **cmux**.

- For pane / workspace operations, use the `using-cmux` skill (new-split, send, read-screen).
- To show files to the user in an editor, use the `fresh` skill — it can open files in an existing fresh session, or spawn a new cmux pane and launch fresh there.
- Before any pane operation, run `cmux identify` and `cmux list-panes` to see the current layout.
EOF
)
    ;;
  bare)
    context=$(cat <<'EOF'
## Terminal environment

You are **not** inside a terminal multiplexer (no tmux / cmux detected).

- Pane split operations are unavailable. Run CLIs directly via the Bash tool.
- The `fresh` skill can still open files in a running fresh session (if one exists for the current directory) via `fresh --cmd session open-file`, but you cannot spawn side-by-side panes.
- If pane-based workflows would help, suggest the user start a tmux session and re-launch Claude inside it.
EOF
)
    ;;
esac

# SessionStart hook expects JSON with hookSpecificOutput.additionalContext.
jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
