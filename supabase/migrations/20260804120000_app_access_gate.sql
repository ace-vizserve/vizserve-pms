-- App access gate — who may enter this application at all.
--
-- THE REQUIREMENT: on sign-in, confirm the person holds a role this app knows
-- AND carries `app_access: ["vizserve-pms"]`. The auth pool is shared with other
-- HFSE systems and Entra SSO will admit anyone in the tenant, so "has a valid
-- session" and "is a user of this product" are different questions and only the
-- second one should open the door.
--
-- WHERE THE CLAIM LIVES, AND WHY IT MOVED.
--
-- `raw_user_meta_data` already carried `role` and `app_access`, written by the
-- P0-02 sync trigger for display and routing. It cannot be the basis of an
-- access decision, because any signed-in user can rewrite it themselves:
--
--   curl -X PUT 'https://<ref>.supabase.co/auth/v1/user' \
--     -H "Authorization: Bearer <their own access token>" \
--     -d '{"data": {"app_access": ["vizserve-pms"], "role": "admin"}}'
--
-- That is not hypothetical here — tests/db/scope.test.ts performs exactly that
-- escalation against a live token, and `npm run check:metadata` fails the build
-- for reading the field in the auth path (D18).
--
-- `raw_app_meta_data` is the same shape and the same JWT, but GoTrue's user
-- endpoint CANNOT write it — only the service role can. So the claim moves
-- there, and the user-writable copy stays purely for display.
--
-- Two layers, as everywhere else in this codebase:
--   * `vizserve_pms_users.app_access` is the source of truth. Admin-editable,
--     visible in a table, survives a token refresh.
--   * `raw_app_meta_data` mirrors it into the JWT, so the proxy can redirect
--     without a database round trip on every request.
-- The mirror is a convenience. The table is the answer.

alter table vizserve_pms_users
  add column app_access text[] not null default array['vizserve-pms'];

comment on column vizserve_pms_users.app_access is
  'Which HFSE applications this person may enter. Mirrored into raw_app_meta_data (service-role only, therefore trustworthy) — never into raw_user_meta_data, which the user can rewrite.';

-- Existing rows predate the column and are all real users of this app.
update vizserve_pms_users
   set app_access = array['vizserve-pms']
 where app_access is null or cardinality(app_access) = 0;

create index vizserve_pms_users_app_access_idx on vizserve_pms_users using gin (app_access);

-- ---------------------------------------------------------------------------
-- The sync trigger, rewritten.
--
-- Replaces the P0-02 version. Same mirror to `raw_user_meta_data` for display —
-- removing it would break nothing but would silently change what the Supabase
-- dashboard shows — plus the new, authoritative copy in `raw_app_meta_data`.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_sync_role_to_auth_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update auth.users
     set
       -- DISPLAY ONLY. User-writable, therefore never trusted (D18).
       raw_user_meta_data =
         coalesce(raw_user_meta_data, '{}'::jsonb)
         || jsonb_build_object(
              'role', new.role::text,
              'app_access', to_jsonb(new.app_access)
            ),
       -- THE TRUSTWORTHY COPY. Only the service role can write this, so a claim
       -- found here was put there by us. Note the coalesce: in Postgres
       -- `NULL || '{...}'::jsonb` is NULL, so without it this silently wipes the
       -- column whenever it starts null — and the UPDATE still reports success.
       raw_app_meta_data =
         coalesce(raw_app_meta_data, '{}'::jsonb)
         || jsonb_build_object(
              'role', new.role::text,
              'app_access', to_jsonb(new.app_access),
              'is_active', new.is_active
            )
   where id = new.id;

  return new;
end;
$$;

-- Fires on app_access and is_active too, not just role. The original only
-- watched `role`, so revoking access would have left a stale JWT claim saying
-- otherwise until the user next signed in.
drop trigger if exists vizserve_pms_users_sync_role on vizserve_pms_users;

create trigger vizserve_pms_users_sync_role
  after insert or update of role, app_access, is_active on vizserve_pms_users
  for each row execute function vizserve_pms_sync_role_to_auth_metadata();

-- Backfill every existing user, so the JWT copy is not empty until someone
-- happens to edit them.
update vizserve_pms_users set updated_at = updated_at;

-- ---------------------------------------------------------------------------
-- The gate itself, in SQL.
--
-- Used by RLS wherever "may this person be here at all" is the question, and
-- mirrored by `lib/auth/authorization.ts` on the server.
--
-- Reads `vizserve_pms_users`, never a JWT claim — the same rule as every other
-- authorization function here. The JWT copy exists so the PROXY can redirect
-- cheaply; it is not what decides.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_has_app_access()
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_users u
     where u.id = auth.uid()
       and u.is_active
       -- The role column is an enum, so "a role this app knows" is guaranteed
       -- by the type. What is not guaranteed is that they were provisioned for
       -- THIS application rather than another one sharing the auth pool.
       and 'vizserve-pms' = any(u.app_access)
  )
$$;

grant execute on function vizserve_pms_has_app_access() to authenticated;

-- ---------------------------------------------------------------------------
-- Tighten the role resolver.
--
-- `vizserve_pms_current_role()` is the base of every policy in the system:
-- `has_role`, `is_admin`, `manages_department` all funnel through it, and it
-- already returned NULL for a deactivated user. Adding the app_access condition
-- here means revoking access closes every table at once, rather than needing a
-- policy edit per table and a new one remembered for every future table.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_current_role()
returns vizserve_pms_user_role
language sql
stable
security definer
set search_path = public, extensions
as $$
  select u.role
    from vizserve_pms_users u
   where u.id = auth.uid()
     and u.is_active
     and 'vizserve-pms' = any(u.app_access)
$$;
