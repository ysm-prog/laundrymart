-- ============================================================================
-- 0012_optional_inspection — the vehicle inspection stops being a hard gate.
--
-- 0004 refused `in_progress` unless `inspection_id` was set. In practice that
-- made the run un-startable from the office: only a driver on /run can create a
-- vehicle_inspections row, so a run whose driver inspects on paper, or whose
-- login is not yet linked to a driver record, sat at `inspection_pending` with
-- no legal transition out of it except cancellation.
--
-- The inspection is still recorded and still surfaced on the run — it just no
-- longer blocks the transition. The two rules that protect data rather than
-- process are kept:
--   * load confirmation before starting (nothing has left the depot yet), and
--   * unload before closing (closing early strands stock in `in_transit`).
--
-- `create or replace` replaces the whole definition, so the `set search_path`
-- pinned by 0010 has to be restated here or it is silently dropped.
-- ============================================================================

create or replace function public.guard_route_transition()
returns trigger language plpgsql
set search_path = public as $$
begin
  if new.status = 'in_progress' and old.status <> 'in_progress' then
    if new.load_confirmed_at is null then
      raise exception 'load must be confirmed before starting the route'
        using errcode = 'P0001';
    end if;
    new.started_at = coalesce(new.started_at, now());
  end if;

  if new.status = 'closed' and old.status <> 'closed' then
    if new.unloaded_at is null then
      raise exception 'the run must be unloaded before it can be closed'
        using errcode = 'P0001';
    end if;
    new.closed_at = coalesce(new.closed_at, now());
  end if;
  return new;
end $$;

-- `create or replace` keeps the existing ACL, but 0011's default privileges only
-- cover genuinely new functions. Restate the posture so a future replace of this
-- function cannot quietly reopen it on /rest/v1/rpc/….
revoke execute on function public.guard_route_transition() from public, anon;

do $$
begin
  if has_function_privilege('anon', 'public.guard_route_transition()', 'EXECUTE') then
    raise exception 'anon can still execute guard_route_transition' using errcode = 'P0001';
  end if;
end $$;
