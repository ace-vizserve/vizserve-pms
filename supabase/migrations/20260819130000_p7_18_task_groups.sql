-- ---------------------------------------------------------------------------
-- P7-18 — Folders. A department's work gets one more level above its lists.
--
-- THE SHAPE, and it is ClickUp's rather than a new invention:
--
--   Department        VizBytes                 (already exists — the Space)
--     └ Folder        VIZSERVE PROJECTS        (this migration)
--         └ List      VIZSERVE WEBSITE         (already exists)
--             └ Task                           (already exists)
--                 └ Subtask                    (already exists — P7-09)
--
-- Three of those five levels were already here. This adds the one that was
-- missing and nothing else.
--
-- ⚠️ THIS REVERSES A DECISION MADE ON 19 AUG, and the reversal is the point
-- rather than an oversight. `components/app-shell/nav-projects.tsx:36-40` says:
--
--   "A department is the folder and a list is the project, because that is the
--    shape the data already has. Adding a separate 'space' or 'folder' table to
--    match the reference exactly would be a third grouping beside two that
--    already exist, and the third one is the one nobody maintains."
--
-- That was a reasonable call and it was wrong, for a reason that only shows up
-- in an example: the folder people want to create is "VIZSERVE PROJECTS", which
-- is not a department. Departments are VizBytes, VizAssists, VizBooks and
-- VizMedia — a fixed, admin-managed list of who does the work. Folders are how a
-- team groups what the work is FOR, they are created and renamed constantly, and
-- collapsing the two means the grouping people actually want cannot be expressed
-- at all. The comment in that file is rewritten alongside this migration; a note
-- explaining why the code is one way, sitting above code that is now the other
-- way, is worse than no note.
--
-- FOLDERS ARE OPTIONAL, exactly as in ClickUp, where a Space may hold Lists
-- directly ("Folderless Lists"). `group_id` is nullable, so every list that
-- exists today keeps working untouched and there is no backfill of guesses.
--
-- FOLDERS DO NOT NEST. There is no `parent_group_id` and there should not be:
-- ClickUp has exactly one folder level, depth past that comes from subtasks, and
-- an arbitrary tree needs a cycle guard, a depth cap and a rule for what a task
-- hanging off a mid-tree node means — three problems bought for a nesting level
-- nobody asked for.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, and paste this file as it stands
-- at that moment. It is written to be re-runnable: every create is guarded, and
-- the backfill at the bottom is idempotent.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The table.
--
-- Deliberately shaped like `vizserve_pms_lists` (P3-01) — same columns, same
-- soft-archive, same per-department name uniqueness. Two sibling levels that
-- behave differently for no reason is how people learn not to trust either.
-- ---------------------------------------------------------------------------
create table if not exists vizserve_pms_task_groups (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references vizserve_pms_departments (id) on delete restrict,
  name          text not null,
  description   text not null default '',
  -- Soft archive, never delete. Same rule as lists: `field_key` immutability and
  -- the no-hard-delete guard exist because history is keyed to these rows.
  is_active     boolean not null default true,
  sort_order    integer not null default 0,

  -- The reserved "Client Requests" folder. One per department, created by
  -- `vizserve_pms_ensure_client_folder` below, and guarded against rename,
  -- archive and delete by a trigger — because everything in it is placed there
  -- automatically and a folder somebody can rename out from under the automation
  -- is a folder the automation will recreate beside it.
  is_system     boolean not null default false,

  created_by    uuid references vizserve_pms_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Unique per department, not globally — two teams may both have a "Retainers"
  -- folder and they are different folders. Same rule as lists.
  constraint vizserve_pms_task_groups_name_per_department unique (department_id, name)
);

create index if not exists vizserve_pms_task_groups_department_idx
  on vizserve_pms_task_groups (department_id, sort_order);

-- EXACTLY ONE system folder per department, enforced rather than assumed. The
-- ensure function below relies on this index for its `on conflict`, so it is not
-- merely a safety net — remove it and the function starts creating duplicates
-- instead of returning the existing row.
create unique index if not exists vizserve_pms_task_groups_one_system_per_department
  on vizserve_pms_task_groups (department_id) where is_system;

drop trigger if exists vizserve_pms_task_groups_updated_at on vizserve_pms_task_groups;
create trigger vizserve_pms_task_groups_updated_at
  before update on vizserve_pms_task_groups
  for each row execute function vizserve_pms_set_updated_at();

alter table vizserve_pms_task_groups enable row level security;
revoke all on vizserve_pms_task_groups from anon;

