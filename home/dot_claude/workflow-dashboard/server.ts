// workflow-dashboard — ~/.claude/workflow/ の md 成果物をカンバン + プレビューで見る
import { marked } from "marked";
import hljs from "highlight.js";
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const WORKFLOW_ROOT = join(homedir(), ".claude", "workflow");
// portless 経由なら proxy が PORT を注入する。単体起動（PORT 未設定）は 4519
const PORT = Number(process.env.PORT) || 4519;
// タブはフェーズ進行順 (research → plan → verify-results) で並べる
const DOC_FILES = ["research.md", "plan.md", "verify-results.md"] as const;
const HLJS_THEME_CSS = readFileSync(
  join(import.meta.dir, "node_modules/highlight.js/styles/github-dark.css"),
  "utf8",
);
const TASK_DETAIL_JS = readFileSync(
  join(import.meta.dir, "task-detail.js"),
  "utf8",
);
const CLEAN_DRAWER_JS = readFileSync(
  join(import.meta.dir, "clean-drawer.js"),
  "utf8",
);
const LAYOUT_TOGGLE_JS = readFileSync(
  join(import.meta.dir, "layout-toggle.js"),
  "utf8",
);
const WORKFLOW_ROOT_REAL = (() => {
  try {
    return realpathSync(WORKFLOW_ROOT);
  } catch {
    return WORKFLOW_ROOT;
  }
})();

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// fenced code: lang=mermaid は pre.mermaid（クライアント側で図に変換）、
// それ以外は hljs でサーバ側ハイライト
marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      if (lang === "mermaid") {
        return `<pre class="mermaid">${esc(text)}</pre>\n`;
      }
      if (lang && hljs.getLanguage(lang)) {
        const html = hljs.highlight(text, { language: lang }).value;
        return `<pre><code class="hljs language-${esc(lang)}">${html}\n</code></pre>\n`;
      }
      return `<pre><code class="hljs">${esc(text)}\n</code></pre>\n`;
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
  repoRoot: string | null;
  dependsOn: string[];
  pr: Pr | null;
  noPr: boolean;
  archived: boolean;
}

function readMaybe(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

// meta.json を読む。cwd は非空文字列のみ採用、dependsOn は string[]、
// title は非空文字列のみ、noPr は boolean のみ（PR を作らないタスクの明示宣言）。
// pr は手書きフォールバック用に読む。live 取得が成功したらそちらが優先され、
// 失敗時 or 検索ヒットなしのときだけ meta.pr が使われる（merge 済み feature
// ブランチが消えた後のタスクが pr-pending に降格するのを防ぐ）。
function readMeta(dir: string): {
  cwd: string | null;
  dependsOn: string[];
  title: string | null;
  noPr: boolean;
  pr: Pr | null;
  archived: boolean;
} {
  const empty = {
    cwd: null,
    dependsOn: [],
    title: null,
    noPr: false,
    pr: null,
    archived: false,
  };
  const raw = readMaybe(join(dir, "meta.json"));
  if (!raw) return empty;
  try {
    const j = JSON.parse(raw);
    const cwd = typeof j.cwd === "string" && j.cwd.length > 0 ? j.cwd : null;
    const dependsOn = Array.isArray(j.dependsOn)
      ? j.dependsOn.filter((x: unknown): x is string => typeof x === "string")
      : [];
    const title = typeof j.title === "string" && j.title.length > 0 ? j.title : null;
    const noPr = j.noPr === true;
    const pr = parseMetaPr(j.pr);
    const archived = j.archived === true;
    return { cwd, dependsOn, title, noPr, pr, archived };
  } catch {
    return empty;
  }
}

// meta.json の手書き pr を厳密にバリデート。number / url / merged の 3 つが
// すべて正しい型で揃ったときだけ採用し、それ以外は null（= PR 紐付けなし扱い）。
function parseMetaPr(v: unknown): Pr | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.number !== "number" || !Number.isInteger(o.number)) return null;
  if (typeof o.url !== "string" || o.url.length === 0) return null;
  if (typeof o.merged !== "boolean") return null;
  return { number: o.number, url: o.url, merged: o.merged };
}

