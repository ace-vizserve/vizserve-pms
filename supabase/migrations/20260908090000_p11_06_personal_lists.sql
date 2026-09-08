-- ---------------------------------------------------------------------------
-- P11-06 — a list of your own.
--
-- THE ASK, 8 Sep 2026: a "Personal lists" section in the sidebar, under
-- Projects, where somebody keeps their own tasks.
--
-- Personal TASKS have existed since P7-01 — `is_personal`, and a member records
-- their own work. What has never existed is anywhere to PUT them. Every list in
-- this app belongs to a department, and only a lead or a department admin may
-- make one (P8-01c), so a member's own work landed either in a department list
-- beside client work or in the unfiled pile with `list_id = null`. Neither is a
-- place somebody keeps a to-do list.
--
-- ⚠️ A COLUMN ON `vizserve_pms_lists`, NOT A SECOND TABLE. The tempting shape is
-- `vizserve_pms_personal_lists`, and it is wrong for one decisive reason:
-- `vizserve_pms_tasks.list_id` is a foreign key to ONE table. A second table
-- means a second nullable fk on tasks, of which exactly one may ever be set, and
-- every query that resolves a task's list — the timesheet's "where", the board,
-- the filter panel, `/tasks?list=`, the breadcrumb — grows a branch. One
-- nullable `owner_id` costs two partial indexes and leaves all of that alone.
--
-- ⚠️ NOTHING THAT EXISTS TODAY CHANGES BEHAVIOUR. Every row in the table gets
-- `owner_id = null`, every policy below carries `owner_id is null` on the branch
-- it already had, and the project tree keeps reading exactly what it read
-- before. The whole of this migration is a second, private half bolted beside
-- the department half — not a rewrite of it.
--
-- WHAT A PERSONAL LIST IS, stated once so the constraints below read as one rule:
--
--   owner_id is null      an ordinary department list. Everything that existed
--                         before this migration. Untouched.
--   owner_id is not null  a list belonging to ONE person. Only they see it,
--                         rename it or archive it. It sits in no folder, backs
--                         no form, and holds only their own personal tasks.
--
-- `department_id` STAYS NOT NULL and is the owner's own department. That is not
-- decoration: `vizserve_pms_create_personal_task` already refuses a list outside
-- the caller's department, the timesheet groups by it, and making the column
-- nullable would mean auditing every one of those readers for a null they have
-- never had to consider. A personal list is filed in your department the same
-- way you are.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_lists
  add column owner_id uuid references vizserve_pms_users (id) on delete cascade;

comment on column vizserve_pms_lists.owner_id is
  'P11-06. Null is an ordinary department list. Set means a personal list, '
  'visible and writable only to that one person. Immutable after insert — see '
  'vizserve_pms_lists_owner_guard.';

-- `on delete cascade`, unlike the `set null` on `created_by` beside it. A list
-- whose owner is gone is not an ownerless personal list — under `set null` it
-- would silently become a DEPARTMENT list, published to the whole team, which is
-- the one outcome the person who made it would not have wanted. Deactivating a
-- user does not delete the row, so this fires only on a genuine hard delete.

-- ---------------------------------------------------------------------------
-- Uniqueness, split in two.
--
-- `vizserve_pms_lists_name_per_department` is unique (department_id, name), and
-- it cannot survive as written: three people in VizBytes all calling their list
-- "Personal" is the expected case, not a collision. The department rule still
-- has to hold for department lists, though — two "Collateral" lists in one team
-- is the bug that constraint was written for.
--
-- Two partial indexes rather than one relaxed constraint, so each states the
-- rule that actually applies to its half. The department one keeps its original
-- NAME, so `\d vizserve_pms_lists` still shows the rule people already know.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_lists
  drop constraint vizserve_pms_lists_name_per_department;

create unique index vizserve_pms_lists_name_per_department
  on vizserve_pms_lists (department_id, name)
  where owner_id is null;

create unique index vizserve_pms_lists_name_per_owner
  on vizserve_pms_lists (owner_id, name)
  where owner_id is not null;

-- The sidebar reads one person's personal lists on EVERY page in the app. Small
-- table, but this is the shell.
create index vizserve_pms_lists_owner_idx
  on vizserve_pms_lists (owner_id, sort_order)
  where owner_id is not null;