-- ---------------------------------------------------------------------------
-- Policies — copied from `vizserve_pms_lists` on purpose.
--
-- Readable by anyone who can see the department's work, including members: the
-- sidebar tree is the whole point of this table and a member with an empty tree
-- is a member who goes back to asking in chat where a task lives.
--
-- `vizserve_pms_my_department()` (P7-17) rather than the inline `exists` that
-- the lists policy still carries. It is the same test, it is `stable` so it runs
-- once per statement rather than once per row, and it is SECURITY DEFINER —
-- which matters not at all here (this is not a policy on the users table) but
-- keeps one spelling of "my department" in the codebase instead of two.
-- ---------------------------------------------------------------------------
drop policy if exists "task groups readable in department" on vizserve_pms_task_groups;
create policy "task groups readable in department"
  on vizserve_pms_task_groups for select to authenticated
  using (
    vizserve_pms_manages_department(department_id)
    or department_id = vizserve_pms_my_department()
  );

-- Writable by leads only. A member may now SEE the folder tree (P7-17's rule:
-- a team that cannot see its own board keeps a second board somewhere else) and
-- may not reshape it. Same split as tasks, where P7-17 widened SELECT and
-- deliberately left UPDATE alone.
drop policy if exists "task groups writable by department leads" on vizserve_pms_task_groups;
create policy "task groups writable by department leads"
  on vizserve_pms_task_groups for all to authenticated
  using (vizserve_pms_manages_department(department_id))
  with check (vizserve_pms_manages_department(department_id));

-- No explicit GRANT. `20260729110000_p0_06_grants.sql` set
-- `alter default privileges in schema public grant ... to authenticated`, so a
-- table created here inherits them. That is exactly what those two statements
-- were added for, and it is why this file does not repeat them — a `permission
-- denied for table` after applying this would mean the default privileges have
-- been lost, which is a different bug from anything below.

-- ---------------------------------------------------------------------------
-- Lists learn which folder they are in, and which form they serve.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_lists
  -- `restrict`, not `set null` or `cascade`. Folders are archived, never
  -- deleted, so this should never fire — and if somebody deletes one anyway,
  -- refusing is better than silently emptying a folder's worth of lists into the
  -- folderless pile where nobody is looking for them.
  add column if not exists group_id uuid references vizserve_pms_task_groups (id) on delete restrict,

  -- The list that IS a form's inbox. Null for every ordinary list. This is what
  -- makes the Client Requests folder self-maintaining rather than something
  -- somebody has to remember to keep in step with the forms.
  add column if not exists form_id uuid references vizserve_pms_forms (id) on delete cascade;

create index if not exists vizserve_pms_lists_group_idx
  on vizserve_pms_lists (group_id, sort_order);

-- One list per form. Partial, so the thousands of ordinary lists with a null
-- `form_id` do not collide with each other.
create unique index if not exists vizserve_pms_lists_one_per_form
  on vizserve_pms_lists (form_id) where form_id is not null;

comment on column vizserve_pms_lists.group_id is
  'P7-18. The folder this list sits in. Null is a ClickUp "Folderless List" and is the state of every list created before this migration.';
comment on column vizserve_pms_lists.form_id is
  'P7-18. Set only on the auto-created inbox list for a form, which lives in that department''s reserved Client Requests folder.';

-- ---------------------------------------------------------------------------
-- The rules a CHECK cannot express, because they read another table.
--
-- Three of them, and each has produced a real bug in some other system:
--
--   * a list in a folder belonging to a DIFFERENT department — the list then
--     appears in a tree its own department cannot see
--   * a form's inbox list dragged OUT of the Client Requests folder — the
--     folder stops being the place client work is, which is the only thing it
--     is for
--   * an ordinary list dropped INTO the Client Requests folder — the folder
--     stops meaning "everything here arrived from a form"
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_lists_group_guard()
returns trigger
language plpgsql
as $$
declare
  v_group record;
