---
name: multi-tenant-feature
description: Scaffold a new tenant-owned CRUD entity (migration + RLS + types + server actions + pages). Use for "add <entity>", "build the <x> module".
---
1. Migration: table with id, tenant_id references tenants(id), status, created_at/by, updated_at + trigger; RLS policy `using ((select is_member(tenant_id)))` with matching `with check`. 2. Validate with migrations-check + rls-test. 3. Server actions ("use server", async-only): derive tenant_id from the session (never the form), every UPDATE/DELETE `.eq("tenant_id", session.tenantId)`, errors redirect `?error=`, record audit after success. 4. Pages: list/new/[id] as server components, `export const dynamic="force-dynamic"` only where needed, stream heavy widgets under <Suspense> with loading.tsx. 5. ship-check. Don't build REST routes — use Server Actions.