-- ---------------------------------------------------------------------------
-- What a personal list may not be.
--
-- NO FOLDER: folders are how a DEPARTMENT groups its work (P7-18). They are
-- department-scoped and every one of them is visible to the whole team, so a
-- personal list inside one would be a private row in a public tree — and the
-- sidebar's folder rollups would count work nobody else can open.
--
-- NO FORM: `form_id` marks a form's inbox list, which `default_list_id` points
-- at and which `vizserve_pms_approve_request` files client work into. Client
-- work landing in one person's private list is the P7-24 failure again with
-- invisibility on top.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_lists
  add constraint vizserve_pms_lists_personal_is_loose
  check (owner_id is null or (group_id is null and form_id is null));

-- ---------------------------------------------------------------------------
-- `owner_id` is set once, at insert, and never again.
--
-- Both directions matter and they fail differently:
--
--   null → someone   a department list, with the team's work in it, becomes one
--                    person's private list. Everyone else's tasks disappear from
--                    every tree at once.
--   someone → null   a private list becomes a department list, publishing
--                    whatever was in it to the whole team.
--
-- A CHECK cannot say "did not change", so this is a trigger — the same mechanism
-- `field_key` immutability uses, for the same reason.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_lists_owner_guard()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.owner_id is distinct from old.owner_id then
    raise exception 'A list cannot change hands between a person and a department. Make a new one.'
      using errcode = 'check_violation';
  end if;

  -- A personal list is filed in its owner's own department, and the department
  -- is DERIVED here rather than trusted from the insert. Every downstream reader
  -- scopes on it — including `vizserve_pms_create_personal_task`, which refuses
  -- a list outside the caller's department and would otherwise refuse the
  -- caller's own list if the client had sent the wrong one.
  if new.owner_id is not null then
    select u.primary_department_id into new.department_id
      from vizserve_pms_users u
     where u.id = new.owner_id;

    if new.department_id is null then
      raise exception 'You are not assigned to a department, so there is nowhere to file this.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function vizserve_pms_lists_owner_guard is
  'P11-06. BEFORE INSERT OR UPDATE on vizserve_pms_lists. Freezes owner_id after '
  'insert and derives a personal list''s department from its owner.';

create trigger vizserve_pms_lists_owner_guard
  before insert or update on vizserve_pms_lists
  for each row execute function vizserve_pms_lists_owner_guard();

-- ---------------------------------------------------------------------------
-- RLS — FIVE policies on this table, and FOUR of them let somebody else in.
--
-- ⚠️ COUNT THEM BEFORE EDITING. "Who may touch a list" is spread across four
-- policies written by four migrations, and policies are OR-ed — so adding
-- `owner_id is null` to three of them and missing the fourth publishes every
-- personal list through the one that was missed. The set, as it stands today:
--
--   lists readable in department        p3      select  the whole department
--   lists writable by department leads  p3      all     the lead
--   lists creatable by department admin p8_01c  insert  the Admin tick
--   lists updatable by the department   p11_03  update  ANY ACTIVE MEMBER of it
--
-- The last one is the dangerous one and it is the newest: P11-03 gave every
-- member of a department the right to rename any list in it, on the reasoning
-- that "a list is where a department's work lives". A personal list carries a
-- department, so without the clause below a colleague could rename or archive
-- somebody's private list — and the select policy above it would let them see it
-- to do so.
--
-- Every one is DROPPED AND REWRITTEN rather than added to, because the new
-- clause is an AND on an existing one and `create policy` cannot amend. Each is
-- restated exactly as its own migration left it; the ONLY edit anywhere below is
-- `owner_id is null`.
-- ---------------------------------------------------------------------------
drop policy "lists readable in department" on vizserve_pms_lists;
drop policy "lists writable by department leads" on vizserve_pms_lists;
drop policy if exists "lists creatable by department admin" on vizserve_pms_lists;
drop policy if exists "lists updatable by the department" on vizserve_pms_lists;

