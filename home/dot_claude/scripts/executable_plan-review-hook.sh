#!/usr/bin/env bash
# plan-review-hook.sh
# plan.md への書き込みを検知して 4 本のレビュアを並列実行する
#
# 前提: bash 3.2 互換（macOS デフォルトの /bin/bash 3.2 でも動く）。
#       連想配列は使えないので、動的変数名 + indirect expansion (${!var}) で代替している。
#
# レビュア構成:
#   - simplicity     (veto 権あり: fail なら他がどうあれ needs_revision)
#   - correctness
#   - verifiability
#   - security
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
#   PLAN_REVIEW_REVIEWER_TIMEOUT - reviewer 1 回あたりの秒数上限 (default: 300)
#   PLAN_REVIEW_APPLIER_TIMEOUT  - applier 1 回あたりの秒数上限 (default: 300)
#   PLAN_REVIEW_MODEL         - reviewer / applier に渡すモデル (default: claude-opus-5-5)
#                               settings.json のデフォルトモデル (claude-sonnet[1m] 等) が
#                               非対話環境で使えないことがあるため常に明示する
#
# 全体フロー:
#   1. plan.md の書き込みを検知（PostToolUse hook）
#      対象は `*/.workflow/plan.md` / `*/.workflow/*/plan.md` / `*/.claude/workflow/*/plan.md` のみ
#   2. 承認後はスキップ: 行頭の `Approval Status:` が approved / needs_human_review、
#      または `Plan Status: done`。needs_human_review のときだけ再開手順を additionalContext で返す
#   3. マーカー行の hash と現在の hash を比較 → 同一ならスキップ
#   4. ラウンド数確認（MAX_REVIEW_ROUNDS 超過なら再開手順を additionalContext で返してスキップ）
#   5. 内部ループ開始 (1 round = reviewers 並列 → aggregator → 必要なら applier):
#      a. 前ラウンドの他 reviewer 出力を peers.md に集約 (1 ラウンド遅延)
#      b. 4 本のレビュアを `$REVIEWER_BIN --print` で並列起動 → wait
#      c. 各 raw 出力から JSON 抽出 (コードフェンス / 素 JSON / 抽出フォールバック)
#      d. aggregate_verdict で round の verdict を決定
#      e. report (review-round-N.md) を生成
#      f. verdict が pass / error なら break
#      g. このラウンドが MAX_ROUNDS なら applier を回さず break (applier の編集が未レビューで残るのを防ぐ)
#      h. run_applier で plan.md を直接編集し、差分を review-round-N.md に `## Applier diff` として追記
#      i. applier が exit 非ゼロ → plan.md.bak から復元して break
#      j. applier 完了後、plan.md が `Approval Status: needs_human_review` に
#         遷移していたら break (escalate)
#      k. NEXT_ROUND を 1 進めて次イテレーションへ
#   6. ループ終了後、最終 verdict / hash を plan.md に書き戻す (1 回だけ)
#   7. verdict / 終了理由 / レポートパス / main session が次にすることを
#      stdout に hookSpecificOutput.additionalContext の JSON で返す
#      (PostToolUse の stderr は exit 0 だと Claude に渡らないため)。stdout にはこの JSON 以外を出さない
#
# Aggregator (各ラウンド内):
#   - 全レビュア skipped → verdict=error
#   - simplicity が needs_revision → verdict=needs_revision (veto)
#   - 他のレビュアが needs_revision → verdict=needs_revision
#   - 上記以外 → verdict=pass
#
# Applier フェーズ (verdict=needs_revision のときのみ実行):
#   - plan.md.bak を作成 (失敗時 rollback 用)
#   - `$APPLIER_BIN --print --tools Read,Edit` で起動、system prompt は
#     `$PROMPTS_DIR/applier.md`
#   - 編集スコープ・escalate 条件 (`Approval Status: needs_human_review` への
#     遷移など) は applier.md プロンプト側で制約する
#   - applier 失敗時は plan.md.bak から自動 rollback → ループを break
#
# Hash:
#   - plan_hash = マーカー行を除き、末尾の空行を詰めた本文の sha256
#   - 書き戻す `hash=` は Status 行の書き換え後に計算するので、書き戻し後のファイルと一致する
#   - 同じ内容で再度 plan.md が書かれたら冒頭の hash 比較で skip
#   - `hash=` / `round=` はマーカー行からだけ読む（本文の同じ文字列を拾わない）
#
# plan.md に書き戻す内容 (ループ終了後 1 回):
#   - マーカー行: `<!-- auto-review: verdict=...; hash=...; round=...; skipped=[...]; failed=[...] -->`
#     既存マーカー行があれば一度削除してから末尾に新規追記する（任意の文字を含めても安全）
#   - `- Review Status: ...` 行を最終 verdict で更新
#   - verdict=pass のときのみ `- Plan Status: ...` を complete に更新
#   - 旧 `- Round:` / `- Last Review Hash:` 行は書き戻し対象外（マーカーが真のソース）
#
# 出力ファイル (各ラウンドごとに分かれる):
#   $WORKFLOW_DIR/review-round-N.md         - 集約レポート (applier が走ったら末尾に `## Applier diff`)
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

