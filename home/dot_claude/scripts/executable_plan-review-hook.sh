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
#   WORKFLOW_DIR              - 成果物ディレクトリ (default: .workflow)
#   MAX_REVIEW_ROUNDS         - 最大レビューラウンド数 (default: 3)
#   PLAN_REVIEW_PROMPTS       - プロンプト配置ディレクトリ
#                               (default: ~/.claude/scripts/plan-review-prompts)
#   PLAN_REVIEW_REVIEWER_CMD  - reviewer コマンド差し替え (テスト用, default: claude)
#   PLAN_REVIEW_APPLIER_CMD   - applier コマンド差し替え (テスト用, default: claude)
#
# 全体フロー:
#   1. plan.md の書き込みを検知（PostToolUse hook）
#   2. plan.md と前回 hash を比較 → 同一ならスキップ
#   3. ラウンド数確認（MAX_REVIEW_ROUNDS 超過なら手動レビューを促してスキップ）
#   4. 内部ループ開始 (1 round = reviewers 並列 → aggregator → 必要なら applier):
#      a. 前ラウンドの他 reviewer 出力を peers.md に集約 (1 ラウンド遅延)
#      b. 3 本のレビュアを `$REVIEWER_BIN --print` で並列起動 → wait
#      c. 各 raw 出力から JSON 抽出 (コードフェンス / 素 JSON / 抽出フォールバック)
#      d. aggregator で round の verdict を決定
#      e. report (review-round-N.md) を生成
#      f. verdict が pass / error なら break
#      g. applier フェーズ: `$APPLIER_BIN --print` で plan.md を直接編集
#      h. applier が exit 非ゼロ → plan.md.bak から復元して break
#      i. applier 完了後、plan.md が `Approval Status: needs_human_review` に
#         遷移していたら break (escalate)
#      j. NEXT_ROUND を 1 進めて MAX_ROUNDS を超えたら break、超えなければ次イテレーションへ
#   5. ループ終了後、最終 verdict / hash / round を plan.md に書き戻す (1 回だけ)
#
# Aggregator (各ラウンド内):
#   - 全レビュア skipped → verdict=error
#   - simplicity が needs_revision → verdict=needs_revision (veto)
#   - 他のレビュアが needs_revision → verdict=needs_revision
#   - 上記以外 → verdict=pass
#
# Applier フェーズ (verdict=needs_revision のときのみ実行):
#   - plan.md.bak を作成 (失敗時 rollback 用)
#   - `$APPLIER_BIN --print --allowedTools Edit,Read` で起動、system prompt は
#     `$PROMPTS_DIR/applier.md`
#   - 編集スコープ・escalate 条件 (`Approval Status: needs_human_review` への
#     遷移など) は applier.md プロンプト側で制約する
#   - applier 失敗時は plan.md.bak から自動 rollback → ループを break
#
# Hash:
#   - plan.md に書き戻す `hash=` はループ終了時点の plan.md ハッシュ
#   - 同じ内容で再度 plan.md が書かれたら冒頭の hash 比較で skip
#   - 内容が変われば次回 hook 発火で改めてレビューが走る
#   (旧仕様の PRE_APPLIER_HASH 据え置きは in-process ループ化により不要になった)
#
# plan.md に書き戻す内容 (ループ終了後 1 回):
#   - マーカー行 (既存があれば置換、なければ末尾に追記):
#       <!-- auto-review: verdict=...; hash=...; round=...; skipped=[...]; failed=[...] -->
#   - `- Status: ...` 行を最終 verdict で更新
#   - `- Round: ...` 行を最後に完走したラウンド番号で更新
#   - `- Last Review Hash: ...` 行を FINAL_HASH で更新
#   - verdict=pass のときのみ `- Plan Status: ...` を complete に更新
#
# 出力ファイル (各ラウンドごとに分かれる):
#   $WORKFLOW_DIR/review-round-N.md         - 集約レポート
#   $WORKFLOW_DIR/review-round-N-<r>.json   - 各レビュアの抽出済み JSON
#   $WORKFLOW_DIR/review-round-N-<r>.raw    - 各レビュアの生出力
#   $WORKFLOW_DIR/review-round-N-peers.md   - 前ラウンドの他者 verdict
#   $WORKFLOW_DIR/plan.md.bak               - applier 用バックアップ (最後の applier 直前)

