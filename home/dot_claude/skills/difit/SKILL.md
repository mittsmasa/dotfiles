---
name: difit
description: Git diff viewer with GitHub-like interface. Use when the user wants to view Git diffs, review changes (working/staged/committed), compare branches, or review pull requests. Triggered by commands like "/difit", "show me the diff", "review my changes", "compare branches", or "check PR changes".
accepts_args: true
---

# Difit - Git Diff Viewer

## Overview

Difit is a lightweight Git diff viewer that displays changes in a browser or terminal with a GitHub-like interface. It provides an easy way to review working directory changes, staged changes, commit history, and branch comparisons.

**Note**: This skill documentation is based on difit v3.0.1. Newer versions (v3.1.2+) support direct arguments like `difit working`, `difit staged`, and `difit .` for simplified usage. For the current version, pipe git diff output to difit.

## Arguments

The skill accepts the following arguments to specify what changes to view:

- **No argument**: Show untracked files and unstaged changes with `git diff`
- `head`: Show all uncommitted changes (working + staged) with `git diff HEAD`
- `working` or `unstaged`: Show only unstaged changes with `git diff` (same as no argument)
- `staged`: Show only staged changes with `git diff --staged`
- `pr` or `pr <number>` or `pr <url>`: Show pull request changes
  - `pr` alone: Show PR for current branch (uses `gh pr view`)
  - `pr <number>`: Show specific PR by number
  - `pr <url>`: Show PR from GitHub URL
- `--tui`: Add this flag to any command to view in terminal UI mode

Examples:
- `/difit` → Shows untracked files and unstaged changes
- `/difit head` → Shows all uncommitted changes (working + staged)
- `/difit working` → Shows only unstaged changes
- `/difit staged` → Shows only staged changes
- `/difit pr` → Shows PR for current branch
- `/difit pr 123` → Shows PR #123
- `/difit pr https://github.com/owner/repo/pull/123` → Shows PR from URL
- `/difit --tui` → Shows unstaged changes in terminal UI

## Usage Workflow

When the user requests to view diffs or review changes, follow these steps:

1. **Verify Git repository**: Confirm the current directory is a Git repository
2. **Parse arguments**: Determine which type of diff to show based on the provided arguments
3. **Execute difit command**: Pipe the appropriate git diff output to difit
4. **Inform user**: Let them know a browser will open with the diff (unless `--tui` or `--no-open` is specified)

## Common Use Cases

### Review Working Directory Changes

```bash
# Show untracked files and unstaged changes (default)
git diff | difit --mode inline

# Show all uncommitted changes (working + staged)
git diff HEAD | difit --mode inline

# Show only staged changes
git diff --staged | difit --mode inline
```

### Review Commits

```bash
# Show HEAD commit changes
git show HEAD | difit --mode inline

# Show specific commit
git show HEAD~3 | difit --mode inline

# Show changes from specific commit hash
git show abc1234 | difit --mode inline
```

### Compare Branches

```bash
# Compare current branch with main
git diff main | difit --mode inline

# Compare two branches
git diff main..develop | difit --mode inline
```

### Terminal UI Mode

For viewing diffs in the terminal without opening a browser:

```bash
# TUI mode for working changes
git diff | difit --mode inline --tui

# TUI mode for staged changes
git diff --staged | difit --mode inline --tui
```

### Review Pull Requests

```bash
# Review a GitHub PR
difit --pr <github-pr-url>
```

### Review Saved Patches

```bash
# Review a saved patch file
cat changes.patch | difit --mode inline
```

## Available Options

- `--mode <mode>`: Display mode (`side-by-side` or `inline`). Default: `inline`
- `--tui`: Launch in terminal UI mode instead of browser
- `--no-open`: Don't automatically open browser
- `--pr <url>`: Review GitHub PR

## Default Behavior

- **Display mode**: Always use `inline` mode (overrides the default side-by-side)
- **Browser launch**: Automatically opens browser unless `--tui` or `--no-open` is specified
- **Installation path**: `/Users/masahiro_mitsuhashi/Library/pnpm/difit`

## Error Handling

If difit is not available or the command fails:

1. Check if the current directory is a Git repository
2. Verify difit is installed: `pnpm list -g difit`
3. If not installed, suggest: `pnpm add -g difit`

## Argument Handling Logic

When processing arguments:

1. **Check for TUI flag**: Look for `--tui` in arguments
2. **Determine diff type**:
   - If no arguments: Use `git diff` (untracked files and unstaged changes only)
   - If `head`: Use `git diff HEAD` (all uncommitted changes)
   - If `working` or `unstaged`: Use `git diff` (unstaged changes only)
   - If `staged`: Use `git diff --staged` (staged changes only)
   - If `pr`: Handle pull request viewing (see PR Handling section below)
3. **Build command**: Construct the appropriate `git diff | difit --mode inline` command
4. **Add TUI flag**: If `--tui` was provided, append it to the difit command

## PR Handling

When `pr` argument is provided:

1. **Parse PR argument**:
   - `pr` alone: Get current branch's PR using `gh pr view --json url -q .url`
   - `pr <number>`: Convert to GitHub URL format
   - `pr <url>`: Use URL directly

2. **Execute difit with PR**:
   - Use `difit --pr <url> --mode inline`
   - Note: PR mode fetches the diff from GitHub, so no git diff piping is needed

3. **Error handling**:
   - If `gh` CLI is not available, inform user to install it
   - If no PR exists for current branch, show appropriate error message

## Examples

User request: "/difit" or "Show me what I changed"
```bash
git diff | difit --mode inline
```

User request: "/difit head" or "Show me all uncommitted changes"
```bash
git diff HEAD | difit --mode inline
```

User request: "/difit working" or "/difit unstaged"
```bash
git diff | difit --mode inline
```

User request: "/difit staged" or "Review my staged changes"
```bash
git diff --staged | difit --mode inline
```

User request: "/difit --tui" or "Show me the diff in terminal"
```bash
git diff | difit --mode inline --tui
```

User request: "/difit head --tui"
```bash
git diff HEAD | difit --mode inline --tui
```

User request: "Show me the last commit"
```bash
git show HEAD | difit --mode inline
```

User request: "Compare main and develop branches"
```bash
git diff main..develop | difit --mode inline
```

User request: "/difit pr" or "Review this PR"
```bash
# Get PR URL for current branch and open in difit
gh pr view --json url -q .url | xargs -I {} difit --pr {} --mode inline
```

User request: "/difit pr 123"
```bash
# Get PR URL by number and open in difit
gh pr view 123 --json url -q .url | xargs -I {} difit --pr {} --mode inline
```

User request: "/difit pr https://github.com/owner/repo/pull/123"
```bash
difit --pr https://github.com/owner/repo/pull/123 --mode inline
```
