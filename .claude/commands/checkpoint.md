---
description: Checkpoint the current working state.
argument-hint: [name]
---
Run `npm run verify`; if clean, commit with the checkpoint name and append `$(date +%F-%H:%M) | $ARGUMENTS | $(git rev-parse --short HEAD)` to .claude/checkpoints.log. Then refresh MEMORY.md via the session-memory skill. Report what was captured.
