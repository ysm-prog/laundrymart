# Dependency Upgrade Workflow

1. Establish why the upgrade is needed: a security advisory, an unsupported version, a required capability, or routine currency. The reason determines the acceptable risk and urgency.
2. Establish a baseline. Confirm the existing checks pass before changing anything, so later failures are attributable.
3. Read the release notes and migration guides between the current and target versions, including the intermediate major versions being skipped.
4. Separate the upgrade from behavioural change. Upgrade dependencies in their own commits; do not bundle feature work.
5. Prefer the smallest useful step. Patch and minor upgrades can be grouped; take each major version deliberately and on its own.
6. Identify the code that touches changed or removed APIs, and update it explicitly rather than relying on compatibility shims.
7. Check transitive dependencies for duplicate or conflicting versions introduced by the upgrade.
8. Run type checks, lint, tests, and build. Exercise the workflows the dependency actually participates in, since type checks alone will not catch changed runtime behaviour.
9. Review the lockfile diff. Unexpected additions, removals, or version jumps deserve an explanation before merging.
10. Record anything that changed for users or operators, and note the rollback position in case the upgrade must be reverted after deployment.

Do not upgrade a dependency merely because a newer version exists. An unmaintained, unused, or trivially replaceable dependency should be removed rather than upgraded.

Apply `.claude/standards/security.md`, `.claude/standards/coding.md` and `.claude/standards/testing.md` throughout.
