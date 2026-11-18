import { posix } from 'node:path';
import { type FileCtx, matchLines, type RuleHit } from '../walk.ts';

const MCP_FILES = new Set(['.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.gemini/settings.json']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'uvx']);
const DANGEROUS_FLAGS = /--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|--yolo\b/;
const AUTO_RUN_KEYS = /"(initializeCommand|onCreateCommand|updateContentCommand|postCreateCommand|postStartCommand|postAttachCommand)"\s*:/;

/** コメント（`//` と `/* *\/`）と末尾カンマを落として JSON として読む（JSONC 向け）。読めなければ undefined */
function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, str: string | undefined) => str ?? '')
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

function lineOf(text: string, needle: string): number {
  const idx = text.indexOf(needle);
  return idx < 0 ? 1 : text.slice(0, idx).split('\n').length;
}

/** `npx -y pkg` などで実行するパッケージ名を取り出す。バージョンが付いていれば undefined */
function unpinnedPackage(runner: string, args: string[]): string | undefined {
  const from = args.indexOf('--from');
  const pkg = runner === 'uvx' && from >= 0 ? args[from + 1] : args.find((a) => !a.startsWith('-'));
  if (pkg === undefined) return undefined;
  if (runner === 'uvx') return /==|@/.test(pkg) ? undefined : pkg;
  return /^(@[^/]+\/)?[^@]+@.+/.test(pkg) ? undefined : pkg;
}

function mcpServers(ctx: FileCtx): RuleHit[] {
  const json = parseJsonc(ctx.text) as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> } | undefined;
  const servers = { ...json?.mcpServers, ...json?.servers };
  return Object.entries(servers).flatMap(([name, value]) => {
    const server = value as { command?: unknown; args?: unknown };
    if (typeof server.command !== 'string') return [];
    const [cmd, ...inline] = server.command.split(/\s+/);
    const runner = posix.basename(cmd);
    if (!RUNNERS.has(runner)) return [];
    const args = [...inline, ...(Array.isArray(server.args) ? server.args.filter((a): a is string => typeof a === 'string') : [])];
    const pkg = unpinnedPackage(runner, args);
    if (pkg === undefined) return [];
    return [{ rule: 'agent/unpinned-mcp', kind: 'symptom' as const, line: lineOf(ctx.text, `"${name}"`), message: `MCP サーバ ${name} が ${runner} ${pkg} をバージョン無しで実行する。起動のたびに最新版が入る` }];
  });
}

function claudeSettings(ctx: FileCtx): RuleHit[] {
  const json = parseJsonc(ctx.text) as { permissions?: { allow?: unknown; defaultMode?: unknown } } | undefined;
  const hits: RuleHit[] = [];
  if (json?.permissions?.defaultMode === 'bypassPermissions') {
    hits.push({ rule: 'agent/broad-permission', kind: 'symptom', line: lineOf(ctx.text, 'bypassPermissions'), message: '既定で permission の確認を飛ばす' });
  }
  const allow = Array.isArray(json?.permissions?.allow) ? json.permissions.allow : [];
  for (const entry of allow) {
    if (entry === 'Bash' || entry === 'Bash(*)' || entry === 'Bash(:*)') {
      hits.push({ rule: 'agent/broad-permission', kind: 'symptom', line: lineOf(ctx.text, `"${entry}"`), message: `${entry} を allow に入れている。任意のコマンドが確認なしで走る` });
    }
  }
  return hits;
}

function codexConfig(ctx: FileCtx): RuleHit[] {
  return [
    ...matchLines(ctx.text, /^\s*approval_policy\s*=\s*"never"/),
    ...matchLines(ctx.text, /^\s*sandbox_mode\s*=\s*"danger-full-access"/),
  ].map(({ line }) => ({ rule: 'agent/broad-permission', kind: 'symptom' as const, line, message: '確認なし、または sandbox なしで動かす設定' }));
}

