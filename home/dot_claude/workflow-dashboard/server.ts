// workflow-dashboard — ~/.claude/workflow/ の md 成果物をカンバン + プレビューで見る
import { marked } from "marked";
import hljs from "highlight.js";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const WORKFLOW_ROOT = join(homedir(), ".claude", "workflow");
// portless 経由なら proxy が PORT を注入する。単体起動（PORT 未設定）は 4519
const PORT = Number(process.env.PORT) || 4519;
// タブはフェーズ進行順 (research → plan → verify-results) で並べる
const DOC_FILES = ["research.md", "plan.md", "verify-results.md"] as const;
const HLJS_THEME_CSS = readFileSync(
  join(import.meta.dir, "node_modules/highlight.js/styles/github-dark.css"),
  "utf8",
);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// fenced code: lang=mermaid は pre.mermaid（クライアント側で図に変換）、
// それ以外は hljs でサーバ側ハイライト
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      if (lang === "mermaid") {
        return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`;
      }
      if (lang && hljs.getLanguage(lang)) {
        const html = hljs.highlight(text, { language: lang }).value;
        return `<pre><code class="hljs language-${escapeHtml(lang)}">${html}\n</code></pre>\n`;
      }
      return `<pre><code class="hljs">${escapeHtml(text)}\n</code></pre>\n`;
    },
  },
});

type Phase = "in-progress" | "review" | "pr-pending" | "pr-open" | "done";

const COLUMNS: { phase: Phase; label: string }[] = [
  { phase: "in-progress", label: "In Progress" },
  { phase: "review", label: "Review" },
  { phase: "pr-pending", label: "PR Pending" },
  { phase: "pr-open", label: "PR Open" },
  { phase: "done", label: "Done" },
];

interface Pr {
  number?: number;
  url?: string;
  merged?: boolean;
}

interface Task {
  id: string;
  title: string;
  phase: Phase;
  docs: string[];
  updatedAt: number;
  cwd: string | null;
  dependsOn: string[];
  pr: Pr | null;
  noPr: boolean;
}

function readMaybe(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// meta.json を読む。cwd は非空文字列のみ採用、dependsOn は string[]、pr は object のみ、
// title は非空文字列のみ、noPr は boolean のみ（PR を作らないタスクの明示宣言）。
function readMeta(dir: string): {
  cwd: string | null;
  dependsOn: string[];
  pr: Pr | null;
  title: string | null;
  noPr: boolean;
} {
  const raw = readMaybe(join(dir, "meta.json"));
  if (!raw)
    return { cwd: null, dependsOn: [], pr: null, title: null, noPr: false };
  try {
    const j = JSON.parse(raw);
    const cwd = typeof j.cwd === "string" && j.cwd.length > 0 ? j.cwd : null;
    const dependsOn = Array.isArray(j.dependsOn)
      ? j.dependsOn.filter((x: unknown): x is string => typeof x === "string")
      : [];
    const pr = j.pr && typeof j.pr === "object" ? (j.pr as Pr) : null;
    const title = typeof j.title === "string" && j.title.length > 0 ? j.title : null;
    const noPr = j.noPr === true;
    return { cwd, dependsOn, pr, title, noPr };
  } catch {
    return { cwd: null, dependsOn: [], pr: null, title: null, noPr: false };
  }
}

function shortenHome(p: string): string {
  const home = homedir();
  return p === home || p.startsWith(home + "/") ? "~" + p.slice(home.length) : p;
}

// meta.json の title を最優先し、なければ plan.md / research.md の先頭見出しを使う。接頭辞 "Plan — " 等は落とす
function deriveTitle(id: string, plan: string | null, research: string | null, metaTitle: string | null): string {
  if (metaTitle) return metaTitle;
  const src = plan ?? research ?? "";
  const m = src.match(/^#\s+(.+)$/m);
  if (!m) return id;
  return m[1].replace(/^(Plan|Research)\s*[—-]\s*/, "").trim();
}

// phase は plan.md ヘッダの明示シグナルで決める（pr を最優先）。
// verify-results.md に `- Status: done` 行があれば done（Phase 7 完了シグナル）。
// verify-results.md の存在だけでは done 判定しない（Phase 6 途中で作られるため）。
function derivePhase(plan: string | null, hasResearch: boolean, pr: Pr | null, verify: string | null): Phase {
  if (pr) return pr.merged ? "done" : "pr-open";
  if (plan && /^- Plan Status:\s*done/m.test(plan)) return "done";
  if (verify && /^- Status:\s*done/m.test(verify)) return "done";
  // 承認済み（Phase 5 実装中）は in-progress。Plan Status: complete のままなので
  // review より先に判定する
  if (plan && /^- Approval Status:\s*approved/m.test(plan)) return "in-progress";
  // レビュー完了・人間承認待ち。draft 段階（Approval Status: pending のまま）は
  // ここに該当させない — Plan Status: complete を必須にする
  if (plan && /^- Plan Status:\s*complete/m.test(plan)) return "review";
  if (plan) return "in-progress";
  if (hasResearch) return "in-progress";
  // plan/research 皆無のタスクも in-progress 扱い（Todo 列は廃止）
  return "in-progress";
}

function scanTasks(): Task[] {
  if (!existsSync(WORKFLOW_ROOT)) return [];
  const tasks: Task[] = [];
  for (const entry of readdirSync(WORKFLOW_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(WORKFLOW_ROOT, entry.name);
    const plan = readMaybe(join(dir, "plan.md"));
    const research = readMaybe(join(dir, "research.md"));
    const verify = readMaybe(join(dir, "verify-results.md"));
    const docs = DOC_FILES.filter((f) => existsSync(join(dir, f)));
    const meta = readMeta(dir);
    // orphan: cwd が指す作業ディレクトリが消えているタスクはボードに出さない
    if (meta.cwd && !existsSync(meta.cwd)) continue;
    let updatedAt = 0;
    for (const f of docs) {
      const t = statSync(join(dir, f)).mtimeMs;
      if (t > updatedAt) updatedAt = t;
    }
    tasks.push({
      id: entry.name,
      title: deriveTitle(entry.name, plan, research, meta.title),
      phase: derivePhase(plan, research !== null, meta.pr, verify),
      docs,
      updatedAt,
      cwd: meta.cwd,
      dependsOn: meta.dependsOn,
      pr: meta.pr,
    });
  }
  return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
<style>${HLJS_THEME_CSS}</style>
</head><body>
<header class="topbar"><a class="brand" href="/">&#9881; Workflow Dashboard</a></header>
<main>${body}</main>
</body></html>`;
}

