# Enterprise Claude Framework — what was adopted, and what was not

Source: `ysm-prog/enterprise-claude-framework` @ `1be73a6`, version **1.5.0** (`.claude/VERSION`).

This is a **partial adoption**, which is what the framework's own
`docs/USING-WITH-CLAUDE-CODE.md` asks for: *"take what the project lacks, not everything …
a mature project has usually thought harder about its own security, database, and domain
rules than any general framework can, while leaving accessibility, UX, and operability
thin."* Copying all 26 skills to gain the eight this repo was missing would have made the
eight harder to find, and would have put a generic entry point beside every specific one we
already have.

`.claude/VERSION` records 1.5.0 so a future sync can diff the framework's `CHANGELOG.md`
from there. It does **not** mean the whole directory came from the framework — this file is
the manifest of what did.

## Precedence

The root `CLAUDE.md` wins over anything in `.claude/standards/`. Where a standard and a
project rule disagree, follow the project and **say so explicitly** rather than applying the
standard silently. The standards are general engineering guidance; they do not know this
domain and must not invent requirements for it.

The framework's own `.claude/CLAUDE.md` was deliberately **not** installed. It is
auto-loaded context that restates general principles the root `CLAUDE.md` and these skills
already carry, and its routing table points at workflows and commands this repo does not
use (`/new-feature`, `/release`, `/security-review`) — each of which has a better,
project-specific entry point below. The skills reference the standards they need at the
point of use, which is when reading one is actually worth the tokens.

## Installed

**Specialist skills** — areas this repo had no guidance for at all:

| Skill | Why this repo needs it |
| --- | --- |
| `accessibility-reviewer` | The 2026-08-13 redesign found contrast and dialog-semantics defects by hand. Nothing here encoded how to look for them. |
| `ux-reviewer` | UX is a first-class concern (`docs/SIMPLIFICATION-AUDIT.md`) with no skill behind it. |
| `frontend-architect` | Next 16 App Router, server/client boundaries, bundle cost. |
| `performance-engineer` | Query, render and payload performance — uncovered. |
| `qa-engineer` | Test *design*. `rls-test` covers the database only; `ship-check` runs tests but does not design them. |
| `devops-engineer` | Vercel deploy, CI gates, env separation, cron, rollback. |
| `business-analyst` | Requirements and acceptance criteria — the discipline behind the simplification audits. |
| `principal-architect` | Cross-cutting technical ownership. Nothing here coordinates a change that spans modules. |

**Agent** — `principal-architect`, for when that review is self-contained work whose result
is read on its own. It holds only what changes under delegation and reads the skill for the
rest, so the two cannot drift.

**Workflow commands** (`disable-model-invocation`, so they cost nothing until invoked):
`/bug-fix` · `/incident-response` · `/dependency-upgrade` · `/refactoring`, each reading its
definition from `.claude/workflows/`. `/incident-response` matters because the app is live
(`ats.coreit.com.au`); `/dependency-upgrade` matters because §10a holds TypeScript and
ESLint back on purpose and that decision needs re-checking every time.

**Standards**: `review` · `ux` · `coding` · `performance` · `database` · `testing` ·
`operations` · `security` · `architecture` — the closed set the installed skills and
workflows reference. Not auto-loaded; read on demand.

**Template**: `ADR.md`.

## Deliberately not installed

Not because they are poor, but because this repo already has a *specific* entry point for
that job, and two entry points for one job invites picking the weaker one.

| Skipped | Superseded by |
| --- | --- |
| `security-engineer`, `/security-review` | `agents/security-auditor.md` — knows the service-role client, RLS, cron auth, `anon` grants |
| `database-architect` | `agents/migration-author.md` + `migrations-check` + `rls-test` |
| `code-standards-reviewer`, framework `code-reviewer` agent | `agents/code-reviewer.md` (the one file-level collision; ours was kept) |
| `release-engineer`, `/release` | `ship-check` and `/ship` |
| `/new-feature` | `multi-tenant-feature` |
| `/architecture-review` | the `principal-architect` skill, which defines the same review output |
| `documentation-engineer` | CLAUDE.md §0 update protocol and its Stop hook |
| `ai-engineer`, `standards/ai.md` | no LLM-backed behaviour in the app |
| `backend-architect`, `solution-architect`, `refactoring-specialist`, `product-owner`, `feature-planner` | covered more specifically by CLAUDE.md §2–§4, the agents above, or the harness |
| framework `.claude/CLAUDE.md`, `templates/project-claude.md` | the root `CLAUDE.md` |

## Updating

Read `.claude/VERSION`, then the framework's `CHANGELOG.md` from that version forward, and
apply changes deliberately — to the files listed above. A change to something in the
"not installed" table is a decision to revisit, not a file to copy. The framework's
`scripts/install-into.sh <repo>` previews without writing and never overwrites; it is safe
to re-run to see what has appeared since.
