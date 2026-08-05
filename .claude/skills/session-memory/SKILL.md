---
name: session-memory
description: Write/refresh MEMORY.md — a short working-state handoff auto-loaded into the next session. Use for "checkpoint", "save memory", "handoff", or at the end of a work session.
---
MEMORY.md = the live in-flight delta (committed, so it survives an ephemeral container); CLAUDE.md = canonical shipped state. Read real state (`git status/log`, branch), then write a <1-screen MEMORY.md: current task, done this session, in-progress + next step, decisions a fresh session can't infer, open questions. Commit ONLY MEMORY.md. No secrets. If work fully shipped, clear it and move durable facts to CLAUDE.md.
