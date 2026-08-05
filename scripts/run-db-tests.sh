#!/usr/bin/env bash
# Local RLS proof: apply migrations to a throwaway Postgres, run pgTAP.
set -euo pipefail
psql -v ON_ERROR_STOP=1 -f scripts/health/pg-bootstrap.sql
for f in supabase/migrations/*.sql; do echo "apply $f"; psql -v ON_ERROR_STOP=1 -f "$f"; done
psql -c "create extension if not exists pgtap;"
for t in supabase/tests/*.test.sql; do echo "== $t =="; psql -v ON_ERROR_STOP=1 -f "$t"; done
