#!/usr/bin/env bash
# plan-review-hook.sh
# plan.md への書き込みを検知して自動レビューを実行する
#
# Claude Code の PostToolUse hook として使用:
# {
#   "hooks": {
#     "PostToolUse": [
#       {
#         "matcher": "Write|Edit|MultiEdit",
#         "hooks": [{
#           "type": "command",
#           "command": "bash ~/.claude/scripts/plan-review-hook.sh"
#         }]
#       }
#     ]
#   }
# }
#
# 環境変数:
#   WORKFLOW_DIR - 成果物ディレクトリ (default: .workflow)
#   MAX_REVIEW_ROUNDS - 最大レビューラウンド数 (default: 3)

set -euo pipefail

WORKFLOW_DIR="${WORKFLOW_DIR:-.workflow}"
MAX_ROUNDS="${MAX_REVIEW_ROUNDS:-3}"
PLAN_FILE="$WORKFLOW_DIR/plan.md"
REVIEW_PROMPT_FILE="$WORKFLOW_DIR/.review-prompt"

# --- 前提チェック ---

# plan.md が存在しなければスキップ
if [[ ! -f "$PLAN_FILE" ]]; then
  exit 0
fi

# stdin から JSON ペイロードを読み込み、対象ファイルを抽出
INPUT=$(cat)

# jq を使用して tool_input.file_path から対象ファイルを取得
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null || echo "")

# plan.md の変更でない場合はスキップ
if [[ -z "$FILE_PATH" ]] || [[ "$FILE_PATH" != *"plan.md" ]]; then
  exit 0
fi

# --- ハッシュチェック ---

# macOS (shasum) / Linux (sha256sum) 両対応
if command -v sha256sum >/dev/null 2>&1; then
  hash_cmd() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash_cmd() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

CURRENT_HASH=$(hash_cmd "$PLAN_FILE")

# plan.md 内の既存ハッシュを抽出 (BSD grep 互換: -oP ではなく sed を使用)
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

# --- レビュープロンプト生成 ---

cat > "$REVIEW_PROMPT_FILE" << 'PROMPT_EOF'
あなたは実装計画のレビュアーです。
渡されたファイルを読み、計画の品質を以下の6観点で評価してください。

## 評価観点

1. 完全性: research.md で特定された影響範囲がすべて plan.md に反映されているか
2. 具体性: 各ステップが十分に具体的で、実装者が迷わないか
3. 順序の妥当性: ステップの依存関係と実行順序は正しいか
4. リスク対応: 特定されたリスクに対する対策は十分か
5. 動作確認の網羅性: 変更内容に対して動作確認項目は十分か
6. スコープの適切さ: 不要な変更が含まれていないか、必要な変更が漏れていないか

## 出力形式

以下のJSON形式のみを出力してください。それ以外のテキストは含めないでください:

{
  "verdict": "pass" または "needs_revision",
  "issues": [
    {
      "severity": "critical" または "major" または "minor",
      "category": "completeness" または "specificity" または "ordering" または "risk" または "verification" または "scope",
      "description": "問題の説明",
      "suggestion": "改善案"
    }
  ],
  "summary": "総評（1-2文）"
}
PROMPT_EOF

# --- レビュー実行（直接バックグラウンド実行） ---

REVIEW_OUTPUT="$WORKFLOW_DIR/review-round-${NEXT_ROUND}.md"

echo "[plan-review] Starting review round $NEXT_ROUND..." >&2

# claude --print をサブプロセスとして直接実行
claude --print \
  --system-prompt "$(cat "$REVIEW_PROMPT_FILE")" \
  "以下のファイルを読んでレビューしてください: $WORKFLOW_DIR/research.md $PLAN_FILE" \
  > "$REVIEW_OUTPUT" 2>&1

# --- 結果の解析と plan.md への反映 ---

if [[ ! -f "$REVIEW_OUTPUT" ]]; then
  echo "[plan-review] Review output not found. Skipping." >&2
  exit 1
fi

# verdict を抽出
# claude --print は ```json ... ``` でラップすることがあるので、
# まず JSON 部分を抽出してから jq でパースする
VERDICT=$(sed -n '/^```/,/^```/{/^```/d;p;}' "$REVIEW_OUTPUT" | jq -r '.verdict // empty' 2>/dev/null)
if [[ -z "$VERDICT" ]]; then
  # コードブロックなしの素の JSON を試す
  VERDICT=$(jq -r '.verdict // empty' "$REVIEW_OUTPUT" 2>/dev/null)
fi
if [[ -z "$VERDICT" ]]; then
  # フォールバック: テキストから verdict を探す
  VERDICT=$(sed -n 's/.*"verdict"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REVIEW_OUTPUT" | head -1)
fi
VERDICT="${VERDICT:-error}"

# plan.md のハッシュを再計算
FINAL_HASH=$(hash_cmd "$PLAN_FILE")

# macOS (BSD sed) / Linux (GNU sed) 両対応の in-place 置換
sedi() {
  if sed --version >/dev/null 2>&1; then
    # GNU sed
    sed -i "$@"
  else
    # BSD sed (macOS)
    sed -i '' "$@"
  fi
}

# plan.md の Review Status を更新
# 既存のマーカーがあれば置換、なければ追記
if grep -q '<!-- auto-review:' "$PLAN_FILE"; then
  sedi "s|<!-- auto-review:.*-->|<!-- auto-review: verdict=$VERDICT; hash=$FINAL_HASH; round=$NEXT_ROUND -->|" "$PLAN_FILE"
else
  echo "<!-- auto-review: verdict=$VERDICT; hash=$FINAL_HASH; round=$NEXT_ROUND -->" >> "$PLAN_FILE"
fi

# Review Status セクションを更新
sedi "s/^- Status: .*/- Status: $VERDICT/" "$PLAN_FILE"
sedi "s/^- Round: .*/- Round: $NEXT_ROUND/" "$PLAN_FILE"
sedi "s/^- Last Review Hash: .*/- Last Review Hash: $FINAL_HASH/" "$PLAN_FILE"

# verdict が pass なら Plan Status を complete に
if [[ "$VERDICT" == "pass" ]]; then
  sedi "s/^- Plan Status: .*/- Plan Status: complete/" "$PLAN_FILE"
  echo "[plan-review] Round $NEXT_ROUND: PASS. Plan marked as complete." >&2
else
  echo "[plan-review] Round $NEXT_ROUND: NEEDS REVISION. See $REVIEW_OUTPUT" >&2
fi

# レビュー結果に見出しを追加
{
  echo "# Review Round $NEXT_ROUND"
  echo ""
  echo "## Verdict: $VERDICT"
  echo ""
  grep -vF -- '---REVIEW_DONE---' "$REVIEW_OUTPUT"
} > "${REVIEW_OUTPUT}.tmp" && mv "${REVIEW_OUTPUT}.tmp" "$REVIEW_OUTPUT"

echo "[plan-review] Review round $NEXT_ROUND complete. Output: $REVIEW_OUTPUT" >&2
