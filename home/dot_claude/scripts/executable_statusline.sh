#!/usr/bin/env bash

input=$(cat)
current_dir=$(echo "$input" | jq -r ".workspace.current_dir")
relative_path="${current_dir/#$HOME/~}"
cd "$current_dir" 2>/dev/null
git_branch=$(git -c core.useReplaceRefs=false branch --no-color --show-current 2>/dev/null)
git_info="${git_branch:+[$git_branch] }"
model_name=$(echo "$input" | jq -r ".model.display_name")

case "$model_name" in
  *Sonnet*) model_short="sonnet";;
  *Opus*) model_short="opus";;
  *Haiku*) model_short="haiku";;
  *) model_short=$(echo "$model_name" | awk '{print tolower($NF)}');;
esac

remaining=$(echo "$input" | jq -r ".context_window.remaining_percentage // empty")
token_info="${remaining:+トークン残: $(printf "%.0f" $remaining)%}"
token_info="${token_info:-トークン残: --}"

printf "%s%s | %s | %s" "$git_info" "$relative_path" "$token_info" "$model_short"
