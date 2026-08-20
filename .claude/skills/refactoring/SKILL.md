---
name: refactoring
description: Run the refactoring workflow: establish a baseline, make small behaviour-preserving changes, and verify after each step.
argument-hint: [target to refactor]
disable-model-invocation: true
---

# /refactoring

Refactor the target described below, following this project's refactoring workflow.

Target to refactor: $ARGUMENTS

Read `.claude/workflows/refactoring.md` now and follow its steps in order. That file is the
authoritative definition of this workflow and this one only starts it, so do not work from
a remembered version of the steps. Read the standards it names before making changes, and
consult a specialist skill from `.claude/skills/` only where it materially improves the work.

If nothing was described above, ask what to work on before starting.
