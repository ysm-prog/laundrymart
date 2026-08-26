#!/usr/bin/env bash
# Local RLS proof: apply migrations to a throwaway Postgres, run pgTAP.
#
# **Why this parses the output rather than trusting the exit code.** `psql`
# exits 0 for a pgTAP file that runs to completion, and a failed assertion is a
# *result row* (`not ok 7 - a driver cannot ...`), not an error. So with
# `ON_ERROR_STOP=1` alone this script — and therefore CI — went green over a
# security proof that had started failing. A wrong `plan(N)` is the same shape:
# pgTAP reports "Looks like you planned 20 tests but ran 23" as a diagnostic,
# which is how three files drifted out of step without anybody noticing.
#
# Both are treated as failures here. A plan mismatch is not pedantry: the plan
# is what catches a file that dies half way through, which is exactly the case
# where the assertions you care about are the ones that never ran.
set -euo pipefail

psql -v ON_ERROR_STOP=1 -f scripts/health/pg-bootstrap.sql
for f in supabase/migrations/*.sql; do echo "apply $f"; psql -v ON_ERROR_STOP=1 -f "$f"; done
psql -c "create extension if not exists pgtap;"

failed=0
for t in supabase/tests/*.test.sql; do
  echo "== $t =="
  # `|| true` so one failing file does not abort the run under `set -e`: a
  # single report of everything wrong beats finding them one commit at a time.
  output=$(psql -v ON_ERROR_STOP=1 -f "$t" 2>&1) || failed=1
  echo "$output"

  if grep -qE '^\s*not ok ' <<<"$output"; then
    echo "FAILED: $t has failing assertions" >&2
    failed=1
  fi
  if grep -q 'Looks like you planned' <<<"$output"; then
    echo "FAILED: $t declares a plan(N) that does not match what it ran" >&2
    failed=1
  fi
  if grep -q 'Looks like you failed' <<<"$output"; then
    echo "FAILED: $t reported failures" >&2
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo "pgTAP suite FAILED" >&2
  exit 1
fi
echo "pgTAP suite passed"
