#!/usr/bin/env bash
# plan-review-hook.test.sh
# plan-review-hook.sh のループ挙動を mock reviewer / applier で検証するテストドライバ。
#
# PLAN_REVIEW_REVIEWER_CMD と PLAN_REVIEW_APPLIER_CMD の差し替え点を使い、
# claude --print を呼ばずに end-to-end の round 進行を再現する。
#
# 走らせ方:
#   bash ~/.claude/scripts/plan-review-hook.test.sh
#
# 終了コード: 失敗が 1 つでもあれば 1、全 pass で 0。

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOK="$SCRIPT_DIR/plan-review-hook.sh"

if [[ ! -f "$HOOK" ]]; then
  echo "Hook script not found: $HOOK" >&2
  exit 1
fi

PASS=0
FAIL=0
FAIL_MSGS=()

assert_match() {
  local file="$1" pattern="$2" desc="$3"
  if grep -Eq "$pattern" "$file" 2>/dev/null; then
    PASS=$((PASS+1))
    echo "    ok: $desc"
  else
    FAIL=$((FAIL+1))
    FAIL_MSGS+=("$desc — pattern '$pattern' not in $file")
    echo "    FAIL: $desc"
    echo "         pattern: $pattern"
    echo "         file:    $file"
  fi
}

assert_no_match() {
  local file="$1" pattern="$2" desc="$3"
  if [[ -f "$file" ]] && grep -Eq "$pattern" "$file" 2>/dev/null; then
    FAIL=$((FAIL+1))
    FAIL_MSGS+=("$desc — pattern '$pattern' unexpectedly in $file")
    echo "    FAIL: $desc"
  else
    PASS=$((PASS+1))
    echo "    ok: $desc"
  fi
}

assert_file_exists() {
  if [[ -e "$1" ]]; then
    PASS=$((PASS+1))
    echo "    ok: $2"
  else
    FAIL=$((FAIL+1))
    FAIL_MSGS+=("$2 — file '$1' does not exist")
    echo "    FAIL: $2 (missing $1)"
  fi
}

assert_file_absent() {
  if [[ ! -e "$1" ]]; then
    PASS=$((PASS+1))
    echo "    ok: $2"
  else
    FAIL=$((FAIL+1))
    FAIL_MSGS+=("$2 — file '$1' unexpectedly exists")
    echo "    FAIL: $2 (file '$1' exists)"
  fi
}

# --- mock binaries ---

MOCKS_DIR=$(mktemp -d)
trap 'rm -rf "$MOCKS_DIR"' EXIT

cat > "$MOCKS_DIR/mock-reviewer.sh" <<'MOCK'
#!/usr/bin/env bash
# Mock claude as reviewer. Reads canned response from $MOCK_REVIEWER_DIR/<name>-<round>.json.
# Defaults to {"verdict":"pass","summary":"mock"} if absent.
NAME="${PLAN_REVIEW_REVIEWER_NAME:-unknown}"
ROUND="${PLAN_REVIEW_REVIEWER_ROUND:-0}"
DIR="${MOCK_REVIEWER_DIR:-/tmp/no-such-dir}"
F="$DIR/$NAME-$ROUND.json"
if [[ -f "$F" ]]; then
  cat "$F"
else
  echo '{"verdict":"pass","summary":"mock default"}'
fi
exit 0
MOCK
chmod +x "$MOCKS_DIR/mock-reviewer.sh"

cat > "$MOCKS_DIR/mock-applier.sh" <<'MOCK'
#!/usr/bin/env bash
# Mock claude as applier. Acts on $PLAN per $MOCK_APPLIER_ACTION.
# Actions: noop | fail | escalate | edit
set -u
ACTION="${MOCK_APPLIER_ACTION:-noop}"
PLAN="${MOCK_PLAN_FILE:?MOCK_PLAN_FILE not set}"

sed_inplace() {
  if sed --version >/dev/null 2>&1; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

case "$ACTION" in
  noop) ;;
  fail) exit 1 ;;
  escalate)
    sed_inplace 's/^- Approval Status: pending/- Approval Status: needs_human_review/' "$PLAN"
    ;;
  edit)
    echo "// applier edit pid=$$" >> "$PLAN"
    ;;
  *)
    echo "Unknown MOCK_APPLIER_ACTION: $ACTION" >&2
    exit 2
    ;;
esac
exit 0
MOCK
chmod +x "$MOCKS_DIR/mock-applier.sh"

# --- helpers ---

mk_workspace() {
  local dir
  dir=$(mktemp -d)
  mkdir -p "$dir/.workflow"
  cat > "$dir/.workflow/research.md" <<EOF
# Research
test research
EOF
  cat > "$dir/.workflow/plan.md" <<EOF
# Plan
## 目的
test plan body
## Review Status
- Status: pending
- Round: 0
- Last Review Hash: (none)
## Approval
- Plan Status: draft
- Approval Status: pending
EOF
  echo "$dir"
}

