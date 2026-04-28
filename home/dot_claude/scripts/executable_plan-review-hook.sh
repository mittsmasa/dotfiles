#!/usr/bin/env bash
# plan-review-hook.sh
# plan.md への書き込みを検知して 3 本のレビュアを並列実行する
#
# レビュア構成:
#   - simplicity     (veto 権あり: fail なら他がどうあれ needs_revision)
#   - correctness
#   - verifiability
#
# 各レビュアの結果が壊れている / claude --print が失敗した場合、
# そのレビュアは「skipped」として扱い、残りの結果で判定する。
# 全レビュア skipped のときのみ verdict=error。
#
# 環境変数:
#   WORKFLOW_DIR        - 成果物ディレクトリ (default: .workflow)
#   MAX_REVIEW_ROUNDS   - 最大レビューラウンド数 (default: 3)
#   PLAN_REVIEW_PROMPTS - プロンプト配置ディレクトリ
#                         (default: ~/.claude/scripts/plan-review-prompts)

set -euo pipefail

WORKFLOW_DIR="${WORKFLOW_DIR:-.workflow}"
MAX_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"
PROMPTS_DIR="${PLAN_REVIEW_PROMPTS:-$HOME/.claude/scripts/plan-review-prompts}"
PLAN_FILE="$WORKFLOW_DIR/plan.md"
RESEARCH_FILE="$WORKFLOW_DIR/research.md"

REVIEWERS=(simplicity correctness verifiability)

# --- 前提チェック ---

[[ -f "$PLAN_FILE" ]] || exit 0

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *"plan.md" ]]; then
  exit 0
fi

for r in "${REVIEWERS[@]}"; do
  if [[ ! -f "$PROMPTS_DIR/$r.md" ]]; then
    echo "[plan-review] Missing prompt: $PROMPTS_DIR/$r.md" >&2
    exit 1
  fi
done

# --- ハッシュチェック ---

if command -v sha256sum >/dev/null 2>&1; then
  hash_cmd() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash_cmd() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

CURRENT_HASH=$(hash_cmd "$PLAN_FILE")
EXISTING_HASH=$(sed -n 's/.*hash=\([a-f0-9]*\).*/\1/p' "$PLAN_FILE" 2>/dev/null | head -1)

if [[ "$CURRENT_HASH" == "$EXISTING_HASH" ]]; then
  echo "[plan-review] No changes since last review. Skipping." >&2
  exit 0
fi

# --- ラウンド数チェック ---

CURRENT_ROUND=$(sed -n 's/.*round=\([0-9]*\).*/\1/p' "$PLAN_FILE" 2>/dev/null | head -1)
CURRENT_ROUND="${CURRENT_ROUND:-0}"
NEXT_ROUND=$((CURRENT_ROUND + 1))

if [[ "$NEXT_ROUND" -gt "$MAX_ROUNDS" ]]; then
  echo "[plan-review] Max rounds ($MAX_ROUNDS) reached. Manual review required." >&2
  exit 0
fi

# --- 並列レビュー実行 ---

echo "[plan-review] Starting review round $NEXT_ROUND (3 reviewers in parallel)..." >&2

USER_PROMPT="以下のファイルを読んでレビューしてください: $RESEARCH_FILE $PLAN_FILE"

run_reviewer() {
  local name="$1"
  local prompt_file="$PROMPTS_DIR/$name.md"
  local out="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${name}.raw"
  # Isolate TMPDIR per reviewer to avoid cmux-claude-node-options mktemp races
  # when multiple `claude --print` are invoked in parallel from the same hook.
  local tmp_dir
  tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/plan-review-${name}.XXXXXX")
  if TMPDIR="$tmp_dir" claude --print \
      --system-prompt "$(cat "$prompt_file")" \
      "$USER_PROMPT" \
      > "$out" 2>&1; then
    echo "ok" > "$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${name}.exit"
  else
    echo "fail:$?" > "$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${name}.exit"
  fi
  rm -rf "$tmp_dir"
}

pids=()
for r in "${REVIEWERS[@]}"; do
  run_reviewer "$r" &
  pids+=($!)
done

for pid in "${pids[@]}"; do
  wait "$pid" || true
done

# --- 各レビュアの verdict を抽出 ---

# JSON 抽出: ```json...``` でラップ・素のJSON・先頭にゴミがある場合に対応
extract_json() {
  local file="$1"
  # 1. コードブロックを剥がす
  local stripped
  stripped=$(sed -n '/^```/,/^```/{/^```/d;p;}' "$file")
  if [[ -n "$stripped" ]] && echo "$stripped" | jq -e . >/dev/null 2>&1; then
    echo "$stripped"
    return 0
  fi
  # 2. 素の JSON
  if jq -e . "$file" >/dev/null 2>&1; then
    cat "$file"
    return 0
  fi
  # 3. 最初の { から最後の } までを抜き出して試す
  local extracted
  extracted=$(sed -n '/^{/,/^}/p' "$file")
  if [[ -n "$extracted" ]] && echo "$extracted" | jq -e . >/dev/null 2>&1; then
    echo "$extracted"
    return 0
  fi
  return 1
}

