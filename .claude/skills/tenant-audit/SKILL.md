---
name: tenant-audit
description: Scan for Supabase queries against tenant tables that omit an explicit tenant_id filter. Use for "check tenant isolation", "audit RLS", "find cross-tenant leaks", or before promoting to main if query code changed.
---
The admin/service-role client (createAdminClient) BYPASSES RLS — every read/write through it MUST `.eq("tenant_id", session.tenantId)`. The RLS-bound client (createClient) is safe-by-default.
1. `grep -rn "\.from('" src/`
2. Per hit: which table? tenant-owned? which client? has a tenant_id filter (or tenant_id in the insert body)?
3. Severity: HIGH = admin client, no filter (RLS bypassed); MED = RLS client, no filter (defence-in-depth gap); OK = filtered.
Also flag: empty-string proxy fallbacks, default-tenant fallbacks in writes, `count` queries with no tenant_id, cross-tenant joins.
Output a table (sev · file:line · table · client · issue), cap 20, sorted by severity. Don't auto-fix; present and ask. Zero findings is valid.
