-- ============================================================================
-- 0013_notifications — the bell, and the bag of tenant preferences behind it.
--
-- Implements AD-3 and AD-4 of docs/SIMPLIFICATION-DESIGN.md, which share this
-- one migration deliberately: Phase C (notifications) and Phase D (simple mode)
-- both need somewhere per-tenant to keep a switch, and a settings table would be
-- a second thing to join for every page render.
--
-- Numbering note for whoever writes 0014: `Prod` holds 0012_optional_inspection,
-- but the unmerged branch `claude/warehouse-inventory-flow-psooyq` separately
-- carries a `0012_return_count.sql`. 0013 is the next free number off `Prod`; if
-- that branch lands it has to be renumbered rather than this one, because 0013
-- is the one that has been applied.
--
-- A notification is not an event log. It is a piece of work someone has to look
-- at, so it carries who should see it (a capability), what it is about (a
-- subject row), the sentence to show, and — non-negotiably — the path where it
-- gets fixed. Nothing is ever deleted; `read_at` is the only state it has.
-- ============================================================================

-- ------------------------------------------------------------- AD-3 settings ---
-- One jsonb bag rather than a column per preference: notification preferences
-- now, `ui_mode` in Phase D, and whatever Phase E wants. Shape is validated by a
-- Zod schema at the read site, where it can change without a migration.
alter table public.tenants
  add column if not exists settings jsonb not null default '{}'::jsonb;

comment on column public.tenants.settings is
  'Per-tenant preference bag (notification prefs, ui_mode). Validated in TypeScript, not here.';

-- -------------------------------------------------------- AD-4 notifications ---
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- Targeting reuses the capability model in src/lib/roles.ts ('invoices.read',
  -- 'routes.read', …) so the bell filters by exactly what the nav and the page
  -- guards already filter by. Deliberately *not* an enum or an FK: capabilities
  -- are a TypeScript constant, and a check constraint listing them would have to
  -- be migrated every time one is added — a liability for no integrity gained,
  -- since a typo'd capability shows the notification to nobody rather than to
  -- the wrong person.
  audience text not null check (audience <> ''),

  -- Event type slug: 'invoice_overdue', 'run_not_started', 'inspection_failed',
  -- 'vehicle_out_of_service', 'batch_rejected', 'sync_failed'. Same reasoning.
  kind text not null check (kind <> ''),

  -- The row this is about — invoice id, daily route id, batch id. Nullable
  -- because some events (a failed sync sweep, a licence expiry with no single
  -- offending row) have no one subject.
  subject_id uuid,

  -- The business day the event belongs to, and the idempotency axis for the
  -- swept checks: "this invoice is overdue" is one notification per day, not one
  -- per sweep. Sydney rather than tenants.timezone because the default has to be
  -- a constant expression; a tenant elsewhere sets it explicitly on insert.
  occurred_on date not null default (now() at time zone 'Australia/Sydney')::date,

  title text not null check (title <> ''),

  -- Voice rule 4: every notification links to its fix, so this is not null. The
  -- shape check mirrors returnTo() in src/lib/actions.ts — a plain same-site
  -- path. '//host' and '/\host' are protocol-relative and would turn the bell
  -- into an open redirect, so they are refused here as well as there.
  href text not null check (
    left(href, 1) = '/' and left(href, 2) <> '//' and left(href, 2) <> '/\'
  ),

  -- null = unread. There is no delete and no dismissed flag: an alert that was
  -- raised and then made to disappear is the thing an audit asks about.
  read_at timestamptz,

  created_at timestamptz not null default now(),
  -- Set when a server action raises the notification as a side effect of what a
  -- person just did; null for the swept, time-based checks, which have no actor.
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz
);

-- The idempotency key (AD-4). The swept checks run on a cron and must be safe to
-- run twice, so `insert … on conflict do nothing` has to actually collide.
--
-- `nulls not distinct` rather than a coalesce() sentinel expression: subject_id
-- is nullable and a plain unique index treats every NULL as distinct, so the
-- subject-less kinds would double-notify. Both spellings fix that, but PostgREST
-- and supabase-js can only name *columns* in `on_conflict=`, so an expression
-- index would be unusable from the client the app is actually written in — and a
-- sentinel UUID is a magic value that has to be repeated at every call site.
-- Requires Postgres 15+; CI and the hosted project are both 16 or later.
create unique index uq_notifications_event
  on public.notifications (tenant_id, kind, subject_id, occurred_on)
  nulls not distinct;

-- The bell's hot path: unread count for the tenant, narrowed to the capabilities
-- the viewer holds. Partial, because a read notification is never counted and
-- read rows are the ones that accumulate.
create index idx_notifications_unread
  on public.notifications (tenant_id, audience)
  where read_at is null;

-- Newest-first render of the panel itself.
create index idx_notifications_recent
  on public.notifications (tenant_id, created_at desc);

-- ------------------------------------------------------------------- RLS ----
-- Attaches the member policy (using + with check), the tenant_id index and the
-- updated_at trigger. Audience filtering is a UI concern layered on top of this,
-- never a substitute for it.
select public.apply_tenant_policy('notifications');

-- 0001's blanket grant was a snapshot; a table created later needs its own.
-- Named explicitly rather than `on all tables in schema public` so this cannot
-- widen anything else — and note there is deliberately no function grant here:
-- see the warning in CLAUDE.md §7, `anon` stays revoked.
grant select, insert, update, delete on public.notifications to authenticated;
grant all on public.notifications to service_role;
