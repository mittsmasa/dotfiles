---
name: difit
description: Git diff viewer with GitHub-like interface. Use when the user wants to view Git diffs, review changes (working/staged/committed), compare branches, or review pull requests. Triggered by commands like "/difit", "show me the diff", "review my changes", "compare branches", or "check PR changes".
accepts_args: true
---

# Difit - Git Diff Viewer

## Overview

Difit is a lightweight Git diff viewer that displays changes in a browser with a GitHub-like interface. It provides an easy way to review working directory changes, staged changes, commit history, and branch comparisons.

**Note**: This skill documentation is based on difit v5.0.2. The CLI dropped the `git diff | difit` pipe interface and the `--mode`/`--tui` flags used in v3.x. Everything is now expressed as positional Git revision arguments (`difit <commit-ish> [compare-with]`), always rendered inline in the browser.

## Usage

```
difit [options] [command] [commit-ish] [compare-with]
```

- `commit-ish` (default: `HEAD`): a Git commit, tag, branch, `HEAD~n` reference, or the literal `working` / `staged` / `.`
- `compare-with` (optional): compare `commit-ish` against this commit/branch instead of its default base

Special `commit-ish` values:
- `working` — unstaged changes (working tree vs index). **Cannot** be combined with `compare-with` — a bare `working <other>` errors with `"working" shows unstaged changes and cannot be compared with another commit. Use "." instead.`
- `staged` — staged changes (index vs HEAD)
- `.` — all uncommitted changes (working tree vs HEAD). This is the one to use when you want "everything I haven't committed yet" compared against a specific base (e.g. `difit . develop`)

## Arguments

- **No argument**: `difit` → same as `difit HEAD`, shows the last commit's changes
- `head`: `difit HEAD` → last commit's changes (not "all uncommitted", despite the v3 naming)
- `working` or `unstaged`: `difit working` → unstaged changes only
- `staged`: `difit staged` → staged changes only
- `.`: `difit .` → all uncommitted changes (working + staged) vs HEAD; pair with a second arg to diff against another base, e.g. `difit . develop`
- `pr` or `pr <number>` or `pr <url>`: Show pull request changes (resolved to `--pr <url>`)
  - `pr` alone: current branch's PR via `gh pr view --json url -q .url`
  - `pr <number>`: resolved via `gh pr view <number> --json url -q .url`
  - `pr <url>`: used directly

Examples:
- `/difit` → `difit HEAD`
- `/difit head` → `difit HEAD`
- `/difit working` → `difit working`
- `/difit staged` → `difit staged`
- `/difit head vs develop` or "compare my uncommitted changes with develop" → `difit . develop`
- `/difit pr` → resolves current branch's PR and runs `difit --pr <url>`
- `/difit pr 123` → `difit --pr <url for #123>`
- `/difit pr https://github.com/owner/repo/pull/123` → `difit --pr https://github.com/owner/repo/pull/123`

## Usage Workflow

1. **Verify Git repository**: Confirm the current directory is a Git repository
2. **Parse arguments**: Determine which revision(s) to pass as positional args
3. **Execute difit command**: Run `difit [commit-ish] [compare-with]` directly — no piping
4. **Inform user**: A browser opens automatically unless `--no-open` is passed

## Common Use Cases

### Review Working Directory Changes

```bash
# Unstaged changes only
difit working

# All uncommitted changes (working + staged) vs HEAD
difit .

# Staged changes only
difit staged

# All uncommitted changes vs a specific branch (e.g. before opening a PR)
difit . develop
```

### Review Commits

```bash
# Last commit
difit HEAD

# A specific commit back
difit HEAD~3

# A specific commit hash
difit abc1234
```

### Compare Branches

```bash
# Current branch vs main
difit HEAD main

# Two arbitrary branches
difit main develop

# Resolve the merge-base first (like `git diff main...develop`)
difit main develop --merge-base
```

### Review Pull Requests

```bash
difit --pr https://github.com/owner/repo/pull/123
```

### Untracked files

```bash
# Include untracked files in the diff automatically
difit . --include-untracked
```

No more manual `git diff --no-index /dev/null <file>` patching needed for untracked files — `--include-untracked` handles it.

### Background / headless usage

```bash
# Keep the server running in the background and print JSON info ({"port":...,"url":...,"pid":...})
difit . develop --background

# Don't auto-open a browser (useful in headless/remote environments)
difit . --no-open
```

`--background` is the way to get a URL without blocking the shell (previously done by piping with `--no-open` in v3). Combine with `--no-open` if you also don't want the local browser launch attempt.

