---
name: incident-response
description: Run the incident response workflow: establish impact, preserve evidence, mitigate before diagnosing, confirm the cause, and verify recovery.
argument-hint: [symptom and who is affected]
disable-model-invocation: true
---

# /incident-response

Respond to the incident described below, following this project's incident response workflow.

Incident: $ARGUMENTS

Read `.claude/workflows/incident-response.md` now and follow its steps in order. That file is the
authoritative definition of this workflow and this one only starts it, so do not work from
a remembered version of the steps. Read the standards it names before making changes, and
consult a specialist skill from `.claude/skills/` only where it materially improves the work.

If nothing was described above, ask what to work on before starting.
