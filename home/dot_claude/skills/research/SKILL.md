---
description: "Deeply research a codebase area before planning. Outputs .plan/research.md with exhaustive findings."
accepts_args: true
allowed-tools: Read, Glob, Grep, Bash(git log *, git show *, git blame *, ls *, tree *, wc *, file *), Write, Task
---

# /research - Codebase Deep Research

You are performing an **exhaustive, deep research** phase. The goal is to understand the target area of the codebase **thoroughly** — not a quick skim, but a detailed investigation of every intricacy.

## Setup

1. Create `.plan/` directory if it doesn't exist
2. Create `.plan/.gitignore` with the following content if it doesn't exist:
   ```
   *
   !.gitignore
   ```

## Input Parsing

The argument `$ARGUMENTS` can be:
- **A file/directory path**: Research that specific area of the codebase
- **A topic/feature name**: Find and research the relevant code areas
- **A combination**: e.g., `packages/frontend authentication flow`

## Research Process

Investigate the target **deeply, exhaustively, with attention to intricacies**:

1. **Directory structure & file roles**: Map every file, understand its purpose
2. **Read code thoroughly**: Do NOT skim. Read functions, types, interfaces in detail
3. **Dependency analysis**: Imports, exports, cross-module relationships
4. **Patterns & conventions**: Naming, file organization, error handling, testing patterns
5. **Git history**: Recent changes, who changed what, why (commit messages)
6. **Edge cases & gotchas**: Potential pitfalls, known issues, non-obvious behavior
7. **Related code**: Find similar implementations elsewhere that could serve as reference

## Output

Write findings to `.plan/research.md` with this structure:

```markdown
# Research: [Target Description]

_Generated: [date]_
_Target: [path or topic]_

## Executive Summary

[3-5 sentences capturing the essential understanding. What is this code doing, why, and what's notable about it.]

## Directory & File Structure

[Tree format with 1-line comments for each file/directory]

## Key Components

### [Component/Module Name]
- **Path**: `[absolute path]`
- **Role**: [what it does]
- **Key types/interfaces**:
  ```typescript
  [relevant type definitions, abbreviated if very long]
  ```
- **Dependencies**: [what it imports/uses]
- **Intricacies**: [non-obvious behavior, edge cases, gotchas]

[Repeat for each significant component]

## Data Flow

[How data moves through the system. Entry points → transformations → outputs]

## Existing Patterns & Conventions

- [Pattern 1]: [description + example file]
- [Pattern 2]: [description + example file]
- ...

## Reference Implementations

[If a new feature is to be built, list existing similar implementations that should be used as templates]

- **[Feature name]** at `[path]`: [why it's a good reference]

## Constraints & Gotchas

- [Constraint 1]: [explanation]
- [Constraint 2]: [explanation]

## Open Questions

- [ ] [Question that couldn't be resolved through code reading alone]
```

## Completion

After writing `.plan/research.md`, report:
- Summary of what was researched
- Key findings (3-5 bullet points)
- Any open questions that need human input
- Instruction: **"Next step: run `/plan <implementation requirements>` to create an implementation plan based on this research."**
