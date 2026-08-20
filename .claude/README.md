# .claude — knowledge layer

## This project's own (domain-specific; these win over anything below)
agents/   security-auditor · migration-author · code-reviewer
skills/   tenant-audit · migrations-check · ship-check · rls-test · session-memory · multi-tenant-feature · ai-cost-audit
commands/ /ship · /checkpoint · /maturity-audit
hooks/    session-start.sh   ·   settings.json (memory injection + CLAUDE.md drift warning)

## From the enterprise framework (v1.5.0 — see FRAMEWORK.md for why this subset)
skills/     accessibility-reviewer · ux-reviewer · frontend-architect · performance-engineer ·
            qa-engineer · devops-engineer · business-analyst · principal-architect
agents/     principal-architect
commands/   /bug-fix · /incident-response · /dependency-upgrade · /refactoring
            (each reads its definition from workflows/; nothing loads until invoked)
standards/  review · ux · coding · performance · database · testing · operations · security ·
            architecture — read on demand, not auto-loaded
templates/  ADR.md

**Precedence: the root `CLAUDE.md` beats `standards/`.** Where they disagree, follow the
project and say so explicitly rather than applying the standard silently.

`FRAMEWORK.md` records what was adopted, what was skipped and what supersedes it, and how to
sync a newer framework version. Run `/maturity-audit` to check coverage.
