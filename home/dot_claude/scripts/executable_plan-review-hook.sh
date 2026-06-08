#!/usr/bin/env bash
# plan-review-hook.sh
# plan.md への書き込みを検知して 3 本のレビュアを並列実行する
#
# 前提: bash 3.2 互換（macOS デフォルトの /bin/bash 3.2 でも動く）。
#       連想配列は使えないので、動的変数名 + indirect expansion (${!var}) で代替している。
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
#   WORKFLOW_DIR              - 成果物ディレクトリ
#                               (未設定時は tool_input.file_path の親 dir を採用。
#                                `.workflow` symlink でも実体 dir に解決される)
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
#      d. aggregate_verdict で round の verdict を決定
#      e. report (review-round-N.md) を生成
#      f. verdict が pass / error なら break
#      g. run_applier で plan.md を直接編集
#      h. applier が exit 非ゼロ → plan.md.bak から復元して break
#      i. applier 完了後、plan.md が `Approval Status: needs_human_review` に
#         遷移していたら break (escalate)
#      j. NEXT_ROUND を 1 進めて MAX_ROUNDS を超えたら break、超えなければ次イテレーションへ
#   5. ループ終了後、最終 verdict / hash を plan.md に書き戻す (1 回だけ)
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
#
# plan.md に書き戻す内容 (ループ終了後 1 回):
#   - マーカー行: `<!-- auto-review: verdict=...; hash=...; round=...; skipped=[...]; failed=[...] -->`
#     既存マーカー行があれば一度削除してから末尾に新規追記する（任意の文字を含めても安全）
#   - `- Status: ...` 行を最終 verdict で更新
#   - verdict=pass のときのみ `- Plan Status: ...` を complete に更新
#   - 旧 `- Round:` / `- Last Review Hash:` 行は書き戻し対象外（マーカーが真のソース）
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

# INPUT を先に読んで FILE_PATH をガード。WORKFLOW_DIR は環境変数が明示
# 設定されていればそれを優先、未設定なら FILE_PATH の親 dir を採用する。
# `.workflow` が symlink でも `cd ... && pwd -P` で実体 dir に解決されるので
# 既存の symlink 利用フローとも等価。
INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *"plan.md" ]]; then
  exit 0
fi

if [[ -z "${WORKFLOW_DIR:-}" ]]; then
  WORKFLOW_DIR=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd -P) || exit 0
fi
MAX_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"
PROMPTS_DIR="${PLAN_REVIEW_PROMPTS:-$HOME/.claude/scripts/plan-review-prompts}"
REVIEWER_BIN="${PLAN_REVIEW_REVIEWER_CMD:-claude}"
APPLIER_BIN="${PLAN_REVIEW_APPLIER_CMD:-claude}"
PLAN_FILE="$WORKFLOW_DIR/plan.md"
RESEARCH_FILE="$WORKFLOW_DIR/research.md"
MVP_STANCE_FILE="$PROMPTS_DIR/_mvp-stance.md"

REVIEWERS=(simplicity correctness verifiability)

# レビュア状態を保持する擬似連想配列:
#   STATUS_<reviewer>  = ok | skipped
#   VERDICT_<reviewer> = pass | needs_revision | skipped
#
# macOS デフォルトの bash 3.2 では `declare -A` が使えない。Homebrew bash 4+ を
# 前提にすると環境差で hook が落ちるため、ここでは reviewer 名を変数名の一部に
# 埋め込み、indirect expansion (`${!var}`) で読み出す形で代替している。
# 名前は固定 3 種（simplicity / correctness / verifiability）で識別子として
# そのまま使えることが前提。動的にユーザー入力から作るときは要注意。
get_status()  { local v="STATUS_$1";  echo "${!v:-}"; }
set_status()  { eval "STATUS_$1=\"\$2\""; }
get_verdict() { local v="VERDICT_$1"; echo "${!v:-}"; }
set_verdict() { eval "VERDICT_$1=\"\$2\""; }

# --- 前提チェック ---

