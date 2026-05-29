let mermaidPromise = null;
function ensureMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("/vendor/mermaid.esm.min.mjs").then((m) => {
      m.default.initialize({ startOnLoad: false, theme: "dark" });
      return m.default;
    });
  }
  return mermaidPromise;
}
async function renderMermaidIn(panel) {
  const nodes = panel.querySelectorAll("pre.mermaid:not([data-processed])");
  if (!nodes.length) return;
  const mermaid = await ensureMermaid();
  await mermaid.run({ nodes: Array.from(nodes) });
}
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const doc = btn.dataset.doc;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.dataset.doc === doc));
    const active = document.querySelector(".panel.active");
    if (active) renderMermaidIn(active);
  });
});
const initial = document.querySelector(".panel.active");
if (initial) renderMermaidIn(initial);

// archive トグル: ボタンをクリックしたら現在状態を反転させて /api/archive に投げる。
// フィードバックはボタン文言（label） + data-archived 属性 + aria-pressed の更新に
// 固定し、トースト等の新規 UI 機構は導入しない（plan の制約）。
const archiveBtn = document.querySelector("[data-archive-toggle]");
if (archiveBtn) {
  archiveBtn.addEventListener("click", async () => {
    if (archiveBtn.disabled) return;
    const id = archiveBtn.dataset.id;
    const currentArchived = archiveBtn.dataset.archived === "true";
    const nextArchived = !currentArchived;
    archiveBtn.disabled = true;
    const labelEl = archiveBtn.querySelector(".archive-toggle__label");
    const iconEl = archiveBtn.querySelector(".archive-toggle__icon");
    const prevLabel = labelEl?.textContent ?? "";
    if (labelEl) labelEl.textContent = "更新中…";
    try {
      const res = await fetch("/api/archive", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, archived: nextArchived }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "更新に失敗しました");
      archiveBtn.dataset.archived = nextArchived ? "true" : "false";
      archiveBtn.setAttribute("aria-pressed", nextArchived ? "true" : "false");
      if (labelEl) labelEl.textContent = nextArchived ? "アーカイブ解除" : "アーカイブ";
      if (iconEl) iconEl.textContent = nextArchived ? "↩" : "📥";
      archiveBtn.title = nextArchived ? "ボードに戻す" : "ボードから片付ける";
    } catch (e) {
      // 失敗時はラベルを「失敗」に置く（独自トースト機構は使わない）
      if (labelEl) labelEl.textContent = "失敗: " + (e?.message ?? e);
      setTimeout(() => {
        if (labelEl) labelEl.textContent = prevLabel;
      }, 2400);
    } finally {
      archiveBtn.disabled = false;
    }
  });
}