// カード 1 枚。card 全体は a にせず card-title を主リンクにする
// （PR バッジ・依存リンクを入れ子にするため <a> の入れ子を避ける）
function renderCard(t: Task, byId: Map<string, Task>): string {
  let prBadge = "";
  if (t.pr) {
    const state = t.pr.merged ? "merged" : "open";
    const num = t.pr.number ? `#${t.pr.number}` : "PR";
    const inner = `${num} ${state}`;
    prBadge = t.pr.url
      ? `<a class="pr-badge pr-${state}" href="${esc(t.pr.url)}" target="_blank" rel="noopener">${inner}</a>`
      : `<span class="pr-badge pr-${state}">${inner}</span>`;
  }
  let deps = "";
  if (t.dependsOn.length) {
    const items = t.dependsOn
      .map((depId) => {
        const dep = byId.get(depId);
        if (!dep)
          return `<span class="dep dep-unknown">&#8627; ${esc(depId)} (不明)</span>`;
        const blocked = dep.phase !== "done";
        return `<a class="dep${blocked ? " dep-blocked" : ""}" href="/task/${encodeURIComponent(depId)}">&#8627; ${esc(dep.title)}</a>`;
      })
      .join("");
    deps = `<div class="card-deps">${items}</div>`;
  }
  return `
        <div class="card">
          <a class="card-title" href="/task/${encodeURIComponent(t.id)}">${esc(t.title)}</a>
          <div class="card-id">${esc(t.id)}</div>
          ${t.cwd ? `<div class="card-cwd">&#128193; ${esc(shortenHome(t.cwd))}</div>` : ""}
          ${prBadge}
          ${deps}
          <div class="card-docs">${t.docs
            .map((d) => `<span class="doc-chip">${d.replace(".md", "")}</span>`)
            .join("")}</div>
        </div>`;
}

function renderBoard(): string {
  const tasks = scanTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const cols = COLUMNS.map(({ phase, label }) => {
    const inCol = tasks.filter((t) => t.phase === phase);
    const cards = inCol.map((t) => renderCard(t, byId)).join("");
    return `
      <section class="col" id="col-${phase}">
        <h2 class="col-head">
          <span class="col-label phase-${phase}">${label}</span>
          <span class="col-count">${inCol.length}</span>
        </h2>
        <div class="col-body">${cards || '<p class="empty">&mdash;</p>'}</div>
      </section>`;
  }).join("");
  return page("Workflow Dashboard", `<div class="board">${cols}</div>`);
}

function renderTask(id: string): string | null {
  // パストラバーサル対策: タスク id はディレクトリ名のみ許可
  if (id.includes("/") || id.includes("..")) return null;
  const dir = join(WORKFLOW_ROOT, id);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const docs = DOC_FILES.filter((f) => existsSync(join(dir, f)));
  if (docs.length === 0) {
    return page(
      id,
      `<div class="detail"><a class="back" href="/">&larr; Board</a><h1>${esc(id)}</h1><p class="empty">md ドキュメントなし</p></div>`,
    );
  }
  const tabs = docs
    .map(
      (f, i) =>
        `<button class="tab${i === 0 ? " active" : ""}" data-doc="${f}">${f.replace(".md", "")}</button>`,
    )
    .join("");
  const panels = docs
    .map((f, i) => {
      const raw = readFileSync(join(dir, f), "utf8");
      const rendered = marked.parse(raw) as string;
      return `<article class="panel${i === 0 ? " active" : ""}" data-doc="${f}">${rendered}</article>`;
    })
    .join("");
  return page(
    id,
    `<div class="detail">
      <a class="back" href="/">&larr; Board</a>
      <h1>${esc(id)}</h1>
      <div class="tabs">${tabs}</div>
      <div class="panels markdown">${panels}</div>
    </div>
    <script type="module">
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
    </script>`,
  );
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/") return html(renderBoard());
    if (path === "/style.css") {
      return new Response(Bun.file(join(import.meta.dir, "style.css")), {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    }
    // mermaid 本体と分割 chunk (dist/chunks/mermaid.esm.min/*.mjs) をまとめて配信
    const vendor = path.match(/^\/vendor\/([\w./-]+\.mjs(?:\.map)?)$/);
    if (vendor && !vendor[1].includes("..")) {
      const file = join(import.meta.dir, "node_modules/mermaid/dist", vendor[1]);
      return new Response(Bun.file(file), {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    }
    const m = path.match(/^\/task\/(.+)$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const body = renderTask(id);
      if (body) return html(body);
      return html(
        page(
          "Not Found",
          `<div class="detail"><a class="back" href="/">&larr; Board</a><h1>404</h1><p class="empty">タスク「${esc(id)}」が見つかりません</p></div>`,
        ),
        404,
      );
    }
    return new Response("Not Found", { status: 404 });
  },
});

console.log(`workflow-dashboard → http://localhost:${server.port}`);