create policy "lists readable in department"
  on vizserve_pms_lists for select to authenticated
  using (
    owner_id is null
    and (
      vizserve_pms_manages_department(department_id)
      or exists (
        select 1 from vizserve_pms_users u
         where u.id = auth.uid() and u.is_active and u.primary_department_id = department_id
      )
    )
  );

-- P3-01, unchanged apart from the clause. A lead has no more claim on a member's
-- private list than anybody else does.
create policy "lists writable by department leads"
  on vizserve_pms_lists for all to authenticated
  using (owner_id is null and vizserve_pms_manages_department(department_id))
  with check (owner_id is null and vizserve_pms_manages_department(department_id));

-- P8-01c — the Admin tick creates lists at any rank.
create policy "lists creatable by department admin"
  on vizserve_pms_lists for insert to authenticated
  with check (owner_id is null and vizserve_pms_is_dept_admin(department_id));

-- P11-03 — any active member may rename a list in their own department.
create policy "lists updatable by the department"
  on vizserve_pms_lists for update to authenticated
  using (
    owner_id is null
    and (
      vizserve_pms_is_dept_admin(department_id)
      or exists (
        select 1 from vizserve_pms_users u
         where u.id = auth.uid()
           and u.is_active
           and u.primary_department_id = vizserve_pms_lists.department_id
      )
    )
  )
  with check (
    owner_id is null
    and (
      vizserve_pms_is_dept_admin(department_id)
      or exists (
        select 1 from vizserve_pms_users u
         where u.id = auth.uid()
           and u.is_active
           and u.primary_department_id = vizserve_pms_lists.department_id
      )
    )
  );

-- The fifth policy, and the whole point of the migration: your own lists are
-- yours, at any rank. No `vizserve_pms_manages_department`, no dept-admin tick,
-- no role test of any kind — the only question the policy asks is whether the
-- row is yours.
--
-- `is_active` on the user: a deactivated account keeps its rows and loses its
-- reach, which is the rule every other policy in this schema follows.
create policy "personal lists belong to their owner"
  on vizserve_pms_lists for all to authenticated
  using (
    owner_id = auth.uid()
    and exists (select 1 from vizserve_pms_users u where u.id = auth.uid() and u.is_active)
  )
  with check (
    owner_id = auth.uid()
    and exists (select 1 from vizserve_pms_users u where u.id = auth.uid() and u.is_active)
  );

-- ---------------------------------------------------------------------------
-- The other half: what may be PUT in a personal list.
--
-- A policy on `vizserve_pms_lists` decides who can see the list. It says nothing
-- about `vizserve_pms_tasks.list_id`, which IS inside the column-level UPDATE
-- grant (p7_11a) — so without this, any member could move a department task,
-- somebody else's client work included, into their own private list, and it
-- would vanish from every tree in the department.
--
-- THE RULE: a task may sit in a personal list only if it is that person's own
-- personal task.
--
-- It is enforceable precisely because both columns it reads are unwritable.
-- `is_personal` is outside the UPDATE grant (P7-01) and so is `created_by`
-- (p7_11a) — so neither can be edited into agreement after the fact. The
-- category is decided once, at creation, and this trigger only reads it.
--
-- ⚠️ THIS IS ALSO WHAT PROTECTS THE PICKERS THIS MIGRATION DOES NOT TOUCH. The
-- task detail screen's "move to list" and the form builder's default-list
-- choice both offer whatever the caller can read, which now includes their own
-- personal lists. Choosing one where it does not belong raises the sentence
-- below rather than filing work somewhere invisible.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_tasks_personal_list_guard()
returns trigger
language plpgsql
as $$
declare
  v_owner uuid;
begin
  if new.list_id is null then
    return new;
  end if;

  select l.owner_id into v_owner from vizserve_pms_lists l where l.id = new.list_id;

  -- An ordinary department list, or a list id that does not resolve — the
  -- foreign key answers the second case, and it is not this trigger's job to
  -- duplicate it.
  if v_owner is null then
    return new;
  end if;

  if v_owner is distinct from new.created_by or not new.is_personal then
    raise exception 'A personal list holds only its owner''s own tasks.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function vizserve_pms_tasks_personal_list_guard is
  'P11-06. BEFORE INSERT OR UPDATE OF list_id on vizserve_pms_tasks. Refuses any '
  'task in a personal list that is not that owner''s own personal task.';

