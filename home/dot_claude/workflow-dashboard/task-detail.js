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
