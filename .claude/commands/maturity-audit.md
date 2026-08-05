---
description: Audit this repo against the world-class baseline, then apply the enforcement layer. Pass "audit" for a read-only scorecard.
argument-hint: [audit]
---
PHASE 1 (read-only): discover stack, branches, tenant model, existing CI/secrets/hooks/RLS-tests/observability; score AXIS A (agents/skills/hooks/CLAUDE.md) and AXIS B (CI verify · strict secret scan · DB+RLS proof · deploy gate · dependabot · CODEOWNERS/SECURITY.md · env validation · observability); list gaps P0/P1/P2. If $ARGUMENTS is "audit", stop. PHASE 2 (on confirm): detect-then-extend, never clobber; apply P0 first (verify gate, gitleaks CI+pre-commit, DB/RLS CI job, deploy-time gate), then P1. Validate every file; never weaken a control to pass; post Before/After; ship via ship-check.
