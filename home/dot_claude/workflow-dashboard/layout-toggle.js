const STORAGE_KEY = "workflow-dashboard:layout";
const VALID = new Set(["horizontal", "vertical"]);

function read() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return VALID.has(v) ? v : "horizontal";
  } catch {
    return "horizontal";
  }
}

function write(v) {
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {}
}

function apply(layout) {
  document.body.dataset.layout = layout;
  for (const btn of document.querySelectorAll("[data-layout-btn]")) {
    btn.setAttribute("aria-pressed", btn.dataset.layoutBtn === layout ? "true" : "false");
  }
}

apply(read());

for (const btn of document.querySelectorAll("[data-layout-btn]")) {
  btn.addEventListener("click", () => {
    const next = btn.dataset.layoutBtn;
    if (!VALID.has(next)) return;
    write(next);
    apply(next);
  });
}
