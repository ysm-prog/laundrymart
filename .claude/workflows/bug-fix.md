# Bug Fix Workflow

1. Reproduce or inspect the failure.
2. Identify the actual root cause rather than only the symptom.
3. Determine affected workflows and regression risk.
4. Add or identify a regression test.
5. Make the smallest safe fix.
6. Run targeted checks, then broader checks when practical.
7. Document any operational or user-facing impact.

Do not bundle unrelated refactoring into a bug fix unless it is required for the fix.

Apply `.claude/standards/coding.md` and `.claude/standards/testing.md` throughout.
