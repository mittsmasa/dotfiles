# Document Compression

Compress agents, commands, and specs to reduce tokens/costs.

**Targets**:
- **Agents**: 100-150 lines (~1,000-2,000 tokens)
- **Commands**: 50-100 lines (~500-1,000 tokens)
- **Specs**: <300 lines (~3,000-4,500 tokens)
- **Goal**: 50% reduction from original

**Key Principle**: "Will it break without this?" → If No, delete it

## Compression Techniques

### For All Documents (1-10)

1. **External Docs (90%)**: Move 50+ line explanations → `docs/reference.md` + key points
2. **Minimize Examples (87%)**: 1-2 examples only, link to `docs/examples/`
3. **Bullet Points (56%)**: "You should always..." → `- Do X (Y consequence)`
4. **Essential Checklists (73%)**: 10+ items → 3-4 critical only
5. **Compress DO/DON'T (85%)**: `✅ Do: X, Y, Z | ❌ Don't: A, B`
6. **Compact Templates (77%)**: 50-line template → 10-line essential format
7. **Remove Explanations (83%)**: Skip "how to use Context7" → `Use Context7: "WAI-ARIA pattern"`
8. **Consolidate Sections**: 8 sections (30-50 lines) → `Workflow: 1→2→3→4→5`
9. **Skip Domain Knowledge**: Don't explain ARIA/TypeScript/React basics
10. **Flatten Markdown**: h2→h3→h4→h5 → h2→h3 + bullets

### For Specs Only (11-15)

11. **Token Tables (70%)**: 20-row table → Summary stats + section link
    - Before: `| Token | Value | Panda | Confidence | Notes | (×20)`
    - After: `18 tokens: 🟢18 (100%) | See: Token Mappings`
12. **Code Examples (60%)**: 50+ lines → 10-15 essential snippet + "See: implementation"
13. **Test Lists (75%)**: 20+ scenarios → 3-5 critical + "See: Test Requirements"
14. **ARIA Docs (80%)**: Full WCAG → Key requirements + external link
15. **Stories (85%)**: All 32 variants → Pattern template only

## What to Keep

**Agents**: Workflow steps, project refs, error handling, output format
**Specs**: Overview, Figma URL, Props, token summary, implementation pattern, critical tests, ARIA essentials

## Workflow

1. Detect type: `.claude/` (agent/command) or `*.spec.md` (spec)
2. Count lines/tokens
3. Set goal: Agent 100-150 lines (~1,000-2,000 tokens) | Command 50-100 lines (~500-1,000 tokens) | Spec <300 lines (~3,000-4,500 tokens)
4. Apply techniques: Agent 1-10 | Spec 1-15
5. Externalize detailed docs (if needed)
6. Validate essentials remain
7. Create compressed version (`.compressed.md` or overwrite)
8. Report: Original lines/tokens → Compressed lines/tokens → Reduction %

## Usage

```bash
# Compress agent/command
/compress-agent-prompt .claude/agents/figma-design-analyzer.md

# Compress spec
/compress-agent-prompt src/components/value-with-unit/ValueWithUnit.spec.md
```

## Spec Output Structure

Compressed specs contain:
- **Overview** (5-10 lines): Component info, Figma URL, purpose
- **Props** (essential only): Type def with key props
- **Token Summary** (stats): `18 tokens: 🟢18 (100%)` - no full tables
- **Implementation** (10-15 lines): Essential code snippet
- **Tests** (3-5 items): Critical test checklist
- **ARIA** (key attributes): Essential attrs, no full guidelines

Good examples: `playwright-test-generator` (83 lines), `playwright-test-planner` (106 lines)
