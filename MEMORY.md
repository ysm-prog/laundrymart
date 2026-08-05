# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**Status:** MVP built, all branches merged into `Prod`, and green — `npm run verify` and
`npm run db:test` both pass (49 unit tests, 30 pgTAP assertions) on the upgraded stack
(Next 16, Tailwind 4, Zod 4, vitest 4).

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

**Toolchain decisions from the dependency merge**
- TypeScript is pinned to **6**, not the 7 Dependabot offered: typescript-eslint has no TS 7
  support, so ESLint dies with "typescript-eslint does not support TS 7.0".
- ESLint is pinned to **9**, not 10: `eslint-config-next@16` depends on typescript-eslint 8,
  which targets ESLint 9 — under 10 the parser throws `scopeManager.addGlobals is not a
  function`. Revisit both when the lint stack catches up.
- Next 16 needs `experimental.useTypeScriptCli` because TS no longer exposes the JS
  compiler API Next used to call.
- Tailwind 4 is CSS-first: there is no `tailwind.config.ts`, the theme lives in `@theme`
  in `globals.css`, and PostCSS uses `@tailwindcss/postcss`.
- `npm install eslint@^9.40.0` hangs for minutes before failing — 9.40 does not exist and
  npm backtracks the whole tree. Check the version exists before pinning.

**Gotchas worth remembering**
- A `"use server"` file may only export async functions — constants live in a sibling module
  (`items/categories.ts`, `run/checklist.ts`, `inventory/states.ts`).
- Supabase's type inference gives up on `.select()` strings built with `+`; use `.returns<T>()`.
- The local pgTAP shim needs `grant usage on schema auth` or security-invoker functions that
  call `auth.uid()` fail for the wrong reason.