# 疑似連想配列 (bash 3.2 互換: declare -A が使えないため printf -v で動的変数に格納)
# 変数名: VERDICT_<reviewer>, STATUS_<reviewer>
#   STATUS_*  = ok | skipped
#   VERDICT_* = pass | needs_revision | skipped
set_kv() { printf -v "$1" '%s' "$2"; }
get_kv() { local k="$1"; echo "${!k-}"; }

SKIPPED=()
FAILED=()

for r in "${REVIEWERS[@]}"; do
  raw="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${r}.raw"
  json_out="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${r}.json"
  exit_marker="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${r}.exit"
  exit_status=$(cat "$exit_marker" 2>/dev/null || echo "fail:unknown")

  if [[ "$exit_status" != "ok" ]]; then
    set_kv "STATUS_$r"  "skipped"
    set_kv "VERDICT_$r" "skipped"
    SKIPPED+=("$r")
    echo "[plan-review] $r: SKIPPED ($exit_status)" >&2
    continue
  fi

  if json=$(extract_json "$raw"); then
    echo "$json" > "$json_out"
    v=$(echo "$json" | jq -r '.verdict // "skipped"' 2>/dev/null)
    if [[ "$v" == "pass" || "$v" == "needs_revision" ]]; then
      set_kv "STATUS_$r"  "ok"
      set_kv "VERDICT_$r" "$v"
      [[ "$v" == "needs_revision" ]] && FAILED+=("$r")
      echo "[plan-review] $r: $v" >&2
    else
      set_kv "STATUS_$r"  "skipped"
      set_kv "VERDICT_$r" "skipped"
      SKIPPED+=("$r")
      echo "[plan-review] $r: SKIPPED (no valid verdict)" >&2
    fi
  else
    set_kv "STATUS_$r"  "skipped"
    set_kv "VERDICT_$r" "skipped"
    SKIPPED+=("$r")
    echo "[plan-review] $r: SKIPPED (unparseable JSON)" >&2
  fi
done

# --- aggregator ---

# 全 skipped → error
if [[ "${#SKIPPED[@]}" -eq "${#REVIEWERS[@]}" ]]; then
  FINAL_VERDICT="error"
# simplicity が fail または ok でない → needs_revision (veto)
elif [[ "$(get_kv VERDICT_simplicity)" == "needs_revision" ]]; then
  FINAL_VERDICT="needs_revision"
# 他のレビュアが fail → needs_revision
elif [[ "${#FAILED[@]}" -gt 0 ]]; then
  FINAL_VERDICT="needs_revision"
else
  FINAL_VERDICT="pass"
fi

# --- plan.md への書き戻し ---

FINAL_HASH=$(hash_cmd "$PLAN_FILE")

# join helper
join_csv() {
  local IFS=,
  echo "$*"
}
SKIPPED_STR=$(join_csv "${SKIPPED[@]:-}")
FAILED_STR=$(join_csv "${FAILED[@]:-}")
[[ -z "$SKIPPED_STR" ]] && SKIPPED_STR="none"
[[ -z "$FAILED_STR" ]] && FAILED_STR="none"

MARKER="<!-- auto-review: verdict=$FINAL_VERDICT; hash=$FINAL_HASH; round=$NEXT_ROUND; skipped=[$SKIPPED_STR]; failed=[$FAILED_STR] -->"

sedi() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

if grep -q '<!-- auto-review:' "$PLAN_FILE"; then
  # マーカー行全体を置換 (sed の区切りに | を使い、かつエスケープ)
  ESCAPED_MARKER=$(printf '%s\n' "$MARKER" | sed -e 's/[\/&|]/\\&/g')
  sedi "s|<!-- auto-review:.*-->|$ESCAPED_MARKER|" "$PLAN_FILE"
else
  echo "$MARKER" >> "$PLAN_FILE"
fi

sedi "s/^- Status: .*/- Status: $FINAL_VERDICT/" "$PLAN_FILE"
sedi "s/^- Round: .*/- Round: $NEXT_ROUND/" "$PLAN_FILE"
sedi "s/^- Last Review Hash: .*/- Last Review Hash: $FINAL_HASH/" "$PLAN_FILE"

if [[ "$FINAL_VERDICT" == "pass" ]]; then
  sedi "s/^- Plan Status: .*/- Plan Status: complete/" "$PLAN_FILE"
fi

# --- 集約レビューレポートを生成 ---

REPORT="$WORKFLOW_DIR/review-round-${NEXT_ROUND}.md"
{
  echo "# Review Round $NEXT_ROUND"
  echo ""
  echo "## Final Verdict: $FINAL_VERDICT"
  echo ""
  echo "- skipped: [$SKIPPED_STR]"
  echo "- failed: [$FAILED_STR]"
  echo ""
  for r in "${REVIEWERS[@]}"; do
    echo "## $r — $(get_kv VERDICT_$r)"
    echo ""
    json_out="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${r}.json"
    raw="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${r}.raw"
    if [[ "$(get_kv STATUS_$r)" == "ok" && -f "$json_out" ]]; then
      echo '```json'
      cat "$json_out"
      echo '```'
    else
      echo "_(skipped — raw output preserved at \`$(basename "$raw")\`)_"
    fi
    echo ""
  done
} > "$REPORT"

echo "[plan-review] Round $NEXT_ROUND: $FINAL_VERDICT (skipped=[$SKIPPED_STR], failed=[$FAILED_STR])" >&2
echo "[plan-review] Report: $REPORT" >&2
