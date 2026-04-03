---
description: "Execute the implementation plan in .plan/plan.md. Marks tasks complete as it goes. Does not stop until all tasks are done."
accepts_args: false
---

# /implement - Execute Implementation Plan

You are executing the approved implementation plan. Work through **every task** systematically, marking each as complete. **Do not stop until all tasks are finished.**

## Prerequisites Check

1. Check if `.plan/plan.md` exists
2. If it does NOT exist:
   - Output: "No plan found. Run `/plan <requirements>` first."
   - **Stop here.**
3. Read the plan thoroughly before starting

## Implementation Discipline

### Rules
- **No `any` types** — every type must be explicit and correct
- **Run type-check continuously** — after each task, verify no type errors are introduced
- **Follow existing patterns** — use the conventions identified in research
- **Do not add unnecessary comments** — code should be self-documenting
- **Do not stop until ALL tasks are complete** — push through to completion
- **Mark progress in plan.md** — update `- [ ]` to `- [x]` as tasks complete

### Type Check Command
Read the plan's "Type Check & Validation" section for the exact command. If not specified, use:
```bash
pnpm run type-check
```

## Execution Loop

For each phase and task in the plan:

1. **Read the task** from `.plan/plan.md`
2. **Implement** the code changes described
3. **Run type-check** — fix any errors before moving on
4. **Update `.plan/plan.md`**: Change `- [ ]` to `- [x]` for completed items
5. **Move to next task**

## Phase Completion

At the end of each phase:
1. Run full type-check
2. Verify all phase tasks are marked `- [x]`
3. Report phase completion briefly before proceeding to next phase

## Final Completion

After ALL tasks are done:
1. Run final type-check across the project
2. Run tests if specified in the test plan
3. Verify all `- [ ]` items in plan.md are now `- [x]`
4. Report:
   ```
   ## Implementation Complete

   - Phases completed: N/N
   - Tasks completed: M/M
   - Type-check: [PASS/FAIL]
   - Tests: [PASS/FAIL/NOT RUN]

   All tasks from .plan/plan.md have been implemented.
   ```
