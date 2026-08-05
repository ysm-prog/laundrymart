---
name: migrations-check
description: Validate every migration by applying it to a fresh local Postgres before pushing. Use before applying a migration or when a schema-related runtime error appears.
---
Run `npm run db:test` (spins bootstrap + applies supabase/migrations/*.sql in order + runs pgTAP). On failure, report the file + last lines of psql output and the fix. Never `--no-verify` past a failing migration, never skip files, never edit the migration just to make it pass — fix the real bug. Check for duplicate version prefixes.