[[ -f "$PLAN_FILE" ]] || exit 0

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
       --add-dir "$WORKFLOW_DIR" \
       --system-prompt "$sys_prompt" \
       "$user_prompt" \
       > "$out" 2>&1; then
    echo "ok" > "$WORKFLOW_DIR/review-round-${round}-${name}.exit"
  else
    echo "fail:$?" > "$WORKFLOW_DIR/review-round-${round}-${name}.exit"
  fi
  rm -rf "$tmp_dir"
}

# verdict 集計。STATUS / VERDICT / SKIPPED / FAILED / FINAL_VERDICT / SKIPPED_STR / FAILED_STR
# をグローバルに更新する（メインループとの共有が多いため関数化はしてもグローバル）。
aggregate_verdict() {
  local round="$1"
  SKIPPED=()
  FAILED=()
  local r raw json_out exit_marker exit_status json v
  for r in "${REVIEWERS[@]}"; do
    raw="$WORKFLOW_DIR/review-round-${round}-${r}.raw"
    json_out="$WORKFLOW_DIR/review-round-${round}-${r}.json"
    exit_marker="$WORKFLOW_DIR/review-round-${round}-${r}.exit"
    exit_status=$(cat "$exit_marker" 2>/dev/null || echo "fail:unknown")

    if [[ "$exit_status" != "ok" ]]; then
      set_status "$r" "skipped"
      set_verdict "$r" "skipped"
      SKIPPED+=("$r")
      echo "[plan-review] $r: SKIPPED ($exit_status)" >&2
      continue
    fi

    if json=$(extract_json "$raw"); then
      echo "$json" > "$json_out"
      v=$(echo "$json" | jq -r '.verdict // "skipped"' 2>/dev/null)
      if [[ "$v" == "pass" || "$v" == "needs_revision" ]]; then
        set_status "$r" "ok"
        set_verdict "$r" "$v"
        if [[ "$v" == "needs_revision" ]]; then FAILED+=("$r"); fi
        echo "[plan-review] $r: $v" >&2
      else
        set_status "$r" "skipped"
        set_verdict "$r" "skipped"
        SKIPPED+=("$r")
        echo "[plan-review] $r: SKIPPED (no valid verdict)" >&2
      fi
    else
      set_status "$r" "skipped"
      set_verdict "$r" "skipped"
      SKIPPED+=("$r")
      echo "[plan-review] $r: SKIPPED (unparseable JSON)" >&2
    fi
  done

  if [[ "${#SKIPPED[@]}" -eq "${#REVIEWERS[@]}" ]]; then
    FINAL_VERDICT="error"
  elif [[ "$(get_verdict simplicity)" == "needs_revision" ]]; then
    FINAL_VERDICT="needs_revision"
  elif [[ "${#FAILED[@]}" -gt 0 ]]; then
    FINAL_VERDICT="needs_revision"
  else
    FINAL_VERDICT="pass"
  fi

  SKIPPED_STR=$(join_csv "${SKIPPED[@]:-}")
  FAILED_STR=$(join_csv "${FAILED[@]:-}")
  if [[ -z "$SKIPPED_STR" ]]; then SKIPPED_STR="none"; fi
  if [[ -z "$FAILED_STR" ]]; then FAILED_STR="none"; fi
  return 0
}

# applier 実行 + escalate 検出。成功 0 / applier 失敗 1 / escalate 2 を返す。
run_applier() {
  local round="$1"
  local report="$WORKFLOW_DIR/review-round-${round}.md"
  cp "$PLAN_FILE" "$WORKFLOW_DIR/plan.md.bak"

  local workflow_abs
  workflow_abs=$(realpath "$WORKFLOW_DIR" 2>/dev/null || echo "$WORKFLOW_DIR")
  local research_abs="$workflow_abs/research.md"
  local plan_abs="$workflow_abs/plan.md"
  local report_abs="$workflow_abs/review-round-${round}.md"

  local user_prompt="以下を読んで plan.md を編集してください:
- $research_abs
- $plan_abs
- $report_abs"

  echo "[applier] starting (round $round)" >&2
  if (
    cd "$workflow_abs" && \
    PLAN_REVIEW_HOOK_RUNNING=1 WORKFLOW_DIR="$workflow_abs" \
      "$APPLIER_BIN" --print \
      --allowedTools Edit,Read \
      --system-prompt "$(cat "$PROMPTS_DIR/applier.md")" \
      "$user_prompt" >&2
  ); then
    echo "[applier] exit 0" >&2
  else
    echo "[applier] exit non-zero, rolling back" >&2
    cp "$WORKFLOW_DIR/plan.md.bak" "$PLAN_FILE"
    return 1
  fi

  if grep -q '^- Approval Status: needs_human_review' "$PLAN_FILE"; then
    echo "[applier] escalated (Approval Status: needs_human_review). Breaking loop." >&2
    return 2
  fi
  return 0
}