// merged PR を meta.json に終端キャッシュする。merge 後に feature ブランチが
// 削除されると live 検索（headRefName ベース）がヒットしなくなり done 判定が
// 失われるため、merged を一度検知した時点で meta.json に焼き付けて永続化する。
// - 終端状態（merged）のみ書く。open は transient なのでキャッシュしない。
// - raw JSON をマージして書き戻し、createdAt / branch など既存キーを温存する。
// - 同一 merged PR が既にキャッシュ済みなら何もしない（無駄な再書き込み回避）。
// - 書き込み失敗は握りつぶす（phase 判定は live 値で続行、looks をクラッシュさせない）。
// archived フラグを meta.json にマージ書き戻し。persistMergedPr と同じく
// 既存キー（createdAt / branch など hook 補完分）を温存する。
// 成功時に true、書き込み失敗時に false を返す（呼び出し側で 500 にする）。
export function persistArchived(id: string, archived: boolean): boolean {
  const path = join(WORKFLOW_ROOT, id, "meta.json");
  try {
    const raw = readMaybe(path);
    const obj = raw ? JSON.parse(raw) : {};
    obj.archived = archived;
    writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
    return true;
  } catch {
    return false;
  }
}

export function persistMergedPr(id: string, pr: Pr): void {
  if (!pr.merged) return;
  const path = join(WORKFLOW_ROOT, id, "meta.json");
  try {
    const raw = readMaybe(path);
    const obj = raw ? JSON.parse(raw) : {};
    if (
      obj.pr &&
      obj.pr.merged === true &&
      obj.pr.number === pr.number &&
      obj.pr.url === pr.url
    ) {
      return;
    }
    obj.pr = { number: pr.number, url: pr.url, merged: true };
    writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  } catch {
    // noop: キャッシュ失敗時も live で得た pr で phase は確定済み
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

// plan.md / verify-results.md の status マーカーを行頭で拾う。
// canonical 書式は行頭 "- " 付き（plan-review-hook / verify-results.md と統一）だが、
// 旧 plan.md は dash 無し（"Plan Status: done"）で書かれていた時期があるため、
// 行頭の list プレフィックス（"- " / "* "）は任意として両形式を等価に扱う。
// キー名・値は ^ アンカー + 値直後の境界で厳密一致させ、本文中の散発的言及を誤検出しない。
export function hasMarker(text: string | null, key: string, value: string): boolean {
  if (!text) return false;
  const re = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?${key}:[ \\t]*${value}(?![\\w-])`, "im");
  return re.test(text);
}

// phase はマーカーシグナルと PR / dirty から派生する。
// 詳細な状態→列の対応は workflow.md Phase 7「dashboard 列対応表」を参照。
export function derivePhase(
  plan: string | null,
  pr: Pr | null,
  verify: string | null,
  noPr: boolean,
  dirty: boolean | null,
): Phase {
  if (pr) return pr.merged ? "done" : "pr-open";
  // 作業完了シグナル: plan.md の "Plan Status: done" か verify-results.md の "Status: done"
  const statusDone =
    hasMarker(plan, "Plan Status", "done") || hasMarker(verify, "Status", "done");
  if (statusDone) {
    // noPr タスク: PR を作らないので dirty で done / pr-pending を分ける。
    //   dirty===true               → 未コミットあり → pr-pending（作業未完了扱い）
    //   dirty===false または null   → clean、もしくは非 git（~/.claude 等）→ done
    // PR タスク（!noPr）: done は PR 側（上の pr 分岐）が支配する。ここに到達した時点で
    //   live / cache の PR が無い＝PR 未検出なので pr-pending で待つ。
    if (noPr) return dirty === true ? "pr-pending" : "done";
    return "pr-pending";
  }
  if (hasMarker(plan, "Approval Status", "approved")) return "in-progress";
  if (hasMarker(plan, "Plan Status", "complete")) return "review";
  return "in-progress";
}

// git remote の URL から owner / repo を抜く。SSH (git@github.com:owner/repo.git)
// と HTTPS (https://github.com/owner/repo[.git]) の両形式に対応
function parseRemote(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// porcelain --branch の 1 行目から branch 名を取り出す純関数。
//   "## <branch>...<upstream> [ahead/behind]" / "## <branch>"（upstream 無し）
//   / "## HEAD (no branch)"（detached）。
// upstream 区切り "..." の手前を branch 名とする（ブランチ名中のドットは保持）。
// detached HEAD や該当なしは null。
export function parseBranchLine(head: string): string | null {
  const bm = head.match(/^## (.+)$/);
  if (!bm) return null;
  const rest = bm[1];
  if (/\(no branch\)/.test(rest)) return null;
  const b = rest.split("...")[0].split(" ")[0];
  return b.length > 0 ? b : null;
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
    if (r.status !== 0) return { ok: false, stdout: "" };
    return { ok: true, stdout: (r.stdout ?? "").trim() };
  } catch {
    return { ok: false, stdout: "" };
  }
}

interface RepoState {
  dirty: boolean | null;
  branch: string | null;
  owner: string | null;
  repo: string | null;
  repoRoot: string;
}

// cwd 1 つから dashboard が必要とするすべての git 情報を集める。
// spawn 回数: status (dirty + branch) / remote / rev-parse の 3 回。
// 取得失敗時はそのフィールドだけ null（or fallback の cwd）になる。
function getRepoState(cwd: string): RepoState {
  // status --porcelain --branch:
  //   1 行目: "## <branch>...<remote/branch> [ahead/behind]" または "## HEAD (no branch)"
  //   2 行目以降: ファイル変更行（空なら clean）
  let dirty: boolean | null = null;
  let branch: string | null = null;
  const status = runGit(cwd, ["status", "--porcelain=v1", "--branch"]);
  if (status.ok) {
    const lines = status.stdout.split("\n");
    branch = parseBranchLine(lines[0] ?? "");
    dirty = lines.slice(1).some((l) => l.length > 0);
  }

  let owner: string | null = null;
  let repo: string | null = null;
  const remote = runGit(cwd, ["remote", "get-url", "origin"]);
  if (remote.ok && remote.stdout) {
    const parsed = parseRemote(remote.stdout);
    if (parsed) {
      owner = parsed.owner;
      repo = parsed.repo;
    }
  }

  // worktree から呼び出した場合は main repo の `.git` を指す common-dir が返る
  let repoRoot = cwd;
  const r = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (r.ok && r.stdout) {
    const idx = r.stdout.lastIndexOf("/");
    if (idx > 0) repoRoot = r.stdout.slice(0, idx);
  }
  return { dirty, branch, owner, repo, repoRoot };
}

function gqlEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// 全タスク分の PR を 1 リクエストでまとめて取得する。alias で複数 repository
// ノードを束ねた単一 query を `gh api graphql` に投げる。失敗時は空 Map を返す
// （PR バッジは非表示になる。meta.json 側に PR キャッシュは持たない）
function fetchLivePrs(
  inputs: Map<string, { owner: string; repo: string; branch: string }>,
): Map<string, Pr> {
  if (inputs.size === 0) return new Map();
  const aliases: { taskId: string; alias: string }[] = [];
  const fragments: string[] = [];
  let i = 0;
  for (const [taskId, info] of inputs) {
    const alias = `r${i++}`;
    aliases.push({ taskId, alias });
    const owner = gqlEscape(info.owner);
    const repo = gqlEscape(info.repo);
    const branch = gqlEscape(info.branch);
    fragments.push(
      `${alias}: repository(owner: "${owner}", name: "${repo}") { pullRequests(headRefName: "${branch}", states: [OPEN, MERGED], first: 1, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number url state } } }`,
    );
  }
  const query = `query { ${fragments.join(" ")} }`;
  let stdout = "";
  try {
    // timeout 5s で hard cancel。spawnSync の timeout で打ち切る（外部 timeout(1)
    // コマンドは macOS に無いため依存しない）。gh の認証は既存設定をそのまま使う
    const r = spawnSync("gh", ["api", "graphql", "-f", `query=${query}`], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (r.status !== 0) return new Map();
    stdout = r.stdout ?? "";
  } catch {
    return new Map();
  }
  try {
    const json = JSON.parse(stdout);
    const data = json.data ?? {};
    const result = new Map<string, Pr>();
    for (const { taskId, alias } of aliases) {
      const node = data[alias]?.pullRequests?.nodes?.[0];
      if (!node) continue;
      result.set(taskId, {
        number: node.number,
        url: node.url,
        merged: node.state === "MERGED",
      });
    }
    return result;
  } catch {
    return new Map();
  }
}

// 1 リクエスト分の board ビルド:
//   1) 各タスクの md / meta.json を読む
//   2) cwd を持つタスクについて getRepoState で git 情報をまとめて取得
//   3) graphql で全タスク分の PR を 1 リクエストで取得
//   4) derivePhase に live pr / dirty / noPr を渡して phase を確定
function scanTasks(): Task[] {
  if (!existsSync(WORKFLOW_ROOT)) return [];
  type Entry = {
    id: string;
    plan: string | null;
    research: string | null;
    verify: string | null;
    docs: string[];
    meta: ReturnType<typeof readMeta>;
    updatedAt: number;
    repo: RepoState | null;
  };
  const entries: Entry[] = [];
  const gitInputs = new Map<string, { owner: string; repo: string; branch: string }>();
  for (const dirent of readdirSync(WORKFLOW_ROOT, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const dir = join(WORKFLOW_ROOT, dirent.name);
    const plan = readMaybe(join(dir, "plan.md"));
    const research = readMaybe(join(dir, "research.md"));
    const verify = readMaybe(join(dir, "verify-results.md"));
    const docs = DOC_FILES.filter((f) => existsSync(join(dir, f)));
    const meta = readMeta(dir);
    // archive: 明示的に片付けたタスクはボードに出さない（Clean ドロワーには出る）
    if (meta.archived) continue;
    // orphan: cwd が指す作業ディレクトリが消えているタスクはボードに出さない
    if (meta.cwd && !existsSync(meta.cwd)) continue;
    const updatedAt = docs.reduce(
      (max, f) => Math.max(max, statSync(join(dir, f)).mtimeMs),
      0,
    );
    let repo: RepoState | null = null;
    if (meta.cwd) {
      repo = getRepoState(meta.cwd);
      if (repo.owner && repo.repo && repo.branch) {
        gitInputs.set(dirent.name, { owner: repo.owner, repo: repo.repo, branch: repo.branch });
      }
    }
    entries.push({ id: dirent.name, plan, research, verify, docs, meta, updatedAt, repo });
  }
  // graphql で全タスク分の PR を一括取得（失敗時は空 Map → PR バッジ非表示）
  const livePrs = fetchLivePrs(gitInputs);
  return entries
    .map<Task>((e) => {
      // live 取得を優先。ヒットなしのときだけ meta.json の手書き / キャッシュ pr へ
      // フォールバック（merge 済み feature ブランチが消えた後の done 判定に必要）
      const livePr = livePrs.get(e.id);
      const pr = livePr ?? e.meta.pr ?? null;
      // live で merged を検知したら meta.json に焼き付ける（次回ブランチ消滅でも done 維持）
      if (livePr?.merged) persistMergedPr(e.id, livePr);
      return {
        id: e.id,
        title: deriveTitle(e.id, e.plan, e.research, e.meta.title),
        phase: derivePhase(e.plan, pr, e.verify, e.meta.noPr, e.repo?.dirty ?? null),
        docs: e.docs,
        updatedAt: e.updatedAt,
        cwd: e.meta.cwd,
        repoRoot: e.repo?.repoRoot ?? null,
        dependsOn: e.meta.dependsOn,
        pr,
        noPr: e.meta.noPr,
        archived: e.meta.archived,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function page(
  title: string,
  body: string,
  opts: { withCleanDrawer?: boolean; withLayoutToggle?: boolean } = {},
): string {
  const drawer = opts.withCleanDrawer
    ? `
<div class="clean-overlay" data-clean-overlay hidden></div>
<aside class="clean-drawer" data-clean-drawer hidden aria-hidden="true" aria-labelledby="clean-drawer-title">
  <header class="clean-drawer__head">
    <h2 class="clean-drawer__title" id="clean-drawer-title">書庫の選別</h2>
    <button type="button" class="clean-drawer__close" data-clean-close aria-label="閉じる">&times;</button>
  </header>
  <p class="clean-drawer__lede">削除すると元に戻せません。対象を選んでから実行してください。</p>
  <div class="clean-drawer__body" data-clean-body>
    <p class="clean-drawer__loading">読み込み中…</p>
  </div>
  <footer class="clean-drawer__foot" data-clean-foot hidden>
    <div class="clean-confirm" data-clean-confirm hidden>
      <p class="clean-confirm__msg" data-clean-confirm-msg></p>
      <div class="clean-confirm__actions">
        <button type="button" class="clean-btn clean-btn--ghost" data-clean-cancel>キャンセル</button>
        <button type="button" class="clean-btn clean-btn--danger" data-clean-confirm-go>削除を実行</button>
      </div>
    </div>
    <button type="button" class="clean-btn clean-btn--primary" data-clean-trigger disabled>0 件を削除</button>
  </footer>
</aside>
<script type="module">${CLEAN_DRAWER_JS}</script>`
    : "";
  const layoutToggle = opts.withLayoutToggle
    ? `<div class="layout-toggle" role="group" aria-label="レイアウト切替">
    <button type="button" class="layout-toggle__btn" data-layout-btn="horizontal" aria-pressed="true" title="横並び (カンバン)"><span class="layout-toggle__icon" aria-hidden="true">⊟</span>Horizontal</button>
    <button type="button" class="layout-toggle__btn" data-layout-btn="vertical" aria-pressed="false" title="縦積み (grid)"><span class="layout-toggle__icon" aria-hidden="true">☰</span>Vertical</button>
  </div>`
    : "";
  const layoutScript = opts.withLayoutToggle
    ? `<script type="module">${LAYOUT_TOGGLE_JS}</script>`
    : "";
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
<style>${HLJS_THEME_CSS}</style>
</head><body data-layout="horizontal">
<header class="topbar">
  <a class="brand" href="/">&#9881; Workflow Dashboard</a>
  ${layoutToggle}
  ${opts.withCleanDrawer ? '<button type="button" class="topbar__clean" data-clean-open aria-label="クリーンアップ"><span class="topbar__clean-icon" aria-hidden="true">🧹</span><span class="topbar__clean-label">Clean</span></button>' : ""}
</header>
<main>${body}</main>
${drawer}
${layoutScript}
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

// `filter` が空文字なら全タスク、それ以外は repoRoot 前方一致のみ通す
function matchesFilter(task: Task, filter: string): boolean {
  if (filter === "") return true;
  if (!task.repoRoot) return false;
  return task.repoRoot === filter || task.repoRoot.startsWith(filter + "/");
}

// フィルタ選択肢を描画。repoRoot のユニーク集合 + 「すべて」を先頭に並べる
function renderFilterBar(allTasks: Task[], filter: string): string {
  const roots = Array.from(
    new Set(allTasks.map((t) => t.repoRoot).filter((r): r is string => !!r)),
  ).sort();
  const opts = [
    `<option value=""${filter === "" ? " selected" : ""}>すべて</option>`,
    ...roots.map(
      (r) =>
        `<option value="${esc(r)}"${r === filter ? " selected" : ""}>${esc(shortenHome(r))}</option>`,
    ),
  ].join("");
  return `
    <form class="filter-bar" method="get" action="/">
      <label class="filter-label" for="filter-cwd">ディレクトリで絞り込み</label>
      <select class="filter-select" id="filter-cwd" name="cwd" onchange="this.form.submit()">${opts}</select>
    </form>`;
}

interface CleanCandidate {
  id: string;
  title: string;
  cwd: string | null;
}
interface CleanCandidates {
  done: CleanCandidate[];
  archived: CleanCandidate[];
  orphan: CleanCandidate[];
  empty: CleanCandidate[];
}

// scanTasks と独立に走らせ、Clean drawer 用に 3 種類の削除候補を集める。
// orphan / empty は scanTasks では弾かれるので、ここで個別に拾い直す。
function scanCleanCandidates(): CleanCandidates {
  const result: CleanCandidates = { done: [], archived: [], orphan: [], empty: [] };
  if (!existsSync(WORKFLOW_ROOT)) return result;
  const liveTasks = scanTasks();
  const liveById = new Map(liveTasks.map((t) => [t.id, t]));
  for (const t of liveTasks) {
    if (t.phase === "done") {
      result.done.push({ id: t.id, title: t.title, cwd: t.cwd });
    }
  }
  for (const dirent of readdirSync(WORKFLOW_ROOT, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const id = dirent.name;
    const dir = join(WORKFLOW_ROOT, id);
    const meta = readMeta(dir);
    const docs = DOC_FILES.filter((f) => existsSync(join(dir, f)));
    // archived は明示的な意思表示なので orphan / empty より優先して拾う
    if (meta.archived) {
      const plan = readMaybe(join(dir, "plan.md"));
      const research = readMaybe(join(dir, "research.md"));
      result.archived.push({
        id,
        title: deriveTitle(id, plan, research, meta.title),
        cwd: meta.cwd,
      });
      continue;
    }
    if (meta.cwd && !existsSync(meta.cwd)) {
      const plan = readMaybe(join(dir, "plan.md"));
      const research = readMaybe(join(dir, "research.md"));
      result.orphan.push({
        id,
        title: deriveTitle(id, plan, research, meta.title),
        cwd: meta.cwd,
      });
      continue;
    }
    if (!existsSync(join(dir, "meta.json")) && docs.length === 0) {
      result.empty.push({ id, title: id, cwd: null });
    }
  }
  return result;
}

// 単一 id を実削除する前のガード。失敗理由を文字列で返す（null なら OK）。
function validateCleanTarget(id: string, candidateIds: Set<string>): string | null {
  if (!id || id.includes("/") || id.includes("..") || id.includes("\0")) {
    return "invalid id";
  }
  if (!candidateIds.has(id)) return "not in candidates";
  const dir = join(WORKFLOW_ROOT, id);
  if (!existsSync(dir)) return "missing";
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return "realpath failed";
  }
  if (real !== join(WORKFLOW_ROOT_REAL, id) && !real.startsWith(WORKFLOW_ROOT_REAL + "/")) {
    return "outside workflow root";
  }
  return null;
}

function renderBoard(filter: string): string {
  const tasks = scanTasks();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const filtered = tasks.filter((t) => matchesFilter(t, filter));
  const cols = COLUMNS.map(({ phase, label }) => {
    const inCol = filtered.filter((t) => t.phase === phase);
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
  return page(
    "Workflow Dashboard",
    `${renderFilterBar(tasks, filter)}<div class="board">${cols}</div>`,
    { withCleanDrawer: true, withLayoutToggle: true },
  );
}

// 詳細ページ右上の archive トグル。挙動は task-detail.js が引き受ける。
// data-archived は現在状態。クリック時はクライアントが反転させて API を叩く。
function renderArchiveToggle(id: string, archived: boolean): string {
  const label = archived ? "アーカイブ解除" : "アーカイブ";
  return `<button type="button" class="archive-toggle" data-archive-toggle data-id="${esc(id)}" data-archived="${archived ? "true" : "false"}" aria-pressed="${archived ? "true" : "false"}" title="${archived ? "ボードに戻す" : "ボードから片付ける"}"><span class="archive-toggle__icon" aria-hidden="true">${archived ? "↩" : "📥"}</span><span class="archive-toggle__label">${label}</span></button>`;
}

function renderTask(id: string): string | null {
  // パストラバーサル対策: タスク id はディレクトリ名のみ許可
  if (id.includes("/") || id.includes("..")) return null;
  const dir = join(WORKFLOW_ROOT, id);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const meta = readMeta(dir);
  const docs = DOC_FILES.filter((f) => existsSync(join(dir, f)));
  if (docs.length === 0) {
    // 早期 return パスは TASK_DETAIL_JS を注入しないので archive トグルも出さない
    // （ハンドラが付かず無反応ボタンになるため）。実 archived タスクは research.md
    // を残すので通常 docs>=1 のパスを通る。
    return page(
      id,
      `<div class="detail"><a class="back" href="/">&larr; Board</a><h1>${esc(id)}</h1><p class="empty">md ドキュメントなし</p></div>`,
    );
  }
  const toggle = renderArchiveToggle(id, meta.archived);
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
      <div class="detail__head">
        <a class="back" href="/">&larr; Board</a>
        ${toggle}
      </div>
      <h1>${esc(id)}</h1>
      <div class="tabs">${tabs}</div>
      <div class="panels markdown">${panels}</div>
    </div>
    <script type="module">${TASK_DETAIL_JS}</script>`,
  );
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function startServer() {
  return Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/") {
      const filter = url.searchParams.get("cwd") ?? "";
      return html(renderBoard(filter));
    }
    if (path === "/api/clean/candidates" && req.method === "GET") {
      return jsonResponse(scanCleanCandidates());
    }
    if (path === "/api/clean/delete" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "invalid json" }, 400);
      }
      const ids = (body as { ids?: unknown })?.ids;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
        return jsonResponse({ error: "ids must be string[]" }, 400);
      }
      // 不正形式（パストラバーサル等）が混ざっていたら全体を 400 で拒否する
      for (const id of ids as string[]) {
        if (!id || id.includes("/") || id.includes("..") || id.includes("\0")) {
          return jsonResponse({ error: "invalid id", id }, 400);
        }
      }
      const candidates = scanCleanCandidates();
      const candidateIds = new Set<string>([
        ...candidates.done.map((c) => c.id),
        ...candidates.archived.map((c) => c.id),
        ...candidates.orphan.map((c) => c.id),
        ...candidates.empty.map((c) => c.id),
      ]);
      const deleted: string[] = [];
      const skipped: { id: string; reason: string }[] = [];
      const failed: { id: string; reason: string }[] = [];
      for (const id of ids as string[]) {
        const reason = validateCleanTarget(id, candidateIds);
        if (reason) {
          skipped.push({ id, reason });
          continue;
        }
        try {
          rmSync(join(WORKFLOW_ROOT, id), { recursive: true, force: true });
          deleted.push(id);
        } catch (e) {
          failed.push({ id, reason: e instanceof Error ? e.message : String(e) });
        }
      }
      return jsonResponse({ deleted, skipped, failed });
    }
    // archive トグル: meta.json の archived フラグを更新する。
    // 任意のタスクが対象（candidate チェックなし）。id はパストラバーサル拒否 +
    // realpath が WORKFLOW_ROOT 配下であることだけ確認する。
    if (path === "/api/archive" && req.method === "POST") {
      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ error: "invalid json" }, 400);
      }
      const id = (body as { id?: unknown })?.id;
      const archived = (body as { archived?: unknown })?.archived;
      if (typeof id !== "string" || !id || id.includes("/") || id.includes("..") || id.includes("\0")) {
        return jsonResponse({ error: "invalid id" }, 400);
      }
      if (typeof archived !== "boolean") {
        return jsonResponse({ error: "archived must be boolean" }, 400);
      }
      const dir = join(WORKFLOW_ROOT, id);
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        return jsonResponse({ error: "task not found" }, 404);
      }
      let real: string;
      try {
        real = realpathSync(dir);
      } catch {
        return jsonResponse({ error: "realpath failed" }, 500);
      }
      if (real !== join(WORKFLOW_ROOT_REAL, id) && !real.startsWith(WORKFLOW_ROOT_REAL + "/")) {
        return jsonResponse({ error: "outside workflow root" }, 400);
      }
      if (!persistArchived(id, archived)) {
        return jsonResponse({ error: "write failed" }, 500);
      }
      return jsonResponse({ id, archived });
    }
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
}

// 直接起動時のみ listen する（test から import したときはサーバを立てない）
if (import.meta.main) {
  const server = startServer();
  console.log(`workflow-dashboard → http://localhost:${server.port}`);
}
