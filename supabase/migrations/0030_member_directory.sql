-- 0030_member_directory — the tenant's people, with their names, in one read.
--
-- Until now every screen that had to put a name beside a `user_id` asked the
-- GoTrue admin API for one id at a time, on the service-role client. That is
-- three separate problems, all of them visible on the deployed app:
--
--   1. **It cannot see a name at all.** The admin API returns an address, so the
--      job pickers, the People list and the driver link offered emails — and a
--      short UUID for anybody the call failed on. Nobody in a laundry is called
--      `8c2b996b…`.
--   2. **It is one HTTP round trip per member**, on a screen that renders two
--      pickers, and it fails whole for any user GoTrue itself refuses to scan.
--      The eleven role profiles on this deployment (§3a) were written straight
--      into `auth.users` and carry NULL token columns, which GoTrue reads into
--      non-nullable strings — so every one of them came back as a short id
--      while the two API-created logins resolved.
--   3. **It is not tenant-scoped.** `memberships` is read through RLS, and
--      `is_member()` is true of *every* laundry for a platform admin (0019), so
--      their session listed each of their memberships once per laundry. That is
--      the duplicated rows in the picker.
--
-- So the directory is a definer function instead: one query, scoped to one
-- tenant by argument and gated on membership, returning the name where a name
-- is known. `auth.users` is not readable by an ordinary session and PostgREST
-- does not publish it, which is the same reason `platform_migrations()` (0019)
-- and `archived_record_counts()` (0017) are shaped this way.
--
-- Adds no table, no column, no policy, and changes no row.

-- --------------------------------------------------------------- directory ---
-- `is_member(t)` rather than a role gate: a picker of who to assign a job to is
-- not an administrative act, and the People screen's own capability check
-- already stands in front of the one screen that shows addresses. It raises
-- rather than returning nothing, so a caller that passes the wrong tenant reads
-- as refused rather than as a laundry with no staff in it.
--
-- Two names are returned, not one resolved name: the app decides between them
-- in a pure, tested rule (`memberDisplayName`), and the driver name is the one
-- fallback worth having — a laundry that has linked a driver's login has
-- already typed that person's name in once.
create or replace function public.tenant_members(t uuid)
returns table (
  user_id           uuid,
  email             text,
  full_name         text,
  driver_name       text,
  role              text,
  depot_id          uuid,
  joined_at         timestamptz,
  is_platform_admin boolean
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not public.is_member(t) then
    raise exception 'that business is not yours' using errcode = '42501';
  end if;

  return query
    select m.user_id,
           u.email::text,
           -- Supabase writes an invited user's metadata under whichever key the
           -- caller chose; this app writes `full_name` and accepts `name` so a
           -- login created elsewhere (an OAuth provider, the Supabase console)
           -- is not nameless here. Blank is absence, not a name.
           nullif(btrim(coalesce(u.raw_user_meta_data ->> 'full_name',
                                 u.raw_user_meta_data ->> 'name', '')), ''),
           d.full_name,
           m.role,
           m.depot_id,
           m.created_at,
           exists (select 1 from public.platform_admins pa where pa.user_id = m.user_id)
      from public.memberships m
      join auth.users u on u.id = m.user_id
      left join lateral (
        select dr.full_name
          from public.drivers dr
         where dr.user_id = m.user_id
           and dr.tenant_id = t
           and dr.deleted_at is null
         order by dr.created_at
         limit 1
      ) d on true
     where m.tenant_id = t
     order by m.created_at;
end $$;

comment on function public.tenant_members(uuid) is
  'The people of one laundry the caller belongs to: id, address, name, linked '
  'driver name, role, site and whether they are a platform administrator.';

-- ------------------------------------------------------------------ grants ---
-- 0011 revoked the implicit PUBLIC grant and set default privileges to keep it
-- revoked, so a new function reaches nobody until it is granted. `anon` is
-- never granted anything here (§7).
revoke all on function public.tenant_members(uuid) from public, anon;
grant execute on function public.tenant_members(uuid) to authenticated, service_role;

-- The trap 0011 documents: the membership check above raises 42501, which is
-- also "permission denied", so a probe asserting only on the SQLSTATE passes
-- while the grant is still open. Assert on the privilege itself.
do $$
begin
  if has_function_privilege('anon', 'public.tenant_members(uuid)', 'EXECUTE') then
    raise exception 'anon can still execute tenant_members' using errcode = 'P0001';
  end if;
end $$;
