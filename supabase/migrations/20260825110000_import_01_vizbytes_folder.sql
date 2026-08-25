-- import_01 — the VIZSERVE folder, in VizBytes.
--
-- First of six files that carry ONE SLICE of the ClickUp export into this
-- database, as a test of the mapping before the other 3,853 rows are considered:
--
--   VizBytes > VIZSERVE > Project Management System Portal   — 24 tasks
--
--   01  this file                the folder
--   02  the list
--   03  the 19 top-level tasks
--   04  the 5 subtasks
--   05  Kurt's assignee rows
--   06  the 2 ClickUp comments
--
-- Split six ways ON PURPOSE. Each file is pasted and then VERIFIED against the
-- live database before the next is applied, so a mapping that is wrong is wrong
-- in one table rather than in six.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor. Same convention as P7-18 — the
-- project is not linked locally and `db push` would prompt for a password.
--
-- WHY DATA LIVES IN A MIGRATION AT ALL. Precedent is
-- `20260729090500_p0_02_seed_departments.sql`, which puts production rows in a
-- migration with fixed UUIDs "so every environment agrees, and so tests and
-- fixtures can refer to a department without a lookup". Same three reasons here:
-- fixed ids make each file idempotent, let 04 reference 03's parent as a
-- literal, and make the rollback file exact.
--
-- ON D21. `CLAUDE.md` records "no sync, no export/import, no migration". That
-- decision is about a LIVE INTEGRATION with ClickUp, and this is not one: no
-- ClickUp identifier enters the schema, nothing in the app reads from or writes
-- to ClickUp, and after these six files there is no coupling left to maintain.
-- It still cuts against the letter of D21, which is why it is written down here
-- rather than left for someone to discover. `P6-10` was withdrawn, so there is
-- no backlog ID to cite; hence `import_0N`.

-- ---------------------------------------------------------------------------
-- Fixed UUIDs for the whole slice, declared once so every file agrees:
--
--   folder VIZSERVE                      b1000000-0000-4000-8000-000000000001
--   list Project Management System …     b2000000-0000-4000-8000-000000000001
--   tasks 01–24                          c1000000-0000-4000-8000-0000000000NN
-- ---------------------------------------------------------------------------

do $$
declare
  v_dept  constant uuid := 'a1000000-0000-4000-8000-000000000001';  -- VizBytes
  v_group constant uuid := 'b1000000-0000-4000-8000-000000000001';
  v_pic          uuid;
  v_existing_id  uuid;
  v_existing_sys boolean;
begin
  -- The department is fixed BY MIGRATION, so its absence is not "a fresh
  -- environment" — it is a broken schema, and the difference is worth an
  -- exception rather than a notice.
  if not exists (select 1 from vizserve_pms_departments where id = v_dept) then
    raise exception 'import_01: the VizBytes department row is missing.'
      using errcode = 'no_data_found';
  end if;

  -- `created_by` on the folder. Users are created by AUTH, not by migration, so
  -- this is resolved by email and never hardcoded — a literal UUID here would be
  -- a foreign-key violation on any environment where the roster is not seeded.
  --
  -- Notice-and-return rather than raise: these files replay on a future
  -- `db reset`, and a data backfill that hard-fails a fresh environment is worse
  -- than one that quietly does nothing there.
  select id into v_pic
    from vizserve_pms_users
   where email = 'ace.guevarra@vizserve.hfse.edu.sg' and is_active;

  if v_pic is null then
    raise notice 'import_01 SKIPPED — no active profile for ace.guevarra@vizserve.hfse.edu.sg.';
    return;
  end if;

  select id, is_system into v_existing_id, v_existing_sys
    from vizserve_pms_task_groups
   where department_id = v_dept and name = 'VIZSERVE';

  if v_existing_id is not null then
    -- The reserved "Client Requests" folder is trigger-guarded against rename,
    -- archive and delete, and everything in it is placed there automatically by
    -- `vizserve_pms_ensure_client_folder`. Importing into it would break both
    -- halves of what it means.
    if v_existing_sys then
      raise exception 'import_01: VIZSERVE in VizBytes is the reserved system folder.'
        using errcode = 'check_violation';
    end if;

    -- Files 02–06 address this folder by its FIXED id. A pre-existing VIZSERVE
    -- under some other id would leave them pointing at nothing, so this stops
    -- here loudly instead of importing into a half-resolved tree.
    if v_existing_id <> v_group then
      raise exception 'import_01: VIZSERVE already exists as % — expected %.',
        v_existing_id, v_group
        using errcode = 'unique_violation';
    end if;

    raise notice 'import_01 — folder VIZSERVE already present. Nothing to do.';
    return;
  end if;

  insert into vizserve_pms_task_groups
    (id, department_id, name, description, is_active, sort_order, is_system, created_by)
  values
    (v_group, v_dept, 'VIZSERVE',
     'VizServe''s own projects. Imported from ClickUp.',
     true,
     -- Between TEST FOLDER (0) and the reserved Client Requests folder (1000),
     -- which sorts last by design.
     10,
     false, v_pic)
  on conflict (id) do nothing;

  raise notice 'import_01 — folder VIZSERVE created as %.', v_group;
end $$;
