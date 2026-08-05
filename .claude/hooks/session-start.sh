#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$root"
ctx="## Environment readiness"$'\n'
node -v >/dev/null 2>&1 && ctx+="- node $(node -v)"$'\n' || ctx+="- node MISSING (>=20)"$'\n'
[ -d node_modules ] && ctx+="- deps installed"$'\n' || ctx+="- deps NOT installed (npm install)"$'\n'
{ [ -f .env.local ] || [ -f .env ]; } && ctx+="- env present"$'\n' || ctx+="- env missing (copy .env.example)"$'\n'
ctx+=$'\n'"Reminders: RLS on every tenant table (tenant_id); admin client must filter tenant_id; getClaims not getUser; region syd1."
printf '%s' "$ctx" | python3 -c 'import json,sys;print(json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":sys.stdin.read()}}))' 2>/dev/null || printf '%s' "$ctx"