# 任意リポジトリの docs/plan.md 等で Opus を 4 本走らせないよう、workflow の task dir に限る
case "$FILE_PATH" in
  */.workflow/plan.md|*/.workflow/*/plan.md|*/.claude/workflow/*/plan.md) ;;
  *) exit 0 ;;
esac

if [[ -z "${WORKFLOW_DIR:-}" ]]; then
  WORKFLOW_DIR=$(cd "$(dirname "$FILE_PATH")" 2>/dev/null && pwd -P) || exit 0
fi
MAX_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"
PROMPTS_DIR="${PLAN_REVIEW_PROMPTS:-$HOME/.claude/scripts/plan-review-prompts}"
REVIEWER_BIN="${PLAN_REVIEW_REVIEWER_CMD:-claude}"
APPLIER_BIN="${PLAN_REVIEW_APPLIER_CMD:-claude}"
REVIEW_MODEL="${PLAN_REVIEW_MODEL:-claude-opus-5-5}"
# 1 呼び出しあたりの上限（秒）。claude --print が混雑等で長時間化しても
# .exit を確実に書いて後始末できるようにするための保険。
REVIEWER_TIMEOUT="${PLAN_REVIEW_REVIEWER_TIMEOUT:-300}"
APPLIER_TIMEOUT="${PLAN_REVIEW_APPLIER_TIMEOUT:-300}"
PLAN_FILE="$WORKFLOW_DIR/plan.md"
RESEARCH_FILE="$WORKFLOW_DIR/research.md"
MVP_STANCE_FILE="$PROMPTS_DIR/_mvp-stance.md"

REVIEWERS=(simplicity correctness verifiability security)

# レビュア状態を保持する擬似連想配列:
#   STATUS_<reviewer>  = ok | skipped
#   VERDICT_<reviewer> = pass | needs_revision | skipped
#
# macOS デフォルトの bash 3.2 では `declare -A` が使えない。Homebrew bash 4+ を
# 前提にすると環境差で hook が落ちるため、ここでは reviewer 名を変数名の一部に
# 埋め込み、indirect expansion (`${!var}`) で読み出す形で代替している。
# 名前は REVIEWERS の固定値（simplicity / correctness / verifiability / security）で識別子として
# そのまま使えることが前提。動的にユーザー入力から作るときは要注意。
get_status()  { local v="STATUS_$1";  echo "${!v:-}"; }
set_status()  { eval "STATUS_$1=\"\$2\""; }
get_verdict() { local v="VERDICT_$1"; echo "${!v:-}"; }
set_verdict() { eval "VERDICT_$1=\"\$2\""; }

# main session へ結果を返す。PostToolUse の stderr は exit 0 だと Claude に届かない。
emit_context() {
  jq -n --arg c "$1" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
}

# 行頭の canonical 行 (`- Approval Status: xxx` 等) から値を読む。本文中の同じ文字列は拾わない。
status_of() {
  sed -nE "s/^[[:space:]]*([-*][[:space:]]+)?$1 Status:[[:space:]]*([^[:space:]]*).*/\\2/p" "$PLAN_FILE" | head -1
}

RESUME_HINT="再レビューするには、plan.md 末尾の <!-- auto-review: ... --> マーカー行を消してから plan.md を保存し直してください"

# --- 前提チェック ---

[[ -f "$PLAN_FILE" ]] || exit 0

# --- 承認後スキップ ---
# 承認後のチェック更新などで hash が変わっても、承認済み plan を applier に書き換えさせない。

APPROVAL_STATUS=$(status_of Approval)
PLAN_STATUS=$(status_of Plan)

if [[ "$APPROVAL_STATUS" == "needs_human_review" ]]; then
  echo "[plan-review] Approval Status: needs_human_review. Skipping." >&2
  emit_context "[plan-review] Approval Status: needs_human_review のため自動レビューをスキップしました。review-round-*.md の指摘をユーザーに示して判断を仰いでください。判断後に再レビューするには Approval Status を pending に戻して保存し直してください（round 上限に達している場合は、さらに plan.md 末尾の <!-- auto-review: ... --> マーカー行も消してください）。"
  exit 0
fi
if [[ "$APPROVAL_STATUS" == "approved" || "$PLAN_STATUS" == "done" ]]; then
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
  hash_stdin() { sha256sum | cut -d' ' -f1; }
