---
name: dependency-upgrade
description: Run the dependency upgrade workflow: establish why, read the migration notes, upgrade deliberately, and verify the affected behaviour.
argument-hint: [dependency and target version]
disable-model-invocation: true
---

# /dependency-upgrade

Upgrade the dependency described below, following this project's dependency upgrade workflow.

Dependency to upgrade: $ARGUMENTS

Read `.claude/workflows/dependency-upgrade.md` now and follow its steps in order. That file is the
authoritative definition of this workflow and this one only starts it, so do not work from
a remembered version of the steps. Read the standards it names before making changes, and
consult a specialist skill from `.claude/skills/` only where it materially improves the work.

If nothing was described above, ask what to work on before starting.
