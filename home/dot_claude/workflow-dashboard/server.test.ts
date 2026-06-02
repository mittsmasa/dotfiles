// phase 判定 (derivePhase) のリグレッションテスト。
// workflow.md Phase 7「dashboard 列対応表」と server.ts の derivePhase が
// ずれていないことを保証する。dashboard の挙動を変えたらここが落ちる想定。
//
// 実行: bun test  （workflow-dashboard ディレクトリで）
//
// server.ts は startServer() を import.meta.main ガードの中で呼ぶので、
// import してもサーバーは起動しない（純関数だけが手に入る）。

import { describe, expect, test } from "bun:test";
import { derivePhase, hasMarker, parseBranchLine } from "./server.ts";

// テスト用のマーカー行ヘルパ。plan.md / verify-results.md の canonical 書式
// （行頭 "- " 付き）を組み立てる。
const planApproved = "- Approval Status: approved";
const planComplete = "- Plan Status: complete";
const planDone = "- Plan Status: done";
const verifyDone = "- Status: done";

const openPr = { number: 12, url: "https://github.com/o/r/pull/12", merged: false };
const mergedPr = { number: 12, url: "https://github.com/o/r/pull/12", merged: true };

describe("derivePhase: PR が最優先", () => {
  test("merged PR → done（plan/dirty に関わらず）", () => {
    expect(derivePhase(planComplete, mergedPr, null, false, true)).toBe("done");
    expect(derivePhase(null, mergedPr, null, true, true)).toBe("done");
  });

  test("open PR → pr-open", () => {
    expect(derivePhase(planDone, openPr, verifyDone, false, false)).toBe("pr-open");
    expect(derivePhase(null, openPr, null, true, null)).toBe("pr-open");
  });
});

describe("derivePhase: 作業完了シグナル (Status: done)", () => {
  test("plan の Plan Status: done を完了とみなす", () => {
    expect(derivePhase(planDone, null, null, true, false)).toBe("done");
  });

  test("verify の Status: done を完了とみなす", () => {
    expect(derivePhase(null, null, verifyDone, true, false)).toBe("done");
  });

  describe("noPr タスク（PR を作らない）", () => {
    test("dirty=true → pr-pending（未コミットあり）", () => {
      expect(derivePhase(verifyDone, null, verifyDone, true, true)).toBe("pr-pending");
    });

    test("dirty=false → done", () => {
      expect(derivePhase(verifyDone, null, verifyDone, true, false)).toBe("done");
    });

    test("dirty=null（非 git, ~/.claude 等）→ done", () => {
      expect(derivePhase(verifyDone, null, verifyDone, true, null)).toBe("done");
    });
  });

  describe("PR タスク（!noPr）", () => {
    test("PR 未検出なら done でも pr-pending で待つ", () => {
      expect(derivePhase(verifyDone, null, verifyDone, false, false)).toBe("pr-pending");
      expect(derivePhase(verifyDone, null, verifyDone, false, null)).toBe("pr-pending");
      expect(derivePhase(verifyDone, null, verifyDone, false, true)).toBe("pr-pending");
    });
  });
});

describe("derivePhase: 完了前のフェーズ", () => {
  test("Approval Status: approved → in-progress", () => {
    expect(derivePhase(planApproved, null, null, false, null)).toBe("in-progress");
  });

  test("Plan Status: complete（承認待ち）→ review", () => {
    expect(derivePhase(planComplete, null, null, false, null)).toBe("review");
  });

  test("マーカー無し → in-progress", () => {
    expect(derivePhase(null, null, null, false, null)).toBe("in-progress");
    expect(derivePhase("", null, "", false, null)).toBe("in-progress");
  });

  test("approved は complete より優先（承認後は in-progress）", () => {
    const both = `${planApproved}\n${planComplete}`;
    expect(derivePhase(both, null, null, false, null)).toBe("in-progress");
  });
});

describe("hasMarker", () => {
  test("canonical 書式（行頭 - 付き）にマッチ", () => {
    expect(hasMarker("- Plan Status: done", "Plan Status", "done")).toBe(true);
  });

  test("素のキー（- 無し）にもマッチ", () => {
    expect(hasMarker("Plan Status: done", "Plan Status", "done")).toBe(true);
  });

  test("値の前方一致を別値と誤認しない（done vs done-ish）", () => {
    expect(hasMarker("- Plan Status: done-ish", "Plan Status", "done")).toBe(false);
  });

  test("値違いはマッチしない", () => {
    expect(hasMarker("- Plan Status: draft", "Plan Status", "done")).toBe(false);
  });

  test("null / 空文字は false", () => {
    expect(hasMarker(null, "Plan Status", "done")).toBe(false);
    expect(hasMarker("", "Plan Status", "done")).toBe(false);
  });

  test("複数行のうち 1 行にあればマッチ", () => {
    const text = "# plan\n\n- Plan Status: complete\n- Approval Status: pending\n";
    expect(hasMarker(text, "Approval Status", "pending")).toBe(true);
  });
});

describe("parseBranchLine", () => {
  test("upstream 付き", () => {
    expect(parseBranchLine("## main...origin/main")).toBe("main");
  });

  test("ahead/behind 付き", () => {
    expect(parseBranchLine("## feat/x...origin/feat/x [ahead 2]")).toBe("feat/x");
  });

  test("upstream 無し", () => {
    expect(parseBranchLine("## worktree-foo")).toBe("worktree-foo");
  });

  test("detached HEAD → null", () => {
    expect(parseBranchLine("## HEAD (no branch)")).toBe(null);
  });

  test("ブランチ名中のドットは保持", () => {
    expect(parseBranchLine("## release/1.2.x")).toBe("release/1.2.x");
  });
});
