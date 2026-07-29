-- P0-02 — Base schema: departments, users, managed departments.
--
-- Conventions (docs/02-data-model.md):
--   * every TABLE and ENUM TYPE is prefixed `vizserve_pms_`
--   * COLUMNS are not prefixed
--   * single-tenant — there is no organization_id (D8)

create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------------------
-- Roles are INCLUSIVE: admin ⊇ manager ⊇ team_leader ⊇ member (D15).
--
-- Declared in ascending order of authority on purpose. Postgres compares enum
-- values by declaration order, so `role >= 'team_leader'` is a valid, indexable
-- comparison and the hierarchy needs no lookup table or CASE ladder.
--
-- A user holds ONE role — the highest they hold. Which departments they
-- actually lead is `vizserve_pms_user_managed_departments`, never the role.
-- This exists because real people are admin *and* a TL (Amier), or manager
-- *and* TL of two departments (Joel).
-- ---------------------------------------------------------------------------
create type vizserve_pms_user_role as enum ('member', 'team_leader', 'manager', 'admin');

-- Shared updated_at trigger.
create or replace function vizserve_pms_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Departments
-- Real production data from day one — VizBytes, VizAssists, VizBooks, VizMedia
-- (D14). Seeded in supabase/seed.sql.
-- ---------------------------------------------------------------------------
create table vizserve_pms_departments (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger vizserve_pms_departments_updated_at
  before update on vizserve_pms_departments
  for each row execute function vizserve_pms_set_updated_at();

-- ---------------------------------------------------------------------------
-- Users — mirrors auth.users one-to-one.
-- ---------------------------------------------------------------------------
create table vizserve_pms_users (
  id                     uuid primary key references auth.users (id) on delete cascade,
  email                  extensions.citext not null unique,
  full_name              text not null default '',
  role                   vizserve_pms_user_role not null default 'member',
  primary_department_id  uuid references vizserve_pms_departments (id) on delete set null,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create index vizserve_pms_users_primary_department_idx
  on vizserve_pms_users (primary_department_id);
create index vizserve_pms_users_role_idx on vizserve_pms_users (role);

create trigger vizserve_pms_users_updated_at
  before update on vizserve_pms_users
  for each row execute function vizserve_pms_set_updated_at();

-- ---------------------------------------------------------------------------
-- Managed departments — the many-to-many that gives a TL/manager their scope.
-- "checkbox, multiple" (Amier, ~26:00).
-- ---------------------------------------------------------------------------
create table vizserve_pms_user_managed_departments (
  user_id        uuid not null references vizserve_pms_users (id) on delete cascade,
  department_id  uuid not null references vizserve_pms_departments (id) on delete cascade,
  created_at     timestamptz not null default now(),
  primary key (user_id, department_id)
);

create index vizserve_pms_user_managed_departments_department_idx
  on vizserve_pms_user_managed_departments (department_id);

-- ---------------------------------------------------------------------------
-- auth.users -> vizserve_pms_users
--
-- One human, one profile row. Supabase links identities that share a VERIFIED
-- email into a single auth.users row, which is what makes "Entra on Monday,
-- email/password on Tuesday" resolve to one profile — but that behaviour is a
-- PROJECT SETTING, not something this migration can enforce. Confirm it is on
-- before P0-03 is called done; the `on conflict` below is a guard, not a fix.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into vizserve_pms_users (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', ''),
      ''
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger vizserve_pms_on_auth_user_created
  after insert on auth.users
  for each row execute function vizserve_pms_handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Keep raw_user_meta_data.role in step with the table.
--
-- The table is the source of truth; this mirror exists for display and routing
-- only (D18). Note the coalesce: in Postgres `NULL || '{...}'::jsonb` is NULL,
-- so without it this silently wipes the column whenever it starts null — and
-- the UPDATE still reports success.
--
-- NOTHING IN THE AUTHORIZATION PATH MAY READ THIS. It is user-writable through
-- Supabase's own GoTrue endpoint. See docs/02-data-model.md §Auth metadata.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_sync_role_to_auth_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  update auth.users
     set raw_user_meta_data =
           coalesce(raw_user_meta_data, '{}'::jsonb)
           || jsonb_build_object(
                'role', new.role::text,
                'app_access', jsonb_build_array('vizserve-pms')
              )
   where id = new.id;

  return new;
end;
$$;

create trigger vizserve_pms_users_sync_role
  after insert or update of role on vizserve_pms_users
  for each row execute function vizserve_pms_sync_role_to_auth_metadata();
