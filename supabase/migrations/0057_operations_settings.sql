-- 0057_operations_settings — "How you work": the plant switch and the turnaround.
--
-- Darshan's BA review, Phase 3 (items 3.4 and 3.9). Two settings for a new
-- screen, Settings › How you work, both stored under one new key in the
-- tenant's existing settings bag:
--
--   settings.operations = { "plantStages": false, "defaultTurnaroundDays": 2 }
--
--   * `plantStages` (brief 3.9) shows or hides the plant screens — the In the
--     plant tab, its Today tiles and its stage strip. Default **off**: the live
--     laundry has never created a production batch, and `production_batches`
--     links to a run and to stock, never to a laundry job, so the screens read
--     as part of a job's flow when they are not. Hidden, not linked; the data
--     and the routes are untouched.
--   * `defaultTurnaroundDays` (brief 3.4) is the job form's default return date
--     for a customer who is on no round. Default 2. A customer on a round gets
--     that round's next visit instead.
--
-- This migration only lets the Owner *write* the key. Nothing reads it in SQL:
-- the app parses it (`parseOperations`) and treats an absent key as the
-- defaults above, so a laundry that never opens the screen behaves exactly as
-- it did before 0057, plant aside. The plant switch defaulting off is a change
-- in what the rail shows, not in any data.
--
-- `save_tenant_settings` is rebuilt from 0056's body — the latest ancestor —
-- with one key added to its whitelist. Everything else is verbatim: the owner
-- check (42501), the whitelist refusal (22023), the object check, the merge,
-- SECURITY DEFINER, and the grants.
--
-- Adds no table, no column, no policy, no trigger and no capability; changes no
-- row. **Written, NOT applied** to laundrymart-syd.

create or replace function public.save_tenant_settings(t uuid, p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(t, array['super_admin']) then
    raise exception 'only the owner can change these settings' using errcode = '42501';
  end if;
  if p_key not in ('notifications', 'invoiceProfile', 'receivables', 'automation', 'operations') then
    raise exception 'that is not a setting this screen may change' using errcode = '22023';
  end if;
  if p_value is null or jsonb_typeof(p_value) <> 'object' then
    raise exception 'settings must be an object' using errcode = '22023';
  end if;
  update public.tenants
     set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
   where id = t;
end $$;

revoke all on function public.save_tenant_settings(uuid, text, jsonb) from public, anon;
grant execute on function public.save_tenant_settings(uuid, text, jsonb) to authenticated;

-- ------------------------------------------------------- self-assertions ----
do $$
declare v_src text;
begin
  select prosrc into v_src from pg_proc
   where oid = 'public.save_tenant_settings(uuid, text, jsonb)'::regprocedure;

  -- Every key an earlier migration admitted must still be admitted, or a
  -- settings screen that worked yesterday answers "not a setting" today.
  if v_src not like '%''notifications''%' or v_src not like '%''invoiceProfile''%'
     or v_src not like '%''receivables''%' or v_src not like '%''automation''%'
     or v_src not like '%''operations''%' then
    raise exception '0057: save_tenant_settings lost a settings key' using errcode = 'P0001';
  end if;

  if v_src not like '%super_admin%' then
    raise exception '0057: save_tenant_settings lost its owner check' using errcode = 'P0001';
  end if;

  if not (select prosecdef from pg_proc
           where oid = 'public.save_tenant_settings(uuid, text, jsonb)'::regprocedure) then
    raise exception '0057: save_tenant_settings must be SECURITY DEFINER' using errcode = 'P0001';
  end if;

  if has_function_privilege('anon', 'public.save_tenant_settings(uuid, text, jsonb)', 'EXECUTE') then
    raise exception '0057: anon can execute save_tenant_settings' using errcode = 'P0001';
  end if;

  if not has_function_privilege('authenticated', 'public.save_tenant_settings(uuid, text, jsonb)', 'EXECUTE') then
    raise exception '0057: authenticated cannot execute save_tenant_settings' using errcode = 'P0001';
  end if;
end $$;
