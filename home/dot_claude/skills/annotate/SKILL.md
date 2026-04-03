---
description: "Process user annotations in .plan/plan.md and update the plan accordingly. No code implementation."
accepts_args: false
allowed-tools: Read, Write, Bash(code *)
---

# /annotate - Process Plan Annotations

You are processing the user's annotations on the implementation plan. You will **update the plan document only** — you must NOT write any implementation code.

## CRITICAL GUARDRAIL

**DO NOT implement any code.** Your only job is to read annotations, understand them, and update `.plan/plan.md` to reflect the user's feedback. Even if an annotation says "implement this differently", you only update the PLAN to describe the different approach.

## Prerequisites Check

1. Check if `.plan/plan.md` exists
2. If it does NOT exist:
   - Output: "No plan found. Run `/plan <requirements>` first."
   - **Stop here.**

## Annotation Detection

Read `.plan/plan.md` and detect the following annotation formats:

### HTML Comments
```markdown
<!-- NOTE: This should use a different approach because... -->
<!-- REJECT: Remove this section entirely -->
<!-- ADD: We also need to handle the case where... -->
<!-- QUESTION: What about edge case X? -->
```

### Blockquote Annotations
```markdown
> [NOTE] This approach won't work because of X
> [REJECT] Don't do this
> [ADD] Also consider Y
```

### Direct Edits
The user may have directly modified text, added sections, or deleted content. Compare the current structure against the expected plan format to identify changes.

## Processing

For each annotation found:

1. **Interpret the intent**: What does the user want changed?
2. **Update the plan**: Modify the relevant section to address the feedback
3. **Mark as addressed**: Remove the annotation markup (the content it influenced remains)
4. **Track changes**: Keep a mental list of all changes made

## After Processing

1. Write the updated `.plan/plan.md`
2. Open in VSCode: `code .plan/plan.md`
3. Output a **change summary**:
   ```
   ## Annotations Processed

   1. [Section X]: [what was changed and why]
   2. [Section Y]: [what was changed and why]
   ...

   Total annotations processed: N
   ```
4. Instruction: **"Review the updated plan. If more changes are needed, add annotations and run `/annotate` again. When satisfied, run `/implement` to begin implementation."**