create trigger vizserve_pms_tasks_personal_list_guard
  before insert or update of list_id on vizserve_pms_tasks
  for each row execute function vizserve_pms_tasks_personal_list_guard();

-- ---------------------------------------------------------------------------
-- And the third door into a list: a form's default.
--
-- `vizserve_pms_approve_request` files an approved request into
-- `forms.default_list_id`. Point a form at a personal list and every approval
-- through it fails at the trigger above — a client request stuck at Gate 1 with
-- a message about personal lists, which is a mystifying place to meet this rule.
-- Refused at the form instead, where the choice was actually made.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_forms_default_list_guard()
returns trigger
language plpgsql
as $$
begin
  if new.default_list_id is not null and exists (
    select 1 from vizserve_pms_lists l
     where l.id = new.default_list_id and l.owner_id is not null
  ) then
    raise exception 'A form cannot file its requests into somebody''s personal list.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function vizserve_pms_forms_default_list_guard is
  'P11-06. BEFORE INSERT OR UPDATE OF default_list_id on vizserve_pms_forms.';

create trigger vizserve_pms_forms_default_list_guard
  before insert or update of default_list_id on vizserve_pms_forms
  for each row execute function vizserve_pms_forms_default_list_guard();

-- ---------------------------------------------------------------------------
-- `vizserve_pms_create_personal_task` — one clause wider.
--
-- Restated in full rather than patched, because that is the only way a
-- `create or replace` can be read as the whole current definition. Everything
-- here is the P7-11 version byte for byte; the ONLY change is the list check,
-- marked below.
--
-- ⚠️ THE SIGNATURE IS UNCHANGED, so no drop and no re-grant. Widening an applied
-- signature is the trap p7_11a is a monument to.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_create_personal_task(
  p_title       text,
  p_description text default '',
  p_due_date    date default null,
  p_list_id     uuid default null,
  p_priority    vizserve_pms_task_priority default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor      uuid := auth.uid();
  v_user       vizserve_pms_users;
  v_title      text := nullif(btrim(coalesce(p_title, '')), '');
  v_task_id    uuid;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_user from vizserve_pms_users where id = v_actor;

  if v_user.id is null or not v_user.is_active then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  -- Same sentence as the internal-request path, because it is the same problem:
  -- a person with no department has nowhere for their work to be seen by the
  -- lead who is supposed to see it.
  if v_user.primary_department_id is null then
    raise exception 'You are not assigned to a department, so there is nowhere to file this.'
      using errcode = 'check_violation';
  end if;

  if v_title is null then
    raise exception 'A task needs a title.' using errcode = 'check_violation';
  end if;

  -- Lists are department-scoped, and a member can already read the ones in
  -- their own department. Borrowing another department's list would file the
  -- task somewhere its own lead does not look.
  --
  -- ⚠️ P11-06 ADDS THE OWNER CLAUSE, and this function is SECURITY DEFINER — so
  -- RLS is not standing behind it. Without the clause, a colleague's private
  -- list in the same department is a valid destination here, and the id is a
  -- parameter the browser sends. The `is null` half is what keeps every
  -- department list working exactly as before.
  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id
       and l.department_id = v_user.primary_department_id
       and (l.owner_id is null or l.owner_id = v_actor)
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, list_id, created_by, is_personal, priority
  ) values (
    -- No request: this did not come from a form. No QA reviewer: nobody was
    -- asked to review it, and P7-02 is what lets it finish without one.
    null, v_user.primary_department_id, v_title, coalesce(btrim(p_description), ''), 'OPEN',
    v_actor, null, p_due_date, p_list_id, v_actor, true, p_priority
  )
  returning id into v_task_id;

  perform vizserve_pms_write_audit_log(
    'task', v_task_id, 'created', v_actor, null,
    jsonb_build_object('manual', true, 'personal', true, 'title', v_title,
                       'priority', p_priority)
  );

  -- Deliberately no vizserve_pms_notify. `vizserve_pms_create_task` notifies
  -- because it hands work to somebody else; nobody needs telling that they
  -- gave themselves a job.

  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end;
$$;
