---
name: ui-verify
description: "Visual verification skill for UI/frontend work. Use proactively after any UI implementation, style change, or component edit — accessibility snapshots cannot judge CSS, layout, color, or 'does it look right'. Drives playwright-cli in two stages: (1) self-check via screenshot + snapshot diff to settle what the AI can judge alone, (2) when human judgment is needed (design fidelity, ambiguous selection, animation feel), open the Playwright Dashboard in annotation mode so the user can drag a region and leave a comment. Triggers: any task that ends with rendered UI changes; workflow.md Phase 6 verification items involving the browser; explicit requests like 「見た目を確認して」「UI レビュー」「動作確認」."
allowed-tools: Bash(playwright-cli:*) Bash(npx:*)
---

# UI Verification

Workflow for verifying UI work in a real browser. Owns the *flow* (when to look, what to ask, how to clean up). Concrete `playwright-cli` syntax lives in the bundled `playwright-cli` skill — call this for the flow, that for the commands.

## Stage 1 — Self-check (always first)

Settle what can be judged from pixels alone before spending the user's attention.

1. Ensure the dev server is running (start one if needed — see `~/.claude/rules/pane-strategy.md` for pane placement).
2. Open the page and capture screenshots scoped to the change:
   ```bash
   playwright-cli open http://localhost:3000/<path>
   playwright-cli screenshot --filename=.workflow/ui-after.png
   playwright-cli screenshot --full-page --filename=.workflow/ui-full.png
   playwright-cli screenshot e5 --filename=.workflow/ui-component.png
   ```
3. If a baseline exists, snapshot-diff for structural changes:
   ```bash
   diff .workflow/ui-before.yml .workflow/ui-after.yml
   ```
4. Inspect the screenshots and decide:
   - **Looks correct** → report done, attach screenshot path. Skip Stage 2.
   - **Found a problem** → fix, loop Stage 1.
   - **Requires human judgment (design fidelity / ambiguous element / interaction feel)** → Stage 2.

## Stage 2 — Annotated dashboard

For "does this match the design?", "which element did you mean?", "is this interaction natural?".

1. Highlight the element in question, so the subject is unambiguous:
   ```bash
   playwright-cli highlight e5 --style="outline: 3px dashed magenta"
   ```
   Skip **only** when the question is genuinely about the whole page (overall layout, page-level color scheme).
2. Launch the dashboard in annotation mode:
   ```bash
   playwright-cli show --annotate
   ```
   On WSLg, keep `WAYLAND_DISPLAY` set — the bundled Chrome for Testing has
   no GTK linkage and dropped XIM, so Linux-side fcitx5 can't reach it.
   Japanese input flows through WSLg Weston's Wayland text-input-v3 bridge
   to the Windows IME instead, which only works while Chrome is on Wayland.
3. Tell the user in one sentence what you want feedback on.
4. Read the returned annotation (coordinates + comment + cropped screenshot). The comment is the source of truth.
5. Apply the change, then loop back to Stage 1.
6. Cleanup when the verify cycle is done:
   ```bash
   playwright-cli highlight --hide
   playwright-cli close
   ```

## Skip when

- The change is purely backend / build config / docs / types with no rendered output
- The user explicitly told you not to open a browser

## Anti-patterns

- Reporting a UI task done after only `snapshot` (accessibility tree, not pixels)
- Calling `show --annotate` without trying Stage 1 first
- Leaving the browser or dashboard open after the cycle (run `close` / `close-all` / `highlight --hide`)

## Handoff to workflow.md Phase 6

When Phase 6 has an item like "the new component renders correctly", treat it as Stage 1 (+ Stage 2 if needed). Record screenshot path and any annotation comment in `verify-results.md` under that item.

## Reference

Detailed `playwright-cli` syntax (open / click / screenshot / show / highlight / network / sessions / …) lives in the bundled `playwright-cli` skill.
