---
description: "Create a detailed implementation plan based on research. Outputs .plan/plan.md and opens it in VSCode for review."
accepts_args: true
allowed-tools: Read, Glob, Grep, Write, Bash(code *, ls *, tree *, git log *, git show *, wc *)
---

# /plan - Implementation Planning

You are creating a **detailed, actionable implementation plan** based on prior research. This plan will be reviewed and annotated by the user before any code is written.

## Prerequisites Check

1. Check if `.plan/research.md` exists
2. If it does NOT exist:
   - Output: "No research found. Run `/research <target>` first to build context."
   - **Stop here. Do not proceed.**
3. If it exists, read it thoroughly

## Planning Process

1. **Read `.plan/research.md`** completely — understand every section
2. **Investigate further** if the research doesn't cover areas relevant to the implementation requirements (`$ARGUMENTS`)
3. **Design the implementation** considering:
   - Architecture decisions and trade-offs
   - Consistency with existing patterns found in research
   - Minimal blast radius (smallest change that achieves the goal)
   - Type safety and correctness

## Output

Write the plan to `.plan/plan.md` with this structure:

```markdown
# Implementation Plan: [Feature/Change Description]

_Generated: [date]_
_Based on: .plan/research.md_
_Requirements: [user's requirements from arguments]_

## Overview

[2-3 sentences describing what will be implemented and the high-level approach]

## Prerequisites & Constraints

- [Constraint from research]
- [Dependency that must be satisfied]
- [Pattern that must be followed]

## Architecture Decisions

### Decision: [Decision Title]
- **Chosen approach**: [description]
- **Rationale**: [why this approach]
- **Rejected alternatives**:
  - [Alternative 1]: [why rejected]
  - [Alternative 2]: [why rejected]

[Repeat for each significant decision]

## Files to Modify

| File | Action | Description |
|------|--------|-------------|
| `[absolute path]` | Create/Modify/Delete | [what changes] |

## Implementation Steps

### Phase 1: [Phase Name]

#### Task 1.1: [Task Description]
**File**: `[absolute path]`

[Explanation of what to do and why]

```typescript
// Code snippet showing the implementation
// Based on patterns from [reference file]
```

- [ ] Implement [specific action]
- [ ] Verify type-check passes

#### Task 1.2: [Task Description]
...

### Phase 2: [Phase Name]
...

## Test Plan

- [ ] [Test 1]: [what to test and how]
- [ ] [Test 2]: [what to test and how]

## Type Check & Validation

```bash
[exact command to run type checking]
```

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| [Risk] | [Impact] | [How to mitigate] |
```

## Quality Standards

- **Every file reference must use absolute paths** from the repository root
- **Code snippets must match existing patterns** found in research
- **Trade-offs must be explicitly discussed** — don't hide complexity
- **Tasks must be granular enough** to mark individually as complete
- **Each task should include concrete code** showing what to write

## Completion

1. Open the plan in VSCode: `code .plan/plan.md`
2. Report:
   - Summary of the plan (phases and key decisions)
   - Number of files to modify
   - Key risks identified
   - Instruction: **"Review the plan in VSCode. Add annotations using `<!-- NOTE: ... -->`, `<!-- REJECT: ... -->`, or `<!-- ADD: ... -->` comments, then run `/annotate` to apply your feedback."**