else
  hash_stdin() { shasum -a 256 | cut -d' ' -f1; }
fi

# マーカー行を除き、末尾の空行を詰めた本文を出す。
# 書き戻しはこの出力 + "\n<marker>" なので、書き戻し前後で plan_hash が一致する。
plan_body() {
  { grep -v '<!-- auto-review:' "$1" || true; } |
    awk '{l[NR]=$0} END {n=NR; while (n>0 && l[n]=="") n--; for (i=1;i<=n;i++) print l[i]}'
}
plan_hash() { plan_body "$1" | hash_stdin; }

MARKER_LINE=$({ grep '<!-- auto-review:' "$PLAN_FILE" || true; } | tail -1)
CURRENT_HASH=$(plan_hash "$PLAN_FILE")
EXISTING_HASH=$(sed -n 's/.*hash=\([a-f0-9]*\).*/\1/p' <<<"$MARKER_LINE")

if [[ "$CURRENT_HASH" == "$EXISTING_HASH" ]]; then
  echo "[plan-review] No changes since last review. Skipping." >&2
  exit 0
fi

# --- ラウンド数チェック (前回ループ終了時の round が MAX_ROUNDS なら manual に委ねる) ---

CURRENT_ROUND=$(sed -n 's/.*round=\([0-9]*\).*/\1/p' <<<"$MARKER_LINE")
CURRENT_ROUND="${CURRENT_ROUND:-0}"
NEXT_ROUND=$((CURRENT_ROUND + 1))

if [[ "$NEXT_ROUND" -gt "$MAX_ROUNDS" ]]; then
  echo "[plan-review] Max rounds ($MAX_ROUNDS) reached. Manual review required." >&2
  emit_context "[plan-review] 自動レビューは round 上限（$MAX_ROUNDS）に達しているため、今回の変更（max_rounds）はレビューしていません。必要ならユーザーに確認のうえ、${RESUME_HINT}。"
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

# macOS 標準には GNU coreutils の `timeout` が無いため、手作りのウォッチドッグで代替する。
# 呼び出し先が固まっても secs 秒で SIGTERM を送り、必ず if/else に戻れるようにする。
run_with_timeout() {
  local secs="$1"
  shift
  "$@" &
  local cmd_pid=$!
  ( sleep "$secs"; kill -TERM "$cmd_pid" 2>/dev/null ) &
  local watchdog_pid=$!
  local rc=0
  wait "$cmd_pid" || rc=$?
  kill "$watchdog_pid" 2>/dev/null
  wait "$watchdog_pid" 2>/dev/null || true
  return "$rc"
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
  export TMPDIR="$tmp_dir"
  export PLAN_REVIEW_REVIEWER_NAME="$name"
  export PLAN_REVIEW_REVIEWER_ROUND="$round"
  if run_with_timeout "$REVIEWER_TIMEOUT" \
     "$REVIEWER_BIN" --print \
       --model "$REVIEW_MODEL" \
       --tools Read,Grep,Glob \
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
      run_with_timeout "$APPLIER_TIMEOUT" \
      "$APPLIER_BIN" --print \
      --model "$REVIEW_MODEL" \
      --tools Read,Edit \
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
  APPLIER_RAN=1

  # plan.md.bak は掃除で消えるので、ユーザーの決定が削られていないかを後から確かめられるよう差分を残す
  {
    echo ""
    echo "## Applier diff"
    echo ""
    echo '```diff'
    diff -u "$WORKFLOW_DIR/plan.md.bak" "$PLAN_FILE" || true
    echo '```'
  } >> "$report"

  if grep -qE '^[[:space:]]*([-*][[:space:]]+)?Approval Status:[[:space:]]*needs_human_review' "$PLAN_FILE"; then
    echo "[applier] escalated (Approval Status: needs_human_review). Breaking loop." >&2
    return 2
  fi
  return 0
}

# --- メインループ ---
# 1 イテレーション = 1 round (reviewers 並列 → aggregator → 必要なら applier)。
# pass / error / escalate / applier 失敗 / max rounds のいずれかで break。

LOOP_BREAK_REASON=""
APPLIER_RAN=0
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
  echo "[plan-review] Starting review round $NEXT_ROUND (${#REVIEWERS[@]} reviewers in parallel)..." >&2
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

  # 最終ラウンドの applier 編集は誰にもレビューされないまま残るので、回さずに止める
  if [[ "$NEXT_ROUND" -ge "$MAX_ROUNDS" ]]; then
    echo "[plan-review] Max rounds ($MAX_ROUNDS) reached. Stopping without applier." >&2
    LOOP_BREAK_REASON="max_rounds"
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
done

# --- plan.md への書き戻し (ループ終了後 1 回) ---

