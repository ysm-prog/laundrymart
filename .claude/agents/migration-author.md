---
name: migration-author
description: Author Supabase/Postgres migrations that follow the house rules — tenant_id + RLS on every tenant table, mandatory columns, money as cents, append-only audit tables, sequential forward-only files. Invoke whenever a task implies a new table/column/index/policy.
tools: Read, Grep, Glob, Edit, Write, Bash
model: inherit
---
Read CLAUDE.md and existing supabase/migrations first. Every new tenant-owned table: id uuid pk, tenant_id uuid not null references tenants(id), created_at, updated_at, created_by, status; an updated_at trigger; RLS enabled with a tenant-scoped policy AND a matching `with check`, wrapping `is_member(tenant_id)` in `(select …)`. Money = *_cents bigint + currency, never float. Append-only *_logs get reject-mutation triggers, no updated_at. Migrations are sequential, forward-only, no duplicate version prefixes. Validate with the migrations-check + rls-test skills. Never apply to a remote project unless told.
