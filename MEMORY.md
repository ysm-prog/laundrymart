# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Status:** MVP built end to end and green — `npm run verify` and `npm run db:test` both pass
(41 unit tests, 30 pgTAP assertions).

**Not yet done / next up**
1. Connect a real Sydney Supabase project: `.env.local`, asymmetric JWT signing keys, then
   push `supabase/migrations/` and create the first tenant + membership rows.
2. Invoice PDF + email. Today the invoice page is print-styled and uses the browser dialog;
   attachments need server-side rendering and an email provider (spec §18 open question).
3. Photo and signature capture. Columns exist (`photo_urls`, `signature_url`); needs a
   storage bucket and an upload path that also works offline.
4. Warehouse module (spec §7.16). Inventory states are already modelled, so this is additive.
5. Per-kg pricing on invoice generation — the model and schema support it, but the generator
   currently prices `per_item`, `per_collection` and `monthly` lines only.

**Gotchas worth remembering**
- A `"use server"` file may only export async functions — constants live in a sibling module
  (`items/categories.ts`, `run/checklist.ts`, `inventory/states.ts`).
- Supabase's type inference gives up on `.select()` strings built with `+`; use `.returns<T>()`.
- The local pgTAP shim needs `grant usage on schema auth` or security-invoker functions that
  call `auth.uid()` fail for the wrong reason.