# --- メインループ ---
# 1 イテレーション = 1 round (reviewers 並列 → aggregator → 必要なら applier)。
# pass / error / escalate / applier 失敗 / max rounds のいずれかで break。

LOOP_BREAK_REASON=""
LAST_ROUND="$CURRENT_ROUND"
FINAL_VERDICT=""
SKIPPED_STR="none"
FAILED_STR="none"
SKIPPED=()
FAILED=()

while :; do
  PREV_ROUND=$((NEXT_ROUND - 1))

  # --- build peers.md ---
  # 前ラウンドの per-reviewer JSON から生成。round 1 では前ラウンドが無いので空ファイル。
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

  # --- run reviewers (parallel) ---
  echo "[plan-review] Starting review round $NEXT_ROUND (3 reviewers in parallel)..." >&2
  pids=()
  for r in "${REVIEWERS[@]}"; do
    run_reviewer "$r" "$NEXT_ROUND" &
    pids+=($!)
  done
  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done

  # --- aggregate verdict ---
  aggregate_verdict "$NEXT_ROUND"

  # --- write round report ---
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
      r_verdict=$(get_verdict "$r")
      r_status=$(get_status "$r")
      echo "## $r — ${r_verdict:-unknown}"
      echo ""
      json_out="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${r}.json"
      raw="$WORKFLOW_DIR/review-round-${NEXT_ROUND}-${r}.raw"
      if [[ "$r_status" == "ok" && -f "$json_out" ]]; then
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

  # --- break or continue ---
  if [[ "$FINAL_VERDICT" == "pass" || "$FINAL_VERDICT" == "error" ]]; then
    LOOP_BREAK_REASON="$FINAL_VERDICT"
    break
  fi

  # --- run applier (needs_revision のときのみ) ---
  if run_applier "$NEXT_ROUND"; then
    :
  else
    rc=$?
    if [[ "$rc" -eq 2 ]]; then
      LOOP_BREAK_REASON="escalate"
    else
      LOOP_BREAK_REASON="applier_failed"
    fi
    break
  fi

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

# マーカー行は「既存行を削除 → 末尾に追記」で更新する。
# sed 置換だと marker に `\` `&` `|` 等が含まれた場合に壊れるため、行ベースで扱う。
TMP_PLAN=$(mktemp "${TMPDIR:-/tmp}/plan-marker.XXXXXX")
grep -v '<!-- auto-review:' "$PLAN_FILE" > "$TMP_PLAN" || true
# 末尾に改行が無い場合の連結事故を防ぐため、先頭に改行を 1 つ挟んでから追記
printf '\n%s\n' "$MARKER" >> "$TMP_PLAN"
mv "$TMP_PLAN" "$PLAN_FILE"

sedi "s/^- Status: .*/- Status: $FINAL_VERDICT/" "$PLAN_FILE"

if [[ "$FINAL_VERDICT" == "pass" ]]; then
  sedi "s/^- Plan Status: .*/- Plan Status: complete/" "$PLAN_FILE"
fi

echo "[plan-review] Loop ended: verdict=$FINAL_VERDICT, last_round=$LAST_ROUND, reason=${LOOP_BREAK_REASON:-unknown} (skipped=[$SKIPPED_STR], failed=[$FAILED_STR])" >&2
echo "[plan-review] Final report: $WORKFLOW_DIR/review-round-${LAST_ROUND}.md" >&2