sedi() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

# Status 行を先に書き換え、その後の本文で hash を取る。順序が逆だと書き戻し後のファイルと一致しない。
sedi -E "s/^[[:space:]]*([-*][[:space:]]+)?Review Status:[[:space:]]*.*/- Review Status: $FINAL_VERDICT/" "$PLAN_FILE"

if [[ "$FINAL_VERDICT" == "pass" ]]; then
  sedi -E "s/^[[:space:]]*([-*][[:space:]]+)?Plan Status:[[:space:]]*.*/- Plan Status: complete/" "$PLAN_FILE"
fi

FINAL_HASH=$(plan_hash "$PLAN_FILE")
MARKER="<!-- auto-review: verdict=$FINAL_VERDICT; hash=$FINAL_HASH; round=$LAST_ROUND; skipped=[$SKIPPED_STR]; failed=[$FAILED_STR] -->"

# マーカー行は「既存行を削除 → 末尾に追記」で更新する。
# sed 置換だと marker に `\` `&` `|` 等が含まれた場合に壊れるため、行ベースで扱う。
# 末尾の空行は plan_body で詰めるので、書き戻しのたびに空行が増えることはない。
TMP_PLAN=$(mktemp "${TMPDIR:-/tmp}/plan-marker.XXXXXX")
plan_body "$PLAN_FILE" > "$TMP_PLAN"
printf '\n%s\n' "$MARKER" >> "$TMP_PLAN"
mv "$TMP_PLAN" "$PLAN_FILE"

echo "[plan-review] Loop ended: verdict=$FINAL_VERDICT, last_round=$LAST_ROUND, reason=${LOOP_BREAK_REASON:-unknown} (skipped=[$SKIPPED_STR], failed=[$FAILED_STR])" >&2
echo "[plan-review] Final report: $WORKFLOW_DIR/review-round-${LAST_ROUND}.md" >&2

# --- 中間生成物の掃除 (ループ終了後 1 回) ---
# レビューの生出力・exit マーカー・peers・applier バックアップは verdict 確定後に用済み。
# 集約レポート (review-round-N.md) は読む価値があるため残す。
#
#   - verdict=error のときは残す (原因調査に必要)
#   - PLAN_REVIEW_KEEP_ARTIFACTS が非空なら掃除しない
#     (test.sh が review-round-N-peers.md 等の中身を assert しているため)
#   - $WORKFLOW_DIR 直下のみ (-maxdepth 1)。サブディレクトリには触れない
if [[ "$FINAL_VERDICT" != "error" && -z "${PLAN_REVIEW_KEEP_ARTIFACTS:-}" ]]; then
  find "$WORKFLOW_DIR" -maxdepth 1 \( \
    -name 'review-round-*-*.raw' -o \
    -name 'review-round-*-*.json' -o \
    -name 'review-round-*-*.exit' -o \
    -name 'review-round-*-peers.md' -o \
    -name 'plan.md.bak' \
    \) -delete 2>/dev/null || true
  echo "[plan-review] Cleaned intermediate artifacts (kept review-round-*.md)" >&2
fi

# --- main session への報告 ---

case "$LOOP_BREAK_REASON" in
  pass)
    NEXT_ACTION="Plan Status: complete になりました。plan をユーザーに示して承認を依頼してください。" ;;
  escalate)
    NEXT_ACTION="applier が Approval Status を needs_human_review に変えました。レポートの指摘をユーザーに示して判断を仰いでください。" ;;
  max_rounds)
    NEXT_ACTION="round 上限（$MAX_ROUNDS）で needs_revision のまま止まりました。最終ラウンドの指摘は plan に反映されていません。残りの指摘をユーザーに示し、手で直すか今のまま承認するかを判断してもらってください。${RESUME_HINT}。" ;;
  applier_failed)
    NEXT_ACTION="applier が失敗したため、plan.md は applier 実行前の内容に戻しました。指摘をユーザーに示してください。" ;;
  *)
    NEXT_ACTION="全 reviewer が失敗しました（raw 出力を $WORKFLOW_DIR に残しています）。原因を調べてユーザーに報告してください。" ;;
esac
if [[ "$APPLIER_RAN" -eq 1 ]]; then
  NEXT_ACTION="$NEXT_ACTION applier が plan.md を編集しています。各 review-round-N.md 末尾の「## Applier diff」を見て、ユーザーの決定が削られていないか確かめてください。"
fi

emit_context "[plan-review] verdict=$FINAL_VERDICT（reason=${LOOP_BREAK_REASON:-unknown}, round=$LAST_ROUND, skipped=[$SKIPPED_STR], failed=[$FAILED_STR]）。レポート: $WORKFLOW_DIR/review-round-${LAST_ROUND}.md。$NEXT_ACTION"
