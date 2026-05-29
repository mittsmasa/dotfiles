// workflow-dashboard — Clean drawer の開閉・候補 fetch・削除確認。
// 既存の board と detail には触らない。HTML 骨格は server.ts 側で出力済み。

const SECTIONS = [
  { key: "done", label: "Done" },
  { key: "archived", label: "Archived" },
  { key: "orphan", label: "Orphan" },
  { key: "empty", label: "Empty" },
];

const overlay = document.querySelector("[data-clean-overlay]");
const drawer = document.querySelector("[data-clean-drawer]");
const openBtn = document.querySelector("[data-clean-open]");
const closeBtn = document.querySelector("[data-clean-close]");
const body = document.querySelector("[data-clean-body]");
const foot = document.querySelector("[data-clean-foot]");
const trigger = document.querySelector("[data-clean-trigger]");
const confirm = document.querySelector("[data-clean-confirm]");
const confirmMsg = document.querySelector("[data-clean-confirm-msg]");
const confirmGo = document.querySelector("[data-clean-confirm-go]");
const cancelBtn = document.querySelector("[data-clean-cancel]");

if (!drawer || !openBtn) {
  // 骨格が無い detail ページ等では何もしない
} else {
  let selected = new Set();
  let candidatesById = new Map();

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function openDrawer() {
    drawer.hidden = false;
    overlay.hidden = false;
    requestAnimationFrame(() => {
      drawer.setAttribute("data-open", "");
      overlay.setAttribute("data-open", "");
      drawer.setAttribute("aria-hidden", "false");
    });
    document.body.style.overflow = "hidden";
    void load();
  }

  function closeDrawer() {
    drawer.removeAttribute("data-open");
    overlay.removeAttribute("data-open");
    drawer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    setTimeout(() => {
      drawer.hidden = true;
      overlay.hidden = true;
      confirm.hidden = true;
    }, 220);
  }

  async function load() {
    selected = new Set();
    body.innerHTML = '<p class="clean-drawer__loading">読み込み中…</p>';
    foot.hidden = true;
    try {
      const res = await fetch("/api/clean/candidates");
      if (!res.ok) throw new Error("status " + res.status);
      const data = await res.json();
      candidatesById = new Map();
      for (const s of SECTIONS) {
        for (const c of data[s.key] ?? []) candidatesById.set(c.id, { ...c, kind: s.key });
      }
      render(data);
    } catch (e) {
      body.innerHTML = `<p class="clean-drawer__empty">読み込みに失敗しました: ${escapeHtml(e.message)}</p>`;
    }
  }

  function render(data) {
    const total = SECTIONS.reduce((n, s) => n + (data[s.key]?.length ?? 0), 0);
    if (total === 0) {
      body.innerHTML = '<p class="clean-drawer__empty">削除候補なし。書庫は整っています。</p>';
      foot.hidden = true;
      return;
    }
    const parts = [];
    for (const s of SECTIONS) {
      const rows = data[s.key] ?? [];
      if (rows.length === 0) continue;
      parts.push(`
        <section class="clean-section" data-section="${s.key}">
          <h3 class="clean-section__head">
            <span>${s.label}</span>
            <span class="clean-section__count">${rows.length}</span>
            <button type="button" class="clean-section__bulk" data-bulk="${s.key}">全選択</button>
          </h3>
          <div class="clean-section__rows">
            ${rows.map(renderRow).join("")}
          </div>
        </section>`);
    }
    body.innerHTML = parts.join("");
    foot.hidden = false;
    bindRows();
    updateTrigger();
  }

  function renderRow(c) {
    return `
      <label class="clean-row" data-id="${escapeHtml(c.id)}">
        <input type="checkbox" class="clean-row__check" data-check value="${escapeHtml(c.id)}">
        <div>
          <span class="clean-row__title">${escapeHtml(c.title)}</span>
          <span class="clean-row__id">${escapeHtml(c.id)}</span>
          ${c.cwd ? `<span class="clean-row__cwd">↳ ${escapeHtml(c.cwd)}</span>` : ""}
        </div>
      </label>`;
  }

  function bindRows() {
    body.querySelectorAll("[data-check]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.value;
        const row = cb.closest(".clean-row");
        if (cb.checked) {
          selected.add(id);
          row?.setAttribute("data-checked", "");
        } else {
          selected.delete(id);
          row?.removeAttribute("data-checked");
        }
        updateTrigger();
      });
    });
    body.querySelectorAll("[data-bulk]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const section = btn.closest(".clean-section");
        const checks = section?.querySelectorAll("[data-check]") ?? [];
        const allOn = Array.from(checks).every((c) => c.checked);
        checks.forEach((c) => {
          c.checked = !allOn;
          c.dispatchEvent(new Event("change"));
        });
        btn.textContent = allOn ? "全選択" : "全解除";
      });
    });
  }

  function updateTrigger() {
    const n = selected.size;
    trigger.disabled = n === 0;
    trigger.textContent = `${n} 件を削除`;
    if (n === 0) confirm.hidden = true;
  }

  function showConfirm() {
    if (selected.size === 0) return;
    confirmMsg.textContent = `${selected.size} 件の task dir を完全に削除します。元に戻せません。`;
    confirm.hidden = false;
  }

  async function execDelete() {
    const ids = Array.from(selected);
    confirmGo.disabled = true;
    confirmGo.textContent = "削除中…";
    try {
      const res = await fetch("/api/clean/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || "削除に失敗しました");
      for (const id of result.deleted ?? []) {
        const row = body.querySelector(`.clean-row[data-id="${cssEscape(id)}"]`);
        if (row) row.setAttribute("data-removing", "");
      }
      const msg = buildResultMsg(result);
      toast(msg);
      setTimeout(() => {
        void load();
      }, 240);
    } catch (e) {
      toast("失敗: " + e.message);
    } finally {
      confirmGo.disabled = false;
      confirmGo.textContent = "削除を実行";
      confirm.hidden = true;
    }
  }

  function buildResultMsg(r) {
    const parts = [];
    parts.push(`削除 ${r.deleted?.length ?? 0} 件`);
    if (r.skipped?.length) parts.push(`スキップ ${r.skipped.length} 件`);
    if (r.failed?.length) parts.push(`失敗 ${r.failed.length} 件`);
    return parts.join(" / ");
  }

  function toast(msg) {
    const el = document.createElement("div");
    el.className = "clean-toast";
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2600);
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }

  openBtn.addEventListener("click", openDrawer);
  closeBtn?.addEventListener("click", closeDrawer);
  overlay?.addEventListener("click", closeDrawer);
  cancelBtn?.addEventListener("click", () => {
    confirm.hidden = true;
  });
  trigger?.addEventListener("click", showConfirm);
  confirmGo?.addEventListener("click", execDelete);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !drawer.hidden) closeDrawer();
  });
}