### Server-side comments (new in v5, no v3 equivalent)

```bash
# Inject initial review comments when starting the viewer
difit . --comment '{"file":"src/foo.ts","line":10,"body":"needs a null check"}'

# Add a comment to an already-running difit server
difit comment add '{"file":"src/foo.ts","line":10,"body":"needs a null check"}'

# Retrieve comments from a running server
difit comment get
```

## Available Options

- `--port <port>`: preferred port (auto-assigned if occupied)
- `--host <host>`: host address to bind (default: all interfaces)
- `--no-open`: do not automatically open browser
- `--comment <json>`: inject initial review comments (repeatable)
- `--pr <url>`: review a GitHub PR
- `--clean`: start with a clean slate, clearing all existing comments
- `--include-untracked`: automatically include untracked files in the diff
- `--keep-alive`: keep server running even after the browser disconnects
- `--background`: keep the server running in the background and print JSON info (`port`, `url`, `pid`) to stdout
- `--context <lines>`: number of context lines shown around each change
- `--merge-base`: resolve the base revision via `git merge-base` before diffing (Git revision mode only)

Removed since v3: `--mode` (side-by-side/inline toggle — the viewer is inline-only now) and `--tui` (no terminal UI mode anymore).

## Default Behavior

- **Display mode**: Browser-only, GitHub-like inline view (no side-by-side or TUI mode in v5)
- **Browser launch**: Automatically opens browser unless `--no-open` is specified
- **Installation path**: this environment has difit installed via mise (`mise install npm-difit`); check with `which difit` before assuming a global pnpm install

## Error Handling

If difit is not available or the command fails:

1. Check if the current directory is a Git repository
2. Verify difit is installed: `which difit` (this environment: mise-managed) or `pnpm list -g difit`
3. If not installed and mise is in use, install via mise config; otherwise `pnpm add -g difit`
4. If a command like `difit working develop` errors, remember `working` can't take a `compare-with` arg — swap in `.` instead

## Argument Handling Logic

When processing arguments:

1. **Determine revision args**: map the requested scope to `commit-ish [compare-with]`:
   - No arguments / `head`: `HEAD` (no compare-with)
   - `working` / `unstaged`: `working` (no compare-with — errors if one is given)
   - `staged`: `staged`
   - `.` (or "all uncommitted changes"): `.`, optionally with a second branch/commit arg
   - Two explicit revisions ("compare X and Y"): pass both positionally
   - `pr [...]`: resolve to a URL and use `--pr <url>` instead of positional args
2. **Build command**: `difit [commit-ish] [compare-with] [options]` — no shell piping
3. **Untracked files**: add `--include-untracked` if the user wants them folded in
4. **Background/headless**: add `--background` and/or `--no-open` as needed, then read the printed JSON for the URL

## PR Handling

When `pr` argument is provided:

1. **Parse PR argument**:
   - `pr` alone: `gh pr view --json url -q .url`
   - `pr <number>`: `gh pr view <number> --json url -q .url`
   - `pr <url>`: use directly

2. **Execute difit with PR**:
   - `difit --pr <url>`
   - PR mode fetches the diff from GitHub; no positional revision args are used

3. **Error handling**:
   - If `gh` CLI is not available, inform user to install it
   - If no PR exists for current branch, show appropriate error message

## Examples

User request: "/difit" or "Show me what I changed" (last commit)
```bash
difit HEAD
```

User request: "/difit working" or "/difit unstaged"
```bash
difit working
```

User request: "/difit staged" or "Review my staged changes"
```bash
difit staged
```

User request: "/difit ." or "Show me all my uncommitted changes"
```bash
difit .
```

User request: "Show me my uncommitted changes against develop"
```bash
difit . develop
```

User request: "Show me the last commit"
```bash
difit HEAD
```

User request: "Show me 3 commits back"
```bash
difit HEAD~3
```

User request: "Compare main and develop branches"
```bash
difit main develop
```

User request: "/difit pr" or "Review this PR"
```bash
gh pr view --json url -q .url | xargs -I {} difit --pr {}
```

User request: "/difit pr 123"
```bash
gh pr view 123 --json url -q .url | xargs -I {} difit --pr {}
```

User request: "/difit pr https://github.com/owner/repo/pull/123"
```bash
difit --pr https://github.com/owner/repo/pull/123
```

User request: "I need the diff URL without opening a browser, keep it running"
```bash
difit . develop --background --no-open
# prints {"port":...,"url":"http://localhost:...","pid":...}
```