begin
  if new.group_id is null then
    -- A folderless list is legal (ClickUp's own rule), but a form's inbox list
    -- is not allowed to become one — that is the "dragged out" case above.
    if new.form_id is not null then
      raise exception 'A form''s list belongs in its department''s Client Requests folder and cannot be moved out of it.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  select department_id, is_system, name into v_group
    from vizserve_pms_task_groups
   where id = new.group_id;

  if v_group is null then
    raise exception 'That folder does not exist.' using errcode = 'foreign_key_violation';
  end if;

  if v_group.department_id <> new.department_id then
    raise exception 'That folder belongs to another department.' using errcode = 'check_violation';
  end if;

  if v_group.is_system and new.form_id is null then
    raise exception 'The Client Requests folder holds one list per form, filled automatically. Put this list in another folder.'
      using errcode = 'check_violation';
  end if;

  if not v_group.is_system and new.form_id is not null then
    raise exception 'A form''s list belongs in its department''s Client Requests folder.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_lists_group_guard on vizserve_pms_lists;
create trigger vizserve_pms_lists_group_guard
  before insert or update of group_id, form_id, department_id on vizserve_pms_lists
  for each row execute function vizserve_pms_lists_group_guard();

-- ---------------------------------------------------------------------------
-- The system folder is not editable by hand.
--
-- Everything inside it is placed automatically, so a lead who renames it to
-- "Client Stuff" does not get a renamed folder — they get a renamed folder plus
-- a fresh "Client Requests" the next time a form is created, and two folders
-- where the automation only understands one.
--
-- DELETE is refused rather than cascaded. Archiving is refused too: an inbox
-- nobody can see still receives.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_task_groups_system_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if old.is_system then
      raise exception 'The Client Requests folder is part of how client work is filed and cannot be deleted.'
        using errcode = 'check_violation';
    end if;
    return old;
  end if;

  -- Flipping the flag either way is how somebody would get round every rule
  -- below, so it is refused before the rest are checked.
  if old.is_system <> new.is_system then
    raise exception 'A folder cannot be turned into the Client Requests folder, or out of it.'
      using errcode = 'check_violation';
  end if;

  if old.is_system then
    if new.name <> old.name then
      raise exception 'The Client Requests folder cannot be renamed.' using errcode = 'check_violation';
    end if;

    if new.department_id <> old.department_id then
      raise exception 'The Client Requests folder belongs to its department and cannot be moved.'
        using errcode = 'check_violation';
    end if;

    if old.is_active and not new.is_active then
      raise exception 'The Client Requests folder cannot be archived while forms are filing into it.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_task_groups_system_guard on vizserve_pms_task_groups;
create trigger vizserve_pms_task_groups_system_guard
  before update or delete on vizserve_pms_task_groups
  for each row execute function vizserve_pms_task_groups_system_guard();

-- ---------------------------------------------------------------------------
-- Ensure the department's Client Requests folder exists, and return it.
--
-- SECURITY DEFINER: it is called from the forms trigger, which runs as whoever
-- saved the form — and a team leader creating a form for their own department
-- has no INSERT right on another department's folders. The function decides the
-- department from the form rather than from a parameter the caller controls, so
-- there is nothing here for a caller to widen.
--
-- The sort order is deliberately high. Client work sorts BELOW the folders a
-- team made for itself, so the tree opens on the things people named.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_ensure_client_folder(p_department_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_id uuid;
begin
  if p_department_id is null then
    return null;
  end if;

  -- Inferring the PARTIAL index by restating its predicate. Without the
  -- `where is_system` this matches no index and raises rather than returning the
  -- existing folder.
  --
  -- ⚠️ `DO UPDATE`, NOT `DO NOTHING`, AND THE DIFFERENCE IS A RACE.
  --
  -- `do nothing` returns NO ROW on conflict, so `returning` yields null and the
  -- obvious repair — fall back to a `select` — does not work either: a
  -- concurrent inserter's row is UNCOMMITTED and therefore invisible to that
  -- select. Two team leaders creating a form for the same department at the same
  -- moment would leave `v_folder` null, the list insert below would hit
  -- `lists_group_guard` with a `form_id` and no folder, and THE WHOLE FORM
  -- INSERT would fail with a message about folders.
  --
  -- `do update` takes the row lock instead: it waits for the other transaction,
  -- then returns the row that won. The SET is a deliberate no-op — writing the
  -- name it already has — because `on conflict` has no "do nothing but still
  -- return the row" form and this is the standard way to spell it.
  --
  -- The system guard tolerates this: `new.name <> old.name` is false, and
  -- `is_active` and `department_id` are absent from the SET so they keep their
  -- old values. Do not add columns to that SET without re-reading the guard.
  insert into vizserve_pms_task_groups (department_id, name, description, is_system, sort_order)
  values (
    p_department_id,
    'Client Requests',
    'Work that arrived through a form. One list per form, filled automatically.',
    true,
    1000
  )
  on conflict (department_id) where is_system
    do update set name = excluded.name
  returning id into v_id;

  return v_id;
end;
$$;

grant execute on function vizserve_pms_ensure_client_folder(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Ensure a form has its inbox list, and point the form at it.
--
-- This is what makes the choice coherent with P2-06 instead of fighting it.
-- `forms.default_list_id` already exists and `vizserve_pms_approve_request`
-- already lands an approved request in it — so pointing the form at its own
-- list means CLIENT WORK FILES ITSELF INTO THE RIGHT FOLDER WITH NO CHANGE TO
-- THE APPROVAL PATH AT ALL. Not one line of P2-07 or P2-06 is touched.
--
-- `default_list_id` is only set when it is null. A team leader who has already
-- pointed a form at a list of their own choosing has made a decision, and this
-- migration is not entitled to overrule it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_ensure_form_list(p_form_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_form   record;
  v_folder uuid;
  v_list   uuid;
  v_name   text;
begin
  select id, name, department_id, reference_prefix into v_form
    from vizserve_pms_forms
   where id = p_form_id;

  -- A form with no department cannot route yet (p1_01:29-31 blocks activation
  -- for exactly this reason), so there is nowhere to put its list. The trigger
  -- fires again when a department is set.
  if v_form is null or v_form.department_id is null then
    return null;
  end if;

  v_folder := vizserve_pms_ensure_client_folder(v_form.department_id);

  select id into v_list from vizserve_pms_lists where form_id = p_form_id;

  if v_list is null then
    -- Lists are unique on (department_id, name) and form names are not unique,
    -- so a collision is a question of when. The reference prefix disambiguates
    -- and is already the thing clients quote, which makes it the least
    -- surprising suffix available.
    v_name := v_form.name;

    if exists (
      select 1 from vizserve_pms_lists
       where department_id = v_form.department_id and name = v_name
    ) then
      v_name := v_form.name || ' (' || v_form.reference_prefix || ')';
    end if;

    insert into vizserve_pms_lists (department_id, name, description, group_id, form_id, sort_order)
    values (
      v_form.department_id,
      v_name,
      'Requests submitted through the ' || v_form.name || ' form.',
      v_folder,
      p_form_id,
      0
    )
    returning id into v_list;
  end if;

  update vizserve_pms_forms
     set default_list_id = v_list
   where id = p_form_id and default_list_id is null;

  return v_list;
end;
$$;

grant execute on function vizserve_pms_ensure_form_list(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Keep it in step as forms are created and edited.
--
-- AFTER, not BEFORE: the row has to exist before `ensure_form_list` can read it
-- and before `default_list_id` can be updated on it.
--
-- The department clause is what handles the ordinary case of a form being
-- drafted with no department and given one later, which p1_01 explicitly allows.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_forms_sync_list()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform vizserve_pms_ensure_form_list(new.id);
  return new;
end;
$$;

drop trigger if exists vizserve_pms_forms_sync_list on vizserve_pms_forms;
create trigger vizserve_pms_forms_sync_list
  after insert or update of department_id on vizserve_pms_forms
  for each row execute function vizserve_pms_forms_sync_list();

-- ---------------------------------------------------------------------------
-- Backfill. Idempotent — safe to re-run, and it has to be, because this file is
-- pasted by hand and a paste that dies half way is a paste somebody repeats.
-- ---------------------------------------------------------------------------
do $$
declare
  v_department record;
  v_form       record;
begin
  -- Every active department gets its Client Requests folder now rather than
  -- lazily on the first form, so the tree looks the same everywhere from the
  -- first render.
  for v_department in select id from vizserve_pms_departments where is_active loop
    perform vizserve_pms_ensure_client_folder(v_department.id);
  end loop;

  -- Every form that can route gets its inbox list. Includes inactive forms
  -- deliberately: an archived form still has history, and its requests still
  -- need somewhere to have come from.
  for v_form in select id from vizserve_pms_forms where department_id is not null loop
    perform vizserve_pms_ensure_form_list(v_form.id);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Backfill the tasks that are already sitting in a form's list.
--
-- Nothing to do — and that is worth stating rather than leaving as an absence.
-- A task's folder is derived through `list_id -> group_id`; no column on
-- `vizserve_pms_tasks` changes here, so every existing task keeps exactly the
-- list it had and gains a folder if that list is in one.
--
-- Client tasks approved BEFORE this migration will have whatever `list_id` the
-- team leader chose at the time, which for most is null. They surface under
-- Client Work (`/tasks?kind=client`, which reads `request_id` and has since
-- P3-14) regardless of their list, so none of them is lost — they simply are not
-- in the new folder. Moving them would mean rewriting a lead's deliberate choice
-- of list on work that is finished, which is not a decision a migration gets to
-- make.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE.
--
-- `vizserve_pms_approve_request` — untouched, and that is the whole design. It
-- already lands an approved request in `forms.default_list_id`; this migration
-- only makes sure that column points at a list inside the Client Requests
-- folder. Editing the approval transaction to know about folders would have put
-- a second copy of the routing rule in the one function that must not grow.
--
-- `vizserve_pms_tasks` — no `group_id`. A task's folder is its list's folder,
-- and a task carrying its own would be a second source of truth that disagrees
-- with `list_id` the first time somebody moves a list between folders.
--
-- PERSONAL TASKS (P7-01) get no folder and no list by default. They are a
-- private to-do list, not a project, and P7-17 keeps them out of the
-- department's view entirely — putting them in a shared tree would undo that.
-- ---------------------------------------------------------------------------