set -euo pipefail

if [[ -n "${PLAN_REVIEW_HOOK_RUNNING:-}" ]]; then
  echo "[plan-review-hook] re-entrant call skipped" >&2
  exit 0
fi

WORKFLOW_DIR="${WORKFLOW_DIR:-.workflow}"
MAX_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"
PROMPTS_DIR="${PLAN_REVIEW_PROMPTS:-$HOME/.claude/scripts/plan-review-prompts}"
REVIEWER_BIN="${PLAN_REVIEW_REVIEWER_CMD:-claude}"
APPLIER_BIN="${PLAN_REVIEW_APPLIER_CMD:-claude}"
PLAN_FILE="$WORKFLOW_DIR/plan.md"
RESEARCH_FILE="$WORKFLOW_DIR/research.md"
MVP_STANCE_FILE="$PROMPTS_DIR/_mvp-stance.md"

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

# --- ラウンド数チェック (前回ループ終了時の round が MAX_ROUNDS なら manual に委ねる) ---

CURRENT_ROUND=$(sed -n 's/.*round=\([0-9]*\).*/\1/p' "$PLAN_FILE" 2>/dev/null | head -1)
CURRENT_ROUND="${CURRENT_ROUND:-0}"
NEXT_ROUND=$((CURRENT_ROUND + 1))

if [[ "$NEXT_ROUND" -gt "$MAX_ROUNDS" ]]; then
  echo "[plan-review] Max rounds ($MAX_ROUNDS) reached. Manual review required." >&2
  exit 0
fi

# --- ヘルパ ---

