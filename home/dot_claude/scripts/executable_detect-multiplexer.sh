#!/usr/bin/env bash
# Claude Code SessionStart hook.
# 1. Detect terminal multiplexer (tmux / cmux / bare) and inject context
#    so Claude knows which skill to use for pane operations.
# 2. If the session's cwd is inside a worktree created by `claude --worktree`
#    (path contains `.claude/worktrees/`), copy gitignored setup files
#    (`.serena/`, `.env.local` family) from the main repo once.

set -uo pipefail

# --- Read SessionStart input (may be empty / non-JSON) ---
INPUT=""
if [ ! -t 0 ]; then
  INPUT=$(cat || true)
fi

SESSION_CWD=""
if [ -n "$INPUT" ]; then
  SESSION_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)
fi
SESSION_CWD="${SESSION_CWD:-${PWD:-$(pwd)}}"

# --- Worktree bootstrap (idempotent, never fails the hook) ---
worktree_bootstrap() {
  local cwd="$1"
  case "$cwd" in
    *"/.claude/worktrees/"*) ;;
    *) return 0 ;;
  esac

  if ! command -v git >/dev/null 2>&1; then
    return 0
  fi

  local main_repo
  main_repo=$(cd "$cwd" 2>/dev/null && git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')
  if [ -z "$main_repo" ] || [ "$main_repo" = "$cwd" ]; then
    return 0
  fi

  # .serena/ (only if main has it and worktree doesn't)
  if [ -d "$main_repo/.serena" ] && [ ! -e "$cwd/.serena" ]; then
    cp -R "$main_repo/.serena" "$cwd/.serena" 2>/dev/null \
      || echo "[worktree-bootstrap] failed to copy .serena/" >&2
  fi

  # .env.local family via git ls-files (gitignored files only)
  (
    cd "$main_repo" || exit 0
    git ls-files --others --ignored --exclude-standard 2>/dev/null \
      | grep -E '(^|/)\.env(\.[^/]+)?\.local$' \
      | while IFS= read -r rel; do
          [ -f "$main_repo/$rel" ] || continue
          [ -e "$cwd/$rel" ] && continue
          mkdir -p "$cwd/$(dirname "$rel")" 2>/dev/null || continue
          cp "$main_repo/$rel" "$cwd/$rel" 2>/dev/null \
            || echo "[worktree-bootstrap] failed to copy $rel" >&2
        done
  ) || true

  return 0
}

worktree_bootstrap "$SESSION_CWD" || true

# --- Multiplexer detection ---
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

# --- Worktree context (appended when inside a worktree) ---
case "$SESSION_CWD" in
  *"/.claude/worktrees/"*)
    worktree_ctx=$(cat <<'EOF'

## Worktree session

You are running inside a `claude --worktree` worktree (cwd contains `.claude/worktrees/`).

- `.serena/` と `.env.local` 系は SessionStart hook が自動コピー済み（初回のみ）。
- 作業は通常通り進めてよい。終了時に変更がなければ、`claude --worktree` の標準挙動でディレクトリとブランチは自動 cleanup される。
EOF
)
    context="${context}${worktree_ctx}"
    ;;
esac

# SessionStart hook expects JSON with hookSpecificOutput.additionalContext.
jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $ctx
  }
}'