run_hook() {
  local ws="$1"
  local plan_path="$ws/.workflow/plan.md"
  local input
  input=$(printf '{"tool_input":{"file_path":"%s"}}' "$plan_path")
  ( cd "$ws" && echo "$input" | bash "$HOOK" ) >/dev/null 2>&1 || true
}

# Each test exports the env vars before run_hook. unset between tests.
clear_env() {
  unset PLAN_REVIEW_HOOK_RUNNING
  unset PLAN_REVIEW_REVIEWER_CMD
  unset PLAN_REVIEW_APPLIER_CMD
  unset MOCK_REVIEWER_DIR
  unset MOCK_APPLIER_ACTION
  unset MOCK_PLAN_FILE
  unset MAX_REVIEW_ROUNDS
}

# ---------------------------------------------------------------------------
# Case 1: All reviewers pass on round 1 → no applier, single round
# ---------------------------------------------------------------------------
echo "Case 1: all pass on round 1"
clear_env
WS=$(mk_workspace)
MOCK_DIR=$(mktemp -d)
export PLAN_REVIEW_REVIEWER_CMD="$MOCKS_DIR/mock-reviewer.sh"
export PLAN_REVIEW_APPLIER_CMD="$MOCKS_DIR/mock-applier.sh"
export MOCK_REVIEWER_DIR="$MOCK_DIR"
export MOCK_APPLIER_ACTION="noop"
export MOCK_PLAN_FILE="$WS/.workflow/plan.md"
run_hook "$WS"

assert_match     "$WS/.workflow/plan.md" '^- Status: pass$'             "Status=pass"
assert_match     "$WS/.workflow/plan.md" 'round=1'                      "marker round=1"
assert_match     "$WS/.workflow/plan.md" '^- Plan Status: complete$'    "Plan Status=complete"
assert_match     "$WS/.workflow/plan.md" 'verdict=pass'                 "marker verdict=pass"
assert_file_exists "$WS/.workflow/review-round-1.md"                    "round 1 report exists"
assert_file_absent "$WS/.workflow/review-round-2.md"                    "round 2 report absent"
rm -rf "$WS" "$MOCK_DIR"

# ---------------------------------------------------------------------------
# Case 2: Round 1 needs_revision → applier edits → round 2 pass (loop continues)
# ---------------------------------------------------------------------------
echo "Case 2: round 1 needs_revision → applier edit → round 2 pass"
clear_env
WS=$(mk_workspace)
MOCK_DIR=$(mktemp -d)
echo '{"verdict":"needs_revision","summary":"r1 nag","must_remove":["x"]}' > "$MOCK_DIR/simplicity-1.json"
# round 2 has no canned files → defaults to pass
export PLAN_REVIEW_REVIEWER_CMD="$MOCKS_DIR/mock-reviewer.sh"
export PLAN_REVIEW_APPLIER_CMD="$MOCKS_DIR/mock-applier.sh"
export MOCK_REVIEWER_DIR="$MOCK_DIR"
export MOCK_APPLIER_ACTION="edit"
export MOCK_PLAN_FILE="$WS/.workflow/plan.md"
run_hook "$WS"

assert_match     "$WS/.workflow/plan.md" '^- Status: pass$'           "Status=pass after looping"
assert_match     "$WS/.workflow/plan.md" 'round=2'                    "marker round=2"
assert_match     "$WS/.workflow/plan.md" '^- Plan Status: complete$'  "Plan Status=complete"
assert_match     "$WS/.workflow/plan.md" '// applier edit pid='        "applier edit applied"
assert_file_exists "$WS/.workflow/review-round-1.md"                    "round 1 report exists"
assert_file_exists "$WS/.workflow/review-round-2.md"                    "round 2 report exists"
assert_file_absent "$WS/.workflow/review-round-3.md"                    "round 3 absent"
# round 2 peers.md should reference round 1 simplicity verdict
assert_match     "$WS/.workflow/review-round-2-peers.md" 'verdict: needs_revision' "peers.md carries r1 verdict"
rm -rf "$WS" "$MOCK_DIR"

# ---------------------------------------------------------------------------
# Case 3: Round 1 needs_revision → applier escalates → loop breaks
# ---------------------------------------------------------------------------
echo "Case 3: applier escalates"
clear_env
WS=$(mk_workspace)
MOCK_DIR=$(mktemp -d)
echo '{"verdict":"needs_revision","summary":"need redesign"}' > "$MOCK_DIR/simplicity-1.json"
export PLAN_REVIEW_REVIEWER_CMD="$MOCKS_DIR/mock-reviewer.sh"
export PLAN_REVIEW_APPLIER_CMD="$MOCKS_DIR/mock-applier.sh"
export MOCK_REVIEWER_DIR="$MOCK_DIR"
export MOCK_APPLIER_ACTION="escalate"
export MOCK_PLAN_FILE="$WS/.workflow/plan.md"
run_hook "$WS"