# JSON 抽出: ```json...``` でラップ・素のJSON・先頭にゴミがある場合に対応
extract_json() {
  local file="$1"
  local stripped
  stripped=$(sed -n '/^```/,/^```/{/^```/d;p;}' "$file")
  if [[ -n "$stripped" ]] && echo "$stripped" | jq -e . >/dev/null 2>&1; then
    echo "$stripped"
    return 0
  fi
  if jq -e . "$file" >/dev/null 2>&1; then
    cat "$file"
    return 0
  fi
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

join_csv() {
  local IFS=,
  echo "$*"
}

run_reviewer() {
  local name="$1"
  local round="$2"
  local prev_round=$((round - 1))
  local prompt_file="$PROMPTS_DIR/$name.md"
  local prev_self_json="$WORKFLOW_DIR/review-round-${prev_round}-${name}.json"
  local peers_file="$WORKFLOW_DIR/review-round-${round}-peers.md"
  local out="$WORKFLOW_DIR/review-round-${round}-${name}.raw"
  local user_prompt
  user_prompt="以下のファイルを読んでレビューしてください:
- $RESEARCH_FILE
- $PLAN_FILE
- $prev_self_json (前ラウンドの自分のレポート、無ければ無視)
- $peers_file (他 reviewer の前ラウンド verdict、無ければ無視)"
  local sys_prompt
  if [[ -f "$MVP_STANCE_FILE" ]]; then
    sys_prompt="$(cat "$MVP_STANCE_FILE")

---

$(cat "$prompt_file")"
  else
    sys_prompt="$(cat "$prompt_file")"
  fi
  # Isolate TMPDIR per reviewer to avoid cmux-claude-node-options mktemp races
  # when multiple `claude --print` are invoked in parallel from the same hook.
  # PLAN_REVIEW_REVIEWER_{NAME,ROUND} はテスト時の mock reviewer 用。
  # 本物の claude には無害。
  local tmp_dir
  tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/plan-review-${name}.XXXXXX")
  if TMPDIR="$tmp_dir" \
     PLAN_REVIEW_REVIEWER_NAME="$name" \
     PLAN_REVIEW_REVIEWER_ROUND="$round" \
     "$REVIEWER_BIN" --print \
       --system-prompt "$sys_prompt" \
       "$user_prompt" \
       > "$out" 2>&1; then
    echo "ok" > "$WORKFLOW_DIR/review-round-${round}-${name}.exit"
  else
    echo "fail:$?" > "$WORKFLOW_DIR/review-round-${round}-${name}.exit"
  fi
  rm -rf "$tmp_dir"
}

# --- メインループ ---
# 1 イテレーション = 1 round (reviewers 並列 → aggregator → 必要なら applier)。
# pass / error / escalate / applier 失敗 / max rounds のいずれかで break。

LOOP_BREAK_REASON=""
LAST_ROUND="$CURRENT_ROUND"
FINAL_VERDICT=""
SKIPPED_STR="none"
FAILED_STR="none"

while :; do
  PREV_ROUND=$((NEXT_ROUND - 1))

  # peers.md を前ラウンドの per-reviewer JSON から生成。
  # round 1 では前ラウンドが無いので空ファイルになる。
  PEERS_FILE="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-peers.md"
  {
    if [[ "$PREV_ROUND" -ge 1 ]]; then
      echo "# Peers (前ラウンドの他 reviewer の verdict / summary / must_remove)"
      echo ""
      for peer in "${REVIEWERS[@]}"; do
        peer_json="$WORKFLOW_DIR/review-round-${PREV_ROUND}-${peer}.json"
        echo "## ${peer}"
        if [[ -f "$peer_json" ]]; then
          verdict=$(jq -r '.verdict // "unknown"' "$peer_json" 2>/dev/null || echo "unknown")
          summary=$(jq -r '.summary // ""' "$peer_json" 2>/dev/null || echo "")
          echo "- verdict: ${verdict}"
          echo "- summary: ${summary}"
          if jq -e '.must_remove' "$peer_json" >/dev/null 2>&1; then
            echo "- must_remove:"
            jq -r '.must_remove[]? | "  - " + .' "$peer_json" 2>/dev/null || true
          fi
        else
          echo "- (no previous report)"
        fi
        echo ""
      done
    fi
  } > "$PEERS_FILE"

  echo "[plan-review] Starting review round $NEXT_ROUND (3 reviewers in parallel)..." >&2

  # reviewers 並列実行
  pids=()
  for r in "${REVIEWERS[@]}"; do
    run_reviewer "$r" "$NEXT_ROUND" &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done

  # 各レビュアの verdict を抽出
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

  # aggregator
  if [[ "${#SKIPPED[@]}" -eq "${#REVIEWERS[@]}" ]]; then
    FINAL_VERDICT="error"
  elif [[ "$(get_kv VERDICT_simplicity)" == "needs_revision" ]]; then
    FINAL_VERDICT="needs_revision"
  elif [[ "${#FAILED[@]}" -gt 0 ]]; then
    FINAL_VERDICT="needs_revision"
  else
    FINAL_VERDICT="pass"
  fi

  SKIPPED_STR=$(join_csv "${SKIPPED[@]:-}")
  FAILED_STR=$(join_csv "${FAILED[@]:-}")
  [[ -z "$SKIPPED_STR" ]] && SKIPPED_STR="none"
  [[ -z "$FAILED_STR" ]] && FAILED_STR="none"

  # 集約レポート (applier に渡すために書き戻しより前に作る)
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

  LAST_ROUND="$NEXT_ROUND"

  # ループ終了判定 (verdict-based)
  if [[ "$FINAL_VERDICT" == "pass" || "$FINAL_VERDICT" == "error" ]]; then
    LOOP_BREAK_REASON="$FINAL_VERDICT"
    break
  fi

  # applier フェーズ (needs_revision のときのみ)
  cp "$PLAN_FILE" "$WORKFLOW_DIR/plan.md.bak"

  RESEARCH_ABS=$(realpath "$RESEARCH_FILE" 2>/dev/null || echo "$RESEARCH_FILE")
  PLAN_ABS=$(realpath "$PLAN_FILE" 2>/dev/null || echo "$PLAN_FILE")
  REPORT_ABS=$(realpath "$REPORT" 2>/dev/null || echo "$REPORT")
  WORKFLOW_ABS=$(realpath "$WORKFLOW_DIR" 2>/dev/null || echo "$WORKFLOW_DIR")

  USER_PROMPT_APPLIER="以下を読んで plan.md を編集してください:
- $RESEARCH_ABS
- $PLAN_ABS
- $REPORT_ABS"

  echo "[applier] starting (round $NEXT_ROUND)" >&2
  if (
    cd "$WORKFLOW_ABS" && \
    PLAN_REVIEW_HOOK_RUNNING=1 WORKFLOW_DIR="$WORKFLOW_ABS" \
      "$APPLIER_BIN" --print \
      --allowedTools Edit,Read \
      --system-prompt "$(cat "$PROMPTS_DIR/applier.md")" \
      "$USER_PROMPT_APPLIER" >&2
  ); then
    echo "[applier] exit 0" >&2
  else
    echo "[applier] exit non-zero, rolling back" >&2
    cp "$WORKFLOW_DIR/plan.md.bak" "$PLAN_FILE"
    LOOP_BREAK_REASON="applier_failed"
    break
  fi

  # escalate 検出 (applier が Approval Status を needs_human_review に書き換えていたら抜ける)
  if grep -q '^- Approval Status: needs_human_review' "$PLAN_FILE"; then
    echo "[applier] escalated (Approval Status: needs_human_review). Breaking loop." >&2
    LOOP_BREAK_REASON="escalate"
    break
  fi

  # 次ラウンドへ
  NEXT_ROUND=$((NEXT_ROUND + 1))
  if [[ "$NEXT_ROUND" -gt "$MAX_ROUNDS" ]]; then
    echo "[plan-review] Max rounds ($MAX_ROUNDS) reached during loop. Stopping." >&2
    LOOP_BREAK_REASON="max_rounds"
    break
  fi
done

# --- plan.md への書き戻し (ループ終了後 1 回) ---

FINAL_HASH=$(hash_cmd "$PLAN_FILE")
MARKER="<!-- auto-review: verdict=$FINAL_VERDICT; hash=$FINAL_HASH; round=$LAST_ROUND; skipped=[$SKIPPED_STR]; failed=[$FAILED_STR] -->"

sedi() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

if grep -q '<!-- auto-review:' "$PLAN_FILE"; then
  ESCAPED_MARKER=$(printf '%s\n' "$MARKER" | sed -e 's/[\/&|]/\\&/g')
  sedi "s|<!-- auto-review:.*-->|$ESCAPED_MARKER|" "$PLAN_FILE"
else
  echo "$MARKER" >> "$PLAN_FILE"
fi

sedi "s/^- Status: .*/- Status: $FINAL_VERDICT/" "$PLAN_FILE"
sedi "s/^- Round: .*/- Round: $LAST_ROUND/" "$PLAN_FILE"
sedi "s/^- Last Review Hash: .*/- Last Review Hash: $FINAL_HASH/" "$PLAN_FILE"

if [[ "$FINAL_VERDICT" == "pass" ]]; then
  sedi "s/^- Plan Status: .*/- Plan Status: complete/" "$PLAN_FILE"
fi

echo "[plan-review] Loop ended: verdict=$FINAL_VERDICT, last_round=$LAST_ROUND, reason=${LOOP_BREAK_REASON:-unknown} (skipped=[$SKIPPED_STR], failed=[$FAILED_STR])" >&2
echo "[plan-review] Final report: $WORKFLOW_DIR/review-round-${LAST_ROUND}.md" >&2
