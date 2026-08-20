---
name: bug-fix
description: Run the bug fix workflow: reproduce, find the root cause, add a regression test, make the smallest safe fix, and verify.
argument-hint: [defect to fix]
disable-model-invocation: true
---

# /bug-fix

Fix the defect described below, following this project's bug fix workflow.

Defect to fix: $ARGUMENTS

Read `.claude/workflows/bug-fix.md` now and follow its steps in order. That file is the
authoritative definition of this workflow and this one only starts it, so do not work from
a remembered version of the steps. Read the standards it names before making changes, and
consult a specialist skill from `.claude/skills/` only where it materially improves the work.

If nothing was described above, ask what to work on before starting.
