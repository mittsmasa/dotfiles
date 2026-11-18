import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkAgentConfig, inventoryOf } from './agent-config.ts';

function hits(rel: string, text: string): Array<[string, number]> {
  return checkAgentConfig({ rel, text, read: () => undefined }).map((h) => [h.rule, h.line]);
}

const cases: Array<[string, string, string, Array<[string, number]>]> = [
  [
    'バージョン無しの npx で起動する MCP サーバを報告する',
    '.mcp.json',
    '{\n  "mcpServers": {\n    "docs": { "command": "npx", "args": ["-y", "@example/mcp-docs"] }\n  }\n}\n',
    [['agent/unpinned-mcp', 3]],
  ],
  ['バージョン付きの npx は報告しない', '.mcp.json', '{ "mcpServers": { "docs": { "command": "npx", "args": ["-y", "@example/mcp-docs@1.2.3"] } } }', []],
  ['uvx の == 指定は報告しない', '.mcp.json', '{ "mcpServers": { "t": { "command": "uvx", "args": ["mcp-tool==0.4.0"] } } }', []],
  ['uvx のバージョン無しを報告する', '.mcp.json', '{ "mcpServers": { "t": { "command": "uvx", "args": ["mcp-tool"] } } }', [['agent/unpinned-mcp', 1]]],
  [
    'コメント付きの .vscode/mcp.json（servers キー）も読む',
    '.vscode/mcp.json',
    '{\n  // 社内向け\n  "servers": {\n    "t": { "command": "npx", "args": ["tool"] },\n  },\n}\n',
    [['agent/unpinned-mcp', 4]],
  ],
  ['MCP 以外のコマンドは見ない', '.mcp.json', '{ "mcpServers": { "t": { "command": "node", "args": ["server.js"] } } }', []],
  [
    'Claude Code の bypassPermissions と Bash の全許可を報告する',
    '.claude/settings.json',
    '{\n  "permissions": {\n    "defaultMode": "bypassPermissions",\n    "allow": ["Bash(git status)", "Bash"]\n  }\n}\n',
    [['agent/broad-permission', 3], ['agent/broad-permission', 4]],
  ],
  ['deny の Bash は報告しない', '.claude/settings.json', '{ "permissions": { "deny": ["Bash"] } }', []],
  ['Codex の確認なし・sandbox なしを報告する', '.codex/config.toml', 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n', [['agent/broad-permission', 1], ['agent/broad-permission', 2]]],
  ['CI で確認を飛ばすフラグを報告する', '.github/workflows/ai.yml', 'steps:\n  - run: claude -p "fix" --dangerously-skip-permissions\n', [['agent/broad-permission', 2]]],
  ['フォルダを開くと走るタスクを候補にする', '.vscode/tasks.json', '{\n  "runOptions": { "runOn": "folderOpen" }\n}\n', [['open-on-run/auto-run', 2]]],
  ['devcontainer の postCreateCommand を候補にする', '.devcontainer/devcontainer.json', '{\n  "postCreateCommand": "./setup.sh"\n}\n', [['open-on-run/auto-run', 2]]],
];

describe('checkAgentConfig', () => {
  for (const [name, rel, text, expected] of cases) {
    it(name, () => assert.deepEqual(hits(rel, text), expected));
  }
});

const inventory: Array<[string, ReturnType<typeof inventoryOf>]> = [
  ['CLAUDE.md', { kind: 'agent-instructions', path: 'CLAUDE.md' }],
  ['apps/web/AGENTS.md', { kind: 'agent-instructions', path: 'apps/web/AGENTS.md' }],
  ['.claude/skills/review/SKILL.md', { kind: 'skill', path: '.claude/skills/review/' }],
  ['.claude/settings.json', { kind: 'agent-config', path: '.claude/settings.json' }],
  ['.mcp.json', { kind: 'mcp', path: '.mcp.json' }],
  ['.githooks/pre-commit', { kind: 'git-hook', path: '.githooks/pre-commit' }],
  ['lefthook.yml', { kind: 'git-hook', path: 'lefthook.yml' }],
  ['.devcontainer/devcontainer.json', { kind: 'devcontainer', path: '.devcontainer/devcontainer.json' }],
  ['.vscode/tasks.json', { kind: 'editor', path: '.vscode/tasks.json' }],
  ['.gitleaksignore', { kind: 'scanner-config', path: '.gitleaksignore' }],
  ['src/index.ts', undefined],
];

describe('inventoryOf', () => {
  for (const [rel, expected] of inventory) {
    it(`${rel} を ${expected?.kind ?? '対象外'} として扱う`, () => assert.deepEqual(inventoryOf(rel), expected));
  }
});