function autoRun(ctx: FileCtx): RuleHit[] {
  const base = posix.basename(ctx.rel);
  if (ctx.rel.endsWith('.vscode/tasks.json')) {
    return matchLines(ctx.text, /"folderOpen"/).map(({ line }) => ({ rule: 'open-on-run/auto-run', kind: 'candidate' as const, line, message: 'フォルダを開くと走るタスク。中身を確かめる' }));
  }
  if (base === 'devcontainer.json' || base === '.devcontainer.json') {
    return matchLines(ctx.text, AUTO_RUN_KEYS).map(({ line, match }) => ({ rule: 'open-on-run/auto-run', kind: 'candidate' as const, line, message: `${match[1]} はコンテナの作成・起動時に走る。中身を確かめる` }));
  }
  return [];
}

export function checkAgentConfig(ctx: FileCtx): RuleHit[] {
  const base = posix.basename(ctx.rel);
  const hits: RuleHit[] = [];
  if (MCP_FILES.has(ctx.rel) || base === '.mcp.json' || (base.endsWith('.json') && ctx.text.includes('"mcpServers"'))) {
    hits.push(...mcpServers(ctx));
  }
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(ctx.rel)) hits.push(...claudeSettings(ctx));
  if (/(^|\/)\.codex\/config\.toml$/.test(ctx.rel)) hits.push(...codexConfig(ctx));
  if (/\.(ya?ml|json|sh|bash|zsh|toml)$/.test(base) || base === 'Makefile') {
    for (const { line } of matchLines(ctx.text, DANGEROUS_FLAGS)) {
      hits.push({ rule: 'agent/broad-permission', kind: 'symptom', line, message: 'AI エージェントを確認なしで動かすフラグ' });
    }
  }
  hits.push(...autoRun(ctx));
  return hits;
}

export type InventoryKind = 'agent-instructions' | 'agent-config' | 'skill' | 'mcp' | 'git-hook' | 'devcontainer' | 'editor' | 'scanner-config';

/**
 * 変更したらレビューが要るファイルの種類を返す。対象でなければ undefined。
 * skill はディレクトリ単位にまとめるため、`path` に skill のディレクトリを返す
 */
export function inventoryOf(rel: string): { kind: InventoryKind; path: string } | undefined {
  const base = posix.basename(rel);
  const skill = rel.match(/^(.*?\/?\.(?:claude|agents|codex|cursor|github)\/skills\/[^/]+)\//);
  if (skill) return { kind: 'skill', path: `${skill[1]}/` };
  if (/^(CLAUDE|AGENTS|GEMINI|CLAUDE\.local)\.md$/.test(base) || base === '.cursorrules' || base === '.windsurfrules') {
    return { kind: 'agent-instructions', path: rel };
  }
  if (/(^|\/)\.github\/(copilot-instructions\.md|instructions\/)/.test(rel) || /(^|\/)\.cursor\/rules\//.test(rel)) {
    return { kind: 'agent-instructions', path: rel };
  }
  if (base === '.mcp.json' || MCP_FILES.has(rel)) return { kind: 'mcp', path: rel };
  if (/(^|\/)\.(claude|codex|gemini)\//.test(rel)) return { kind: 'agent-config', path: rel };
  if (/(^|\/)\.(githooks|husky)\//.test(rel) || /^\.?lefthook(-local)?\.ya?ml$/.test(base) || base === '.pre-commit-config.yaml') {
    return { kind: 'git-hook', path: rel };
  }
  if (base === '.devcontainer.json' || /(^|\/)\.devcontainer\//.test(rel)) return { kind: 'devcontainer', path: rel };
  if (/(^|\/)\.vscode\/(tasks|settings|extensions)\.json$/.test(rel)) return { kind: 'editor', path: rel };
  if (base === '.gitleaks.toml' || base === '.gitleaksignore' || /^\.?zizmor\.ya?ml$/.test(base)) return { kind: 'scanner-config', path: rel };
  return undefined;
}
