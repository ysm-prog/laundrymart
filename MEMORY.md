# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

**The workflow simplification is done, applied to `laundrymart-syd` and merged into `Prod`.**
CLAUDE.md §18 has the full entry; the short version:

```
Office:  Job → Driver → Delivery Date → Assigned
Driver:  My Runs → date → Confirm Load → Start Route → Open Job → Mark Delivered
```

**`0016_job_assignment` is the only migration.** Seventh status `assigned`;
`assigned_driver_id` + `assigned_delivery_date` (+ `assigned_at`, `assigned_by`,
`load_confirmed_at`, `load_confirmed_by`) on `laundry_orders`; four check constraints; two
indexes; both guard functions rewritten; the driver RLS clause widened. **Nothing dropped** —
`vehicle_inspections`, `daily_routes` and `jobs` are all intact.

**Two records of the assignment, on purpose, and the guard is what makes that safe.**
`assigned_driver_id`/`assigned_delivery_date` are the user-facing truth (what My Runs queries);
`stop_id → jobs.route_id → daily_routes` is the operational placement the depot load, the run
sheet and the inventory unload sweep still need. `guard_laundry_order_assignment` refuses every
disagreement, including **a job on a crewed run that names no driver** — on somebody's route
sheet, on nobody's My Runs. If you touch either side, that trigger is the thing to re-read.

**Watch this one:** `laundry_orders` now has **two FKs to `drivers`** (`pickup_driver_id`,
`assigned_driver_id`). Every `drivers(...)` embed on that table must be disambiguated by
constraint name or PostgREST rejects it with PGRST201 at request time — compile-clean and dead
in production, the same class as the 2026-08-05 ambiguous-embed outage. `/orders/:id` and
`/orders` are both explicit now; a new one will not be unless you make it.

**Load confirmation is per job, not just per run.** Start Route dispatches only load-confirmed
jobs, so work assigned after the driver loaded the van stays `assigned` rather than being swept
out. `confirmRunJobsLoaded` (depot screen) and `confirmDayLoad` (My Runs) both write it, so the
two screens cannot disagree about what is on the van.

**Runs are invisible, not deleted.** `/routes/daily`, `/routes/planner`, `/routes/templates`
still work and still hold history, but no rail row and no screen links to them; `nav.test.ts`
asserts no navigation href starts with `/routes/` for any role. Drivers and Vehicles are under
a new **Fleet** area. If a future feature needs run planning back, it is all still there.

**Inspection is out of the workflow, data intact.** `submitInspection`,
`inspection-checklist.tsx` and `checklist.ts` deleted; the table, the column, the two route
statuses and the `inspection_failed` notification kind all stay for history.

**0016 is live** (ledger `20260814084223`). Its **statement order is load-bearing** because it
carries a backfill: transition guard replaced *before* the backfill, constraints and the
assignment guard *after*. The three pre-existing jobs were backfilled from the run chain and
verified; five guard probes were refused in one rolled-back block; no new security advisor.

**Verification state.** 286 unit tests, 118 pgTAP assertions, typecheck/lint/build green,
migrations + pgTAP + seed all applied to a fresh Postgres 16 in-container. My Runs screenshotted
light and dark at ten widths, no overflow, no sub-36px targets. **Not opened against a live
Supabase project** — this container has no credentials. The pre-existing sub-36px targets and
320px/1024px overflow in `/design-preview` come from the **dispatch planner** fixture, which
this branch does not touch.

**Still true from before:** `@typescript-eslint/no-unused-vars` is an error and it earned its
place again here — it caught six dead imports the moment the inspection stage came out.
Compose-locally-commit-once payload schemas stay outside `"use server"` files with tests
against what the producer really emits.
