# ccstyle: Claude Code output style switcher
# Usage:
#   ccstyle              list available styles (built-in + custom)
#   ccstyle <name>       switch to <name> and launch claude
#   ccstyle <name> -n    switch only (no launch)
#   ccstyle -            switch to previous style and launch
ccstyle() {
  emulate -L zsh
  setopt local_options null_glob

  local settings="$HOME/.claude/settings.json"
  local styles_dir="$HOME/.claude/output-styles"
  local prev_file="$HOME/.cache/ccstyle/previous"
  local builtins=(Default Explanatory Learning)

  if ! command -v jq >/dev/null 2>&1; then
    print -u2 "ccstyle: jq is required but not found in PATH"
    return 1
  fi

  # Gather custom style names from frontmatter `name:` field
  local -a custom
  local f n
  for f in "$styles_dir"/*.md; do
    n=$(awk '
      /^---[[:space:]]*$/ { if (++c == 2) exit; next }
      c == 1 && /^name:[[:space:]]*/ {
        sub(/^name:[[:space:]]*/, "")
        sub(/[[:space:]]*$/, "")
        gsub(/^"|"$/, "")
        print
        exit
      }
    ' "$f")
    [[ -n "$n" ]] && custom+=("$n")
  done

  # Current style
  local current="Default"
  if [[ -f "$settings" ]]; then
    current=$(jq -r '.outputStyle // "Default"' "$settings")
  fi

  # No args: list styles and exit
  if (( $# == 0 )); then
    print "Available output styles:"
    local s
    for s in "${builtins[@]}" "${custom[@]}"; do
      if [[ "$s" == "$current" ]]; then
        print "  * $s (current)"
      else
        print "    $s"
      fi
    done
    return 0
  fi

  # Resolve target
  local target="$1"
  shift
  if [[ "$target" == "-" ]]; then
    if [[ ! -f "$prev_file" ]]; then
      print -u2 "ccstyle: no previous style recorded"
      return 1
    fi
    target=$(<"$prev_file")
  fi

  # Parse flags
  local no_launch=0
  while (( $# > 0 )); do
    case "$1" in
      -n|--no-launch) no_launch=1 ;;
      *) print -u2 "ccstyle: unknown option: $1"; return 1 ;;
    esac
    shift
  done

  # Validate target
  local valid=0 s
  for s in "${builtins[@]}" "${custom[@]}"; do
    if [[ "$s" == "$target" ]]; then
      valid=1
      break
    fi
  done
  if (( ! valid )); then
    print -u2 "ccstyle: unknown style: $target"
    print -u2 "  available: ${builtins[*]} ${custom[*]}"
    return 1
  fi

  if [[ "$target" == "$current" ]]; then
    print "ccstyle: already using $target"
  else
    mkdir -p "${prev_file:h}"
    print -r -- "$current" > "$prev_file"

    mkdir -p "${settings:h}"
    local tmp="${settings}.ccstyle.$$"
    if [[ -f "$settings" ]]; then
      jq --arg s "$target" '.outputStyle = $s' "$settings" > "$tmp" || { rm -f "$tmp"; return 1; }
    else
      jq -n --arg s "$target" '{outputStyle: $s}' > "$tmp" || { rm -f "$tmp"; return 1; }
    fi
    mv "$tmp" "$settings"
    print "ccstyle: $current → $target"
  fi

  if (( ! no_launch )); then
    if command -v claude >/dev/null 2>&1; then
      claude
    else
      print -u2 "ccstyle: 'claude' not found in PATH"
      return 1
    fi
  fi
}
