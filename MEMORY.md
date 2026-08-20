# MEMORY — working session handoff
> Auto-loaded each session. Canonical state is CLAUDE.md; this is the live delta.

## Latest: the cutover, and a price list every member could read
2026-08-20, branch `claude/electro-services-implementation-8l4f4c`. CLAUDE.md §3, §7, §11, §24,
§25 and the newest changelog entry have it. **One migration (`0033`), applied live.**

The database was ready and the data was not. Putting the first price list on the project is what
exposed the defect: **0018 gated who may *change* `laundry_prices` and left the read at
`is_member(tenant_id)`** — the identical shape 0006 shipped on `invoices` and 0017 replaced one
migration earlier. Driver, counter, warehouse, dispatcher and (since 0031) a board could read
every price straight off PostgREST.

Two things kept it invisible: the table was **empty on every deployment** until 2026-08-20, and
`laundry_pricing.test.sql` positively asserted *"the counter can read the tenant's prices"*.
**A proof that encodes the defect defends it** — that assertion was rewritten to the decision.

`0033` narrows the read to `can_read_pricing()` **and** splits 0018's permissive `for all` write
policy into three, because **a `for all` policy's USING half grants SELECT too** — narrowing the
read alone would have left the list readable through the write policy to `dispatcher`. Same trap
§22 records for 0017. No write set changed in substance (0025's restrictive layer already ANDs).

Found by **probing, not reading**: counting every table in `public` as a real `board` session.
The three new assertions were proved to fail without the migration (10, 13, 14).

621 unit tests, **348 pgTAP assertions** (was 342). `verify` green.

## Live state after the cutover (all read back, §11 has the record)
- **Boards exist.** Adelaide (the real laundry) has **Board 1–4**, at the Adelaide depot,
  **none linked** — no login exists and this deployment cannot send an invitation. Harbour (demo)
  has **Board 1**, linked, `RUN00002` as its run, LJ00004/LJ00005 on it,
  `operated_by_driver_id` = Sam Okoye.
- **Twelfth role profile live:** `board@roles.example.com` / `RoleTest!2026`, Harbour only.
  Written by SQL like the other eleven and checked column-for-column against `driver@`.
- **Signed in as the board:** 1 board, 1 run, 2 stops, 3 jobs, 4 customers, **0 invoices**,
  0 prices. Not the empty-screen failure.
- **Item categories set on Harbour's five laundry items**; the laundry bag is null on purpose.
  **Adelaide has zero items** — its master is what the unbuilt MYOB import would fill.
- **Harbour has a default price list (9 kinds). Adelaide deliberately does not** — inventing
  rates for a real business is not a repair. Before that there were **0 prices and 0 rate cards
  on the whole project**, so "Price this job" was inert for every job in both laundries.
- Prices after 0033: board/driver/counter/dispatcher/warehouse **0**;
  sales/auditor/finance/owner/office **9**. Advisors still 18.
- 647 invoices, 508 archived customers, 6 jobs, 16 memberships, 10 runs, 15 stops — untouched.

## Do these next
- **Take one job through complete → Price this job → Approve → run the month.** Needs a browser;
  it has never been exercised against real rows. Use **Harbour** — it is the laundry with prices.
- **Invite one real person into `Adelaide Towel Service`** and link them to a board. Both its
  members are platform admins and are filtered out of every picker by design, so until then its
  People screen and job pickers are empty and its four boards stay unlinked.
- **Enter Adelaide's own laundry prices** at Money › Laundry prices. Until then the pricer will
  keep refusing by name, which is correct and unusable.

## Still open (unchanged)
- **`LJ00001` deliberately not repaired:** an Adelaide job whose customer belongs to Harbour,
  still `ready_for_delivery`. The remedy is cancellation, which is terminal, and it is a job
  against a customer rather than a bug's leftover — the owner's call.
  The two *cross-tenant runs* from the same bug **were** cleared (both `planned`, 0 stops worked,
  0 deliveries, 0 pickups, so `driver_id` recorded nothing); ids are in the changelog.
- **Two more tenant-wide reads the board sweep turned up, both pre-existing and neither money.**
  `service_agreements` and `audit_logs` are `for all … using is_member(tenant_id)`, so an
  operational login reads every contract *header* (not its prices — `service_agreement_lines` is
  gated by `can_read_pricing()` and returned 0) and the whole tenant activity log. The contract
  header is deliberately open per §22, *"when a customer is served is operational information"* —
  but §22 says `agreements.read`, and the policy says any member, so the two disagree. The audit
  log has been tenant-wide since 0001 for every role including drivers. Both want a decision
  rather than a quiet narrowing; neither exposes a price or an amount.
- **§23 sweep:** ~345 of 451 `.from(...)` reads still rely on RLS alone. Correct for eleven of
  twelve roles; a platform admin's session spans two laundries.
- **Nothing has talked to Xero yet.** `XERO_CLIENT_ID`/`SECRET` unset by the owner's decision.
- **This deployment cannot send any auth email.** Custom SMTP still needs configuring — which is
  what blocks linking a login to Adelaide's boards.
- Database: **0001–0033 applied to `laundrymart-syd`.** Nothing pending.

## Environment readiness
- node v22.22.2, deps installed
- Postgres 16 + pgTAP local: `sudo pg_ctlcluster 16 main start`, then
  `sudo -u postgres createdb lm_v && PGDATABASE=lm_v bash scripts/run-db-tests.sh`
  runs every migration, the whole proof suite and the seed
- env missing (copy .env.example) — no Supabase credentials in this container; live work is done
  through the Supabase MCP tools

Reminders: RLS on every tenant table (tenant_id); admin client must filter tenant_id;
getClaims not getUser; region syd1.
