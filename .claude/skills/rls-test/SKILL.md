---
name: rls-test
description: Author/run pgTAP tests that PROVE tenant isolation (cross-tenant rows invisible; with check blocks tenant-hop). Use when adding a tenant table or editing an RLS policy.
---
Copy supabase/tests/rls_isolation.test.sql to <table>.test.sql. Fill in the table + tenant_id + membership insert + four assertions: A sees only A; A can't read B; with check blocks cross-tenant INSERT; with check blocks re-tenanting UPDATE. Run as `set local role authenticated` with a jwt sub — never the service role (it bypasses RLS and proves nothing). CI runs every supabase/tests/*.test.sql.
