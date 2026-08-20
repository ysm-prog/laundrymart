# Security

Report privately to security@example.com — replace this address before going live.
Acknowledgement within 24h, triage within 72h.

| Layer | Control |
|---|---|
| Transport | HTTPS + HSTS (preload) |
| Headers | X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy (next.config) |
| AuthN | Supabase Auth; `getClaims()` verifies the JWT locally, no per-navigation round trip |
| AuthZ | RLS on every tenant table (`tenant_id` + `is_member`), driver rows scoped to their own run, finance writes role-gated; capabilities in `src/lib/roles.ts` gate the UI and server actions |
| Data integrity | Business rules that must not be skippable are Postgres triggers, not app checks |
| Audit | Append-only `audit_logs` written after every mutating action |
| Secrets | gitleaks strict in CI + pre-commit; env validated fail-fast |
| Supply chain | Dependabot weekly; npm audit surfaced in CI |
| Proof | Four pgTAP suites run in CI, including one that fails the build if a tenant table ships without a policy |

Offline sync accepts only batches whose `client_ref` is unique per tenant, so a replayed
queue can never double-post field data.

Rotate the service-role key and integration tokens every 90 days. GitHub PATs short-lived,
revoked after use.
