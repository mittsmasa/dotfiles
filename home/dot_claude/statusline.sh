#!/usr/bin/env bash
# Claude Code status line script
# Displays: git branch | current directory | remaining context window

input=$(cat)

# Current working directory (from JSON)
cwd=$(echo "$input" | jq -r '.cwd // .workspace.current_dir // empty')
# Show only the last 2 path components for brevity
short_dir=$(echo "$cwd" | awk -F'/' '{if(NF>=2) print $(NF-1)"/"$NF; else print $NF}')

# Git branch (run in the cwd)
git_branch=""
if [ -n "$cwd" ] && [ -d "$cwd/.git" ] || git -C "$cwd" rev-parse --git-dir > /dev/null 2>&1; then
  git_branch=$(git --no-optional-locks -C "$cwd" symbolic-ref --short HEAD 2>/dev/null)
fi

# Remaining context window percentage
remaining=$(echo "$input" | jq -r '.context_window.remaining_percentage // empty')

# Build output
parts=()
[ -n "$git_branch" ] && parts+=("$(printf '\033[0;36m\xee\x82\xa0 %s\033[0m' "$git_branch")")
[ -n "$short_dir" ] && parts+=("$(printf '\033[0;33m%s\033[0m' "$short_dir")")
if [ -n "$remaining" ]; then
  remaining_int=$(printf '%.0f' "$remaining")
  parts+=("$(printf '\033[0;32mctx:%s%%\033[0m' "$remaining_int")")
fi

# Join with separator
printf '%s' "$(IFS='  '; echo "${parts[*]}")"