assert_match     "$WS/.workflow/plan.md" '^- Status: needs_revision$'           "Status=needs_revision"
assert_match     "$WS/.workflow/plan.md" '^- Round: 1$'                         "Round=1"
assert_match     "$WS/.workflow/plan.md" '^- Approval Status: needs_human_review$' "escalate persisted"
assert_no_match  "$WS/.workflow/plan.md" '^- Plan Status: complete$'            "Plan Status not complete"
assert_file_exists "$WS/.workflow/review-round-1.md"                            "round 1 report exists"
assert_file_absent "$WS/.workflow/review-round-2.md"                            "round 2 report absent"
rm -rf "$WS" "$MOCK_DIR"

# ---------------------------------------------------------------------------
# Case 4: applier fails → rollback, loop breaks
# ---------------------------------------------------------------------------
echo "Case 4: applier fails → rollback"
clear_env
WS=$(mk_workspace)
MOCK_DIR=$(mktemp -d)
echo '{"verdict":"needs_revision","summary":"r1 nag"}' > "$MOCK_DIR/simplicity-1.json"
export PLAN_REVIEW_REVIEWER_CMD="$MOCKS_DIR/mock-reviewer.sh"
export PLAN_REVIEW_APPLIER_CMD="$MOCKS_DIR/mock-applier.sh"
export MOCK_REVIEWER_DIR="$MOCK_DIR"
export MOCK_APPLIER_ACTION="fail"
export MOCK_PLAN_FILE="$WS/.workflow/plan.md"
run_hook "$WS"

assert_match     "$WS/.workflow/plan.md" '^- Status: needs_revision$'        "Status=needs_revision"
assert_match     "$WS/.workflow/plan.md" '^- Round: 1$'                      "Round=1"
assert_match     "$WS/.workflow/plan.md" '^- Approval Status: pending$'      "Approval Status pending (no escalate)"
assert_no_match  "$WS/.workflow/plan.md" '^- Plan Status: complete$'         "Plan Status not complete"
assert_file_absent "$WS/.workflow/review-round-2.md"                         "round 2 absent"
rm -rf "$WS" "$MOCK_DIR"

# ---------------------------------------------------------------------------
# Case 5: Max rounds reached (MAX_REVIEW_ROUNDS=2, all rounds needs_revision)
# ---------------------------------------------------------------------------
echo "Case 5: max rounds (=2) reached"
clear_env
WS=$(mk_workspace)
MOCK_DIR=$(mktemp -d)
for n in 1 2 3; do
  echo "{\"verdict\":\"needs_revision\",\"summary\":\"r${n} keep nagging\"}" > "$MOCK_DIR/simplicity-$n.json"
done
export MAX_REVIEW_ROUNDS=2
export PLAN_REVIEW_REVIEWER_CMD="$MOCKS_DIR/mock-reviewer.sh"
export PLAN_REVIEW_APPLIER_CMD="$MOCKS_DIR/mock-applier.sh"
export MOCK_REVIEWER_DIR="$MOCK_DIR"
export MOCK_APPLIER_ACTION="edit"
export MOCK_PLAN_FILE="$WS/.workflow/plan.md"
run_hook "$WS"

assert_match     "$WS/.workflow/plan.md" '^- Status: needs_revision$'        "Status=needs_revision"
assert_match     "$WS/.workflow/plan.md" '^- Round: 2$'                      "Round=2 (capped)"
assert_file_exists "$WS/.workflow/review-round-1.md"                          "round 1 report exists"
assert_file_exists "$WS/.workflow/review-round-2.md"                          "round 2 report exists"
assert_file_absent "$WS/.workflow/review-round-3.md"                          "round 3 absent"
rm -rf "$WS" "$MOCK_DIR"

# ---------------------------------------------------------------------------
# Case 6: Re-entrant call skipped
# ---------------------------------------------------------------------------
echo "Case 6: re-entrant call skipped"
clear_env
WS=$(mk_workspace)
MOCK_DIR=$(mktemp -d)
export PLAN_REVIEW_HOOK_RUNNING=1
export PLAN_REVIEW_REVIEWER_CMD="$MOCKS_DIR/mock-reviewer.sh"
export PLAN_REVIEW_APPLIER_CMD="$MOCKS_DIR/mock-applier.sh"
export MOCK_REVIEWER_DIR="$MOCK_DIR"
export MOCK_PLAN_FILE="$WS/.workflow/plan.md"
run_hook "$WS"

assert_match     "$WS/.workflow/plan.md" '^- Status: pending$'        "Status untouched (still pending)"
assert_file_absent "$WS/.workflow/review-round-1.md"                    "no review run"
rm -rf "$WS" "$MOCK_DIR"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "================================================"
echo "Pass: $PASS   Fail: $FAIL"
if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for m in "${FAIL_MSGS[@]}"; do
    echo "  - $m"
  done
  exit 1
fi
echo "All assertions passed."
exit 0
