---
name: ship-check
description: Quality gate + ship. Phase 1 runs typecheck→lint→test→build (stop on first failure). Phase 2 posts a plain-language Before/After, records a CHANGELOG entry, and opens a PR into main. Use before any commit called "done", or "ship it".
---
Phase 1: `npm run verify` (the DRY gate). Report each step; on failure stop, show the error, propose the fix. Never `as any`/`@ts-ignore` to pass; never loosen a test assertion.
Phase 2: post Before/After in plain language (translate endpoints/tables into "a button / the customer list"); add a CHANGELOG bullet; commit; push the branch; open a PR into main; wait for CI green; merge. NEVER force-push main. Confirm the deploy actually built.
