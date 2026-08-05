#!/usr/bin/env bash
# Single gate: run by pre-commit, CI, and the Vercel build. Fail fast.
set -euo pipefail
say(){ printf '\n== %s ==\n' "$1"; }
say typecheck; npm run typecheck
say lint;      npm run lint
say test;      npm run test
say build;     SKIP_ENV_VALIDATION=1 \
  NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co \
  NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder-anon-key-placeholder \
  SUPABASE_SERVICE_ROLE_KEY=placeholder-service-role-placeholder \
  npm run build
say PASSED
