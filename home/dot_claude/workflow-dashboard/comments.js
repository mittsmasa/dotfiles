// 行コメント機能（difit / GitHub 風の左ガター「＋」ボタン）。
// - 各ブロック（[data-sl] / [data-el] を持つ）の左ガターにホバーで「＋」を出す
// - ＋クリック = 単体ブロック / ＋から縦ドラッグ = 連続ブロック範囲
// - composer で本文入力 → POST /api/comments で永続化
// - コメント済みブロックに accent border + 件数チップ
// - 右ドックに doc 別一覧、単体削除 / 全削除（確認付き）/ 全部コピー
//
// 行番号は「元ソース行」。preview 上はブロック単位で扱い、選択は連続範囲のみ。

const detail = document.querySelector(".detail[data-task]");
if (detail) {
  const taskId = detail.dataset.task;
  const panelsWrap = detail.querySelector(".panels");

  const addBtn = document.querySelector("[data-comment-add]");
  // ＋ボタンは panels 内（position:relative + 左ガター padding）に移し、
  // ブロックの offset 基準で絶対配置できるようにする
  panelsWrap.appendChild(addBtn);
  const dock = document.querySelector("[data-comment-dock]");
  const overlay = document.querySelector("[data-comment-overlay]");
  const listEl = document.querySelector("[data-comment-list]");
  const openBtn = document.querySelector("[data-comments-open]");
  const closeBtn = document.querySelector("[data-comments-close]");
  const countBadge = document.querySelector("[data-comments-count]");
  const countDock = document.querySelector("[data-comments-count-dock]");
  const copyAllBtn = document.querySelector("[data-copy-all]");
  const clearAllBtn = document.querySelector("[data-clear-all]");
  const clearConfirm = document.querySelector("[data-clear-confirm]");
  const clearConfirmMsg = document.querySelector("[data-clear-confirm-msg]");
  const clearCancel = document.querySelector("[data-clear-cancel]");
  const clearGo = document.querySelector("[data-clear-go]");

  /** @type {Array<{id,doc,startLine,endLine,body,createdAt}>} */
  let comments = [];
  // doc(rel) → 絶対パス。コピー出力でフルパスを引くため
  const docPaths = new Map();
  for (const a of detail.querySelectorAll("article[data-doc-rel]")) {
    docPaths.set(a.dataset.docRel, a.dataset.path);
  }

  const activePanel = () => detail.querySelector(".panel.active");

  // パネル内の「トップレベル」ブロック（祖先に別の [data-sl] を持たないもの）。
  // ネストした <p>/<li> の重なりを避け、ガター＋と範囲選択の単位を一意にする。
  function topBlocks(panel) {
    if (!panel) return [];
    return Array.from(panel.querySelectorAll("[data-sl]")).filter(
      (el) => !el.parentElement.closest("[data-sl]"),
    );
  }

  // 任意要素 → それを含むトップブロック（無ければ null）
  function toTopBlock(panel, el) {
    if (!panel || !el) return null;
    const blocks = topBlocks(panel);
    for (const b of blocks) if (b === el || b.contains(el)) return b;
    return null;
  }

  // ---- ＋ボタンのホバー追従 ----
  let hoverBlock = null;

  function placeAddBtn(block) {
    if (!block) {
      addBtn.hidden = true;
      hoverBlock = null;
      return;
    }
    hoverBlock = block;
    const pr = panelsWrap.getBoundingClientRect();
    const br = block.getBoundingClientRect();
    // panelsWrap は position:relative。左ガター内に縦位置をブロック頭へ合わせる
    addBtn.style.top = `${br.top - pr.top + panelsWrap.scrollTop}px`;
    addBtn.hidden = false;
  }

  panelsWrap.addEventListener("mousemove", (e) => {
    if (dragging) return;
    const panel = activePanel();
    const block = toTopBlock(panel, e.target.closest("[data-sl]"));
    if (block && block !== hoverBlock) placeAddBtn(block);
    else if (!block && !addBtn.matches(":hover")) {
      // ガター（ブロック外）に居るときは消さない（＋を押しに行けるように）
      if (!e.target.closest("[data-sl]")) addBtn.hidden = true, (hoverBlock = null);
    }
  });

  // ---- ＋からのドラッグ範囲選択 ----
  let dragging = false;
  let anchorBlock = null;
  let focusBlock = null;
  let moved = false;

  function highlightRange(panel, a, b) {
    const blocks = topBlocks(panel);
    const ia = blocks.indexOf(a);
    const ib = blocks.indexOf(b);
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    blocks.forEach((el, i) => el.classList.toggle("comment-selecting", i >= lo && i <= hi));
    return blocks.slice(lo, hi + 1);
  }

  function clearSelecting(panel) {
    if (!panel) return;
    for (const el of panel.querySelectorAll(".comment-selecting"))
      el.classList.remove("comment-selecting");
  }

  addBtn.addEventListener("mousedown", (e) => {
    e.preventDefault();
    if (!hoverBlock) return;
    dragging = true;
    moved = false;
    anchorBlock = hoverBlock;
    focusBlock = hoverBlock;
    highlightRange(activePanel(), anchorBlock, focusBlock);
  });

  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const panel = activePanel();
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const block = toTopBlock(panel, under && under.closest && under.closest("[data-sl]"));
    if (block && block !== focusBlock) {
      focusBlock = block;
      moved = true;
      highlightRange(panel, anchorBlock, focusBlock);
    }
  });

  document.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    const panel = activePanel();
    const range = highlightRange(panel, anchorBlock, focusBlock);
    clearSelecting(panel);
    if (range.length) openComposer(panel, range);
    anchorBlock = focusBlock = null;
  });

  // ---- composer ----
  let composerEl = null;

  function closeComposer() {
    if (composerEl) {
      composerEl.remove();
      composerEl = null;
    }
  }

  function openComposer(panel, range) {
    closeComposer();
    const docRel = panel.dataset.docRel;
    const startLine = Math.min(...range.map((b) => +b.dataset.sl));
    const endLine = Math.max(...range.map((b) => +b.dataset.el));
    const lineLabel = startLine === endLine ? `${startLine}` : `${startLine}-${endLine}`;

    composerEl = document.createElement("div");
    composerEl.className = "comment-composer";
    composerEl.innerHTML = `
      <div class="comment-composer__head">${escapeHtml(docRel)}:${lineLabel}</div>
      <textarea class="comment-composer__input" placeholder="コメントを入力…"></textarea>
      <div class="comment-composer__actions">
        <button type="button" class="comment-btn comment-btn--ghost" data-cc-cancel>キャンセル</button>
        <button type="button" class="comment-btn comment-btn--primary" data-cc-save>保存</button>
      </div>`;
    document.body.appendChild(composerEl);

    // 範囲末尾ブロックの直下に配置
    const last = range[range.length - 1];
    const lr = last.getBoundingClientRect();
    composerEl.style.top = `${window.scrollY + lr.bottom + 6}px`;
    composerEl.style.left = `${window.scrollX + lr.left}px`;

    const input = composerEl.querySelector("textarea");
    input.focus();

    const cancel = () => closeComposer();
    composerEl.querySelector("[data-cc-cancel]").addEventListener("click", cancel);
    composerEl.querySelector("[data-cc-save]").addEventListener("click", async () => {
      const body = input.value.trim();
      if (!body) {
        input.focus();
        return;
      }
      const saveBtn = composerEl.querySelector("[data-cc-save]");
      saveBtn.disabled = true;
      try {
        const res = await fetch("/api/comments", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: taskId, doc: docRel, startLine, endLine, body }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "保存に失敗しました");
        closeComposer();
        await loadComments();
      } catch (err) {
        saveBtn.disabled = false;
        saveBtn.textContent = "失敗: " + (err?.message ?? err);
        setTimeout(() => (saveBtn.textContent = "保存"), 2400);
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") cancel();
      // Cmd/Ctrl+Enter で保存
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
        composerEl.querySelector("[data-cc-save]").click();
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeComposer();
      if (dragging) {
        dragging = false;
        clearSelecting(activePanel());
      }
    }
  });

  // ---- ハイライト描画（コメント済みブロック） ----
  function renderHighlights() {
    // 既存のチップ / border を全 panel から撤去
    for (const el of detail.querySelectorAll(".has-comment")) {
      el.classList.remove("has-comment");
      const chip = el.querySelector(":scope > .comment-chip");
      if (chip) chip.remove();
    }
    // doc 別にカウント
    const byBlock = new Map(); // block element → count
    for (const a of detail.querySelectorAll("article[data-doc-rel]")) {
      const docRel = a.dataset.docRel;
      const blocks = topBlocks(a);
      for (const c of comments) {
        if (c.doc !== docRel) continue;
        for (const b of blocks) {
          const sl = +b.dataset.sl;
          const el = +b.dataset.el;
          // 行範囲が交差するブロックをコメント済みに
          if (c.startLine <= el && c.endLine >= sl) {
            byBlock.set(b, (byBlock.get(b) || 0) + (b.dataset.sl == c.startLine ? 1 : 0));
            b.classList.add("has-comment");
          }
        }
      }
    }
    for (const [b, count] of byBlock) {
      if (count <= 0) continue;
      const chip = document.createElement("span");
      chip.className = "comment-chip";
      chip.textContent = count;
      chip.title = `${count} 件のコメント`;
      b.appendChild(chip);
    }
  }

  // ---- 一覧ドック描画 ----
  function renderDock() {
    const n = comments.length;
    if (countDock) countDock.textContent = n;
    if (countBadge) {
      countBadge.textContent = n;
      countBadge.hidden = n === 0;
    }
    copyAllBtn.disabled = n === 0;
    clearAllBtn.disabled = n === 0;

    if (n === 0) {
      listEl.innerHTML =
        '<p class="comment-dock__empty">まだコメントはありません。preview の行左端の＋から付けられます。</p>';
      return;
    }
    // doc 別にグループ化し、行番号昇順
    const groups = new Map();
    for (const c of comments) {
      if (!groups.has(c.doc)) groups.set(c.doc, []);
      groups.get(c.doc).push(c);
    }
    let html = "";
    for (const [doc, items] of groups) {
      items.sort((a, b) => a.startLine - b.startLine || a.createdAt - b.createdAt);
      html += `<div class="comment-group"><h3 class="comment-group__doc">${escapeHtml(doc)}</h3>`;
      for (const c of items) {
        const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
        html += `
          <div class="comment-item" data-comment-id="${escapeHtml(c.id)}">
            <div class="comment-item__head">
              <a class="comment-item__loc" href="#" data-jump data-doc="${escapeHtml(doc)}" data-line="${c.startLine}">:${range}</a>
              <button type="button" class="comment-item__del" data-del aria-label="削除">&times;</button>
            </div>
            <div class="comment-item__body">${escapeHtml(c.body).replace(/\n/g, "<br>")}</div>
          </div>`;
      }
      html += `</div>`;
    }
    listEl.innerHTML = html;

    // 削除ハンドラ
    for (const btn of listEl.querySelectorAll("[data-del]")) {
      btn.addEventListener("click", async () => {
        const id = btn.closest("[data-comment-id]").dataset.commentId;
        btn.disabled = true;
        try {
          const res = await fetch("/api/comments", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ task: taskId, id }),
          });
          if (!res.ok) throw new Error("削除に失敗");
          await loadComments();
        } catch {
          btn.disabled = false;
        }
      });
    }
    // ジャンプ（該当 doc タブを開いてブロックへスクロール）
    for (const link of listEl.querySelectorAll("[data-jump]")) {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        const doc = link.dataset.doc;
        const line = +link.dataset.line;
        const tab = detail.querySelector(`.tab[data-doc="${doc}"]`);
        if (tab && !tab.classList.contains("active")) tab.click();
        const panel = detail.querySelector(`.panel[data-doc="${doc}"]`);
        const target = topBlocks(panel).find(
          (b) => +b.dataset.sl <= line && +b.dataset.el >= line,
        );
        if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
  }

  // ---- コピー ----
  function buildCopyText() {
    const groups = new Map();
    for (const c of comments) {
      if (!groups.has(c.doc)) groups.set(c.doc, []);
      groups.get(c.doc).push(c);
    }
    const lines = [];
    for (const [doc, items] of groups) {
      items.sort((a, b) => a.startLine - b.startLine || a.createdAt - b.createdAt);
      const absPath = docPaths.get(doc) || doc;
      for (const c of items) {
        const range = c.startLine === c.endLine ? `${c.startLine}` : `${c.startLine}-${c.endLine}`;
        const body = c.body.split("\n");
        lines.push(`- ${absPath}:${range} — ${body[0]}`);
        for (let i = 1; i < body.length; i++) lines.push(`  ${body[i]}`);
      }
    }
    return lines.join("\n");
  }

  copyAllBtn.addEventListener("click", async () => {
    const text = buildCopyText();
    const prev = copyAllBtn.innerHTML;
    try {
      await navigator.clipboard.writeText(text);
      copyAllBtn.textContent = "コピーしました";
    } catch (err) {
      console.error("clipboard 失敗", err);
      copyAllBtn.textContent = "コピー不可";
    }
    setTimeout(() => (copyAllBtn.innerHTML = prev), 1800);
  });

  // ---- 全削除（確認付き） ----
  clearAllBtn.addEventListener("click", () => {
    clearConfirmMsg.textContent = `${comments.length} 件すべて削除します。元に戻せません。`;
    clearConfirm.hidden = false;
  });
  clearCancel.addEventListener("click", () => (clearConfirm.hidden = true));
  clearGo.addEventListener("click", async () => {
    clearGo.disabled = true;
    try {
      const res = await fetch("/api/comments", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: taskId, all: true }),
      });
      if (!res.ok) throw new Error("全削除に失敗");
      clearConfirm.hidden = true;
      await loadComments();
    } finally {
      clearGo.disabled = false;
    }
  });

  // ---- ドック開閉 ----
  function openDock() {
    dock.hidden = false;
    dock.setAttribute("aria-hidden", "false");
    overlay.hidden = false;
    openBtn.setAttribute("aria-expanded", "true");
  }
  function closeDock() {
    dock.hidden = true;
    dock.setAttribute("aria-hidden", "true");
    overlay.hidden = true;
    openBtn.setAttribute("aria-expanded", "false");
    clearConfirm.hidden = true;
  }
  openBtn.addEventListener("click", () => (dock.hidden ? openDock() : closeDock()));
  closeBtn.addEventListener("click", closeDock);
  overlay.addEventListener("click", closeDock);

  // タブ切替でハイライトを貼り直す（active panel が変わるため）
  for (const tab of detail.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => {
      addBtn.hidden = true;
      hoverBlock = null;
      requestAnimationFrame(renderHighlights);
    });
  }

  // ---- 読み込み ----
  async function loadComments() {
    try {
      const res = await fetch(`/api/comments?task=${encodeURIComponent(taskId)}`);
      comments = res.ok ? await res.json() : [];
    } catch {
      comments = [];
    }
    renderHighlights();
    renderDock();
  }

  function escapeHtml(s) {
    return String(s).replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
    );
  }

  loadComments();
}
