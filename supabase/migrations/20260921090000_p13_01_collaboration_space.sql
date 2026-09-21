-- ---------------------------------------------------------------------------
-- P13-01 — COLLABORATION PROJECTS: one space every department shares.
--
-- Amier, 21 Sep 2026: "on the projects can you include Collaboration Projects
-- (All department), so meaning everyone can put task there that can seen all of
-- the users".
--
-- ⚠️ THIS IS A WIDENING, AND THE WIDEST ONE IN THE SCHEMA SO FAR. Every rule
-- below is deliberate; none of it is a refactor. Read the whole header before
-- reviewing the SQL, because the shape of the change is not obvious from any
-- single policy in it.
--
-- ---------------------------------------------------------------------------
-- THE PROBLEM. Everything in this product is scoped by `department_id`, and
-- `department_id` answers exactly one question: WHO DOES THE WORK. VizBytes,
-- VizAssists, VizBooks, VizMedia (D14). That is the right spine for a support
-- queue and it has no way at all to express work that BELONGS TO ALL FOUR — a
-- company-wide campaign, an office move, the annual dinner. Today such a task
-- has to be filed under whichever department typed it, where the other three
-- cannot see it, cannot edit it, and cannot log an hour against it.
--
-- ---------------------------------------------------------------------------
-- THE SHAPE: A DEPARTMENT ROW WITH A FLAG, NOT A NEW KIND OF CONTAINER.
--
-- The tempting alternative is a nullable `department_id` meaning "everyone", or
-- a second column beside it. Both were rejected for the same reason: every
-- policy, function, index, picker and report in this app reads
-- `department_id` as NOT NULL and as the thing that scopes. A null would make
-- each of them wrong in a different way, silently, and the failure mode of "the
-- scoping column is sometimes not a scope" is the one nothing catches.
--
-- So Collaboration Projects IS a department, carrying `is_shared = true`. Every
-- foreign key, every join, every count, every breadcrumb keeps working with no
-- edit at all. What the flag changes is only WHO COUNTS AS A MEMBER of it:
-- everybody active, rather than the people whose `primary_department_id` points
-- at it — which is nobody, and must stay nobody (guard in §2).
--
-- ---------------------------------------------------------------------------
-- WHAT EVERY ACTIVE USER MAY DO IN A SHARED DEPARTMENT. Exactly the set P11-03,
-- P11-05 and P11-07 give a member in their OWN department, and nothing past it:
--
--     see its lists, folders and tasks      §3
--     create a task in it                   §5   (and be assigned one, §5/§7)
--     edit every column in the P11-03 grant §3
--     move a task through the internal      §6
--       transitions
--     log time against a task in it         §4
--     create, rename, archive and delete    §3
--       its lists and folders
--
-- ⚠️ WHAT IT DOES **NOT** CHANGE, and each of these is load-bearing:
--
--   * `vizserve_pms_manages_department` IS UNTOUCHED. Nobody leads the
--     collaboration space. It confers no approval rights, no DTR scope, no
--     timesheet review scope and no place in `departmentScopeFilter`. A shared
--     department is a place to file work, never a queue somebody approves.
--   * PERSONAL LISTS CANNOT EXIST IN IT. `vizserve_pms_lists_owner_guard`
--     derives a personal list's department from its OWNER's own row, and §2
--     forbids anybody's own row from pointing here. So `owner_id` is null on
--     every list in this space, by construction, and every personal-list test
--     downstream keeps answering correctly without being touched.
--   * CLIENT WORK CANNOT LAND HERE. A request's task is filed under the form's
--     department, and no form may be built against a shared one (§3, the forms
--     policy is deliberately NOT widened). Every task in this space is
--     `request_id is null`, so it is 'internal' or 'personal' to
--     `vizserve_pms_transition_task` and moves freely — no Gate 2, no Gate 3,
--     nobody waiting on a reviewer who does not exist.
--   * THE TIMESHEET STILL REVIEWS BY PERSON, NOT BY TASK. The entries policy
--     scopes on the ENTRY OWNER's `primary_department_id`, so an hour logged
--     here still appears to the logger's own lead, exactly as it should. That
--     is why §4 is the only timesheet change in this file.
--
-- ---------------------------------------------------------------------------
-- ⚠️ THE ONE THING THAT GENUINELY GETS BROADER, STATED PLAINLY: any active
-- person may edit, move and re-file any task in this space, including one
-- somebody else created and assigned. That IS the request — a space everyone
-- shares is a space with no owner to ask — but it means the blast radius of a
-- mistake here is the whole company rather than one team.
--
-- `vizserve_pms_audit_row_update` covers it: it is the trigger P11-03 was
-- granted on condition of, and it already fires on `vizserve_pms_tasks` and
-- `vizserve_pms_lists` regardless of department. `status` stays outside the
-- column grant, so every move still goes through §6 and still writes history.
--
-- ---------------------------------------------------------------------------
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, as `postgres`, pasting this file
-- as it stands at that moment. The definer helpers below rest on the owner's
-- RLS exemption — the warning at the top of
-- `20260915100000_p12_14_personal_list_test_runs_once.sql` applies verbatim.
--
-- ⚠️ THE APP SHIPS BEFORE THIS IS PASTED, and it is written to survive that.
-- `resolveAuth` reads the shared set in a SEPARATE query whose failure degrades
-- to an empty set, so between the deploy and the paste the space simply does
-- not exist — no column is named in any select that would be rejected whole.
-- See the note above `loadSharedDepartmentIds` in lib/departments-server.ts.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. THE FLAG, AND THE SPACE.
-- ---------------------------------------------------------------------------

alter table vizserve_pms_departments
  add column if not exists is_shared boolean not null default false;

comment on column vizserve_pms_departments.is_shared is
  'P13-01. A COLLABORATION SPACE rather than a team. Every active user counts as '
  'a member of it for tasks, lists and folders; nobody may have it as their '
  'primary_department_id, and nobody leads it. See the migration header.';

-- Partial, because the answer is "one row" and every reader asks for the true
-- ones. `vizserve_pms_shared_department_ids()` is the only caller that matters
-- and it runs inside policies on the hottest table in the app.
create index if not exists vizserve_pms_departments_shared_idx
  on vizserve_pms_departments (id) where is_shared;

-- Fixed UUID, continuing the P0-02 sequence, so every environment agrees and a
-- fixture can name it without a lookup. `on conflict (name)` matches the seed
-- migration's own idiom — re-pasting this file is a no-op.
--
-- THE NAME IS WHAT AMIER ASKED FOR, verbatim including the parenthetical: it is
-- the heading people will read in the rail, and "(All departments)" is the
-- entire explanation of what the space is. Nothing else on that screen says it.
insert into vizserve_pms_departments (id, name, is_shared) values
  ('a1000000-0000-4000-8000-000000000005', 'Collaboration Projects (All departments)', true)
on conflict (name) do update set is_shared = true;

/*
 * ⚠️ ONE LIST, SEEDED, AND WITHOUT IT THE SPACE IS INVISIBLE ON DAY ONE.
 *
 * `sidebar-panel.tsx` drops a department that holds no lists and no folders —
 * deliberately, because an admin sees every department in the company in that
 * rail and a tree is for navigating to work. That rule is right for a team,
 * which has a lead who will make its first list. It is wrong for this space:
 * nobody owns it, so "somebody will set it up" describes nobody in particular,
 * and until they do, the feature does not appear for anyone.
 *
 * So the space arrives with somewhere to type. The list is ordinary in every
 * other way — renameable, archivable, and not the only one it may hold.
 */
insert into vizserve_pms_lists (id, department_id, name, description, sort_order)
values (
  'b1000000-0000-4000-8000-000000000005',
  'a1000000-0000-4000-8000-000000000005',
  'Company-wide',
  'Work that belongs to everybody rather than to one team. Anyone can add to this.',
  0
)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- 2. NOBODY BELONGS TO IT.
--
-- ⚠️ THIS GUARD IS NOT TIDINESS. `primary_department_id` is what the whole app
-- means by "my team": it decides the DTR a person appears on, whose timesheet
-- week a lead reviews, which department's queue their internal requests enter,
-- and — through `vizserve_pms_lists_owner_guard` — where their PERSONAL lists
-- are filed. Point somebody's own row at a shared department and they fall out
-- of every one of those at once, quietly, with no error anywhere.
--
-- A trigger rather than a check constraint, because the test crosses tables.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_users_shared_department_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.primary_department_id is not null and exists (
    select 1 from vizserve_pms_departments d
     where d.id = new.primary_department_id and d.is_shared
  ) then
    raise exception
      'Collaboration Projects is a shared space, not a team — everybody is already in it. Pick the department this person actually works in.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_users_shared_department_guard on vizserve_pms_users;
create trigger vizserve_pms_users_shared_department_guard
  before insert or update of primary_department_id on vizserve_pms_users
  for each row execute function vizserve_pms_users_shared_department_guard();

comment on function vizserve_pms_users_shared_department_guard() is
  'P13-01. Refuses a shared department as anybody''s primary_department_id. That '
  'column is what every other scope in this app keys on -- see the migration header.';


-- ---------------------------------------------------------------------------
-- 3. THE SET, AND THE POLICIES THAT READ IT.
--
-- ⚠️ A SET-RETURNING DEFINER FUNCTION, NOT AN INLINE `exists`, and it is
-- P12-14's pattern for P12-14's reason. Called as
-- `department_id in (select vizserve_pms_shared_department_ids())` the subquery
-- is UNCORRELATED: Postgres hashes it once per statement and probes it per row,
-- rather than re-running a correlated lookup for every task on every board.
--
-- SECURITY DEFINER is not an optimisation here either. `vizserve_pms_departments`
-- is readable by every signed-in user today, so a plain `stable` function would
-- work — but it would break the moment anybody narrows that table, and it would
-- break by FAILING CLOSED IN A POLICY, which reads as "the collaboration space
-- vanished" rather than as an error.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_shared_department_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select d.id from vizserve_pms_departments d where d.is_shared and d.is_active;
$$;

comment on function vizserve_pms_shared_department_ids() is
  'P13-01. The collaboration spaces. Called from policies as an UNCORRELATED '
  '`in (select ...)` so it is hashed once per statement -- see P12-14.';

/*
 * The same question for plpgsql, where a set is the wrong shape.
 *
 * ⚠️ `is_active` IS TESTED IN BOTH, and it is the off switch. Archiving the
 * department closes the space: nothing new can be filed, and §3's read policies
 * stop admitting it. The rows survive and an owner still reaches them, because
 * every lead clause tests `vizserve_pms_is_admin()` before anything here.
 */
create or replace function vizserve_pms_is_shared_department(p_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(
    (select d.is_shared and d.is_active
       from vizserve_pms_departments d
      where d.id = p_department_id),
    false
  );
$$;

comment on function vizserve_pms_is_shared_department(uuid) is
  'P13-01. True for an ACTIVE collaboration space. The plpgsql-shaped half of '
  'vizserve_pms_shared_department_ids().';

/*
 * "Am I allowed to act in this department at all?"
 *
 * ⚠️ NOT A FIFTH DEFINITION OF "IS THIS PERSON IN THAT DEPARTMENT".
 * `20260908120000_p11_07_department_members_manage_lists.sql` argues at length
 * against extracting one, and it is right — the danger is a helper that answers
 * a SLIGHTLY different question from the inline predicate it replaced, which is
 * the `may_log_time` lesson. This deliberately does not replace anything: every
 * existing predicate below is restated byte for byte, and this is OR-ed beside
 * it. It answers a question no existing function asks — "the caller is active
 * AND this is a shared space" — and it is the only spelling of that question in
 * the schema.
 */
create or replace function vizserve_pms_may_collaborate(p_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select vizserve_pms_is_shared_department(p_department_id)
     and exists (
           select 1 from vizserve_pms_users u
            where u.id = (select auth.uid()) and u.is_active
         );
$$;

comment on function vizserve_pms_may_collaborate(uuid) is
  'P13-01. True when the department is an active collaboration space and the '
  'caller is an active user. The ONLY new predicate this migration introduces; '
  'every other rule below is its own migration''s text, unchanged, with this OR-ed on.';

-- Policy expressions run as the querying role. Without these every query
-- against the tables below reads `permission denied for function` — a GRANT
-- diagnosis, never a policy one (CLAUDE.md).
grant execute on function vizserve_pms_shared_department_ids() to authenticated;
grant execute on function vizserve_pms_is_shared_department(uuid) to authenticated;
grant execute on function vizserve_pms_may_collaborate(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- 3a. TASKS — SELECT.
--
-- Restated from `20260915120000_p12_16_a_shared_list_is_shared.sql` EXACTLY,
-- with one clause added at the end. ⚠️ THE POLICY NAME MUST MATCH CHARACTER FOR
-- CHARACTER: a `drop` that silently matches nothing leaves the old policy alive
-- beside the new one, they are OR-ed, and the result is wider than either was
-- meant to be (p7_17's note, and it is the worse direction here).
--
-- THE NEW CLAUSE IS LAST AND CARRIES NO PERSONAL-LIST TEST. Both are deliberate:
-- last, because it is false for every row in every real department and the three
-- clauses above it are cheaper; no personal-list test, because §2 makes a
-- personal list in a shared department impossible to create.
-- ---------------------------------------------------------------------------
drop policy if exists "tasks readable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    assignee_id = (select auth.uid())
    or qa_assignee_id = (select auth.uid())
    or id in (select vizserve_pms_my_task_ids())
    or (
      (
        (select vizserve_pms_is_admin())
        or (
          (select vizserve_pms_has_role('team_leader'))
          and department_id in (select vizserve_pms_managed_department_ids())
        )
      )
      and (
        list_id is null
        or list_id not in (select vizserve_pms_personal_list_ids())
        or vizserve_pms_task_on_a_timesheet(id)
      )
    )
    or (
      department_id = (select vizserve_pms_my_department())
      and (
        (list_id is not null and list_id not in (select vizserve_pms_personal_list_ids()))
        or (list_id is null and not is_personal)
      )
    )
    or vizserve_pms_is_covering_task(id, (select auth.uid()))

    -- P13-01. The collaboration space, readable by everyone active. Hashed once
    -- per statement and false for every row outside it.
    or department_id in (select vizserve_pms_shared_department_ids())
  );

comment on policy "tasks readable by participants and department leads" on vizserve_pms_tasks is
  'P13-01, on P12-16. Adds the collaboration space: a task in a department flagged '
  '`is_shared` is readable by every signed-in user. Every other clause is P12-16''s, '
  'unchanged. See 20260921090000_p13_01_collaboration_space.sql.';


-- ---------------------------------------------------------------------------
-- 3b. TASKS — UPDATE. P11-03's text, plus the clause.
--
-- ⚠️ `with check` AS WELL AS `using`, and they are not the same question. `using`
-- decides which rows may be opened; `with check` decides what they may become.
-- P11-03's `with check` carries TWO department tests — the row as it was and the
-- row as it will be — which is what stops a task being dragged OUT of a
-- department by rewriting the column. Both need the collaboration clause, or a
-- task could be moved into the shared space and never back out (or vice versa).
-- ---------------------------------------------------------------------------
drop policy if exists "tasks updatable by the department" on vizserve_pms_tasks;

create policy "tasks updatable by the department"
  on vizserve_pms_tasks for update to authenticated
  using (
    vizserve_pms_manages_department(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_tasks.department_id
    )
    or vizserve_pms_may_collaborate(department_id)
  )
  with check (
    vizserve_pms_manages_department(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_tasks.department_id
    )
    or vizserve_pms_may_collaborate(department_id)
  );


-- ---------------------------------------------------------------------------
-- 3c. LISTS.
--
-- All four policies, each restated from the migration that last wrote it:
-- SELECT and the lead's `for all` from p11_06, INSERT/UPDATE/DELETE from p11_07
-- and p11_03.
--
-- ⚠️ `owner_id is null` STAYS ON THE READ, and it is not redundant with §2. §2
-- makes a personal list in a shared department impossible; this clause is what
-- keeps every OTHER department's personal lists out of the tree, and it is
-- p11_06's, not this migration's, so it is restated rather than reasoned about.
-- ---------------------------------------------------------------------------
drop policy if exists "lists readable in department" on vizserve_pms_lists;

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
      or vizserve_pms_may_collaborate(department_id)
    )
  );

drop policy if exists "lists creatable by the department" on vizserve_pms_lists;

create policy "lists creatable by the department"
  on vizserve_pms_lists for insert to authenticated
  with check (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_lists.department_id
    )
    -- P13-01. `owner_id` is NOT excluded here, because
    -- `vizserve_pms_lists_owner_guard` already derives a personal list's
    -- department from its owner's own row — and §2 forbids that row from
    -- pointing at a shared department. The guard refuses before this is reached.
    or vizserve_pms_may_collaborate(department_id)
  );

drop policy if exists "lists updatable by the department" on vizserve_pms_lists;

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
      or vizserve_pms_may_collaborate(department_id)
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
      or vizserve_pms_may_collaborate(department_id)
    )
  );

drop policy if exists "lists deletable by the department" on vizserve_pms_lists;

create policy "lists deletable by the department"
  on vizserve_pms_lists for delete to authenticated
  using (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_lists.department_id
    )
    or (owner_id is null and vizserve_pms_may_collaborate(department_id))
  );


-- ---------------------------------------------------------------------------
-- 3d. FOLDERS. p7_18's SELECT, p11_07's three writes.
-- ---------------------------------------------------------------------------
drop policy if exists "task groups readable in department" on vizserve_pms_task_groups;

create policy "task groups readable in department"
  on vizserve_pms_task_groups for select to authenticated
  using (
    vizserve_pms_manages_department(department_id)
    or department_id = vizserve_pms_my_department()
    or vizserve_pms_may_collaborate(department_id)
  );

drop policy if exists "task groups creatable by the department" on vizserve_pms_task_groups;

create policy "task groups creatable by the department"
  on vizserve_pms_task_groups for insert to authenticated
  with check (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_task_groups.department_id
    )
    or vizserve_pms_may_collaborate(department_id)
  );

drop policy if exists "task groups editable by the department" on vizserve_pms_task_groups;

create policy "task groups editable by the department"
  on vizserve_pms_task_groups for update to authenticated
  using (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_task_groups.department_id
    )
    or vizserve_pms_may_collaborate(department_id)
  )
  with check (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_task_groups.department_id
    )
    or vizserve_pms_may_collaborate(department_id)
  );

drop policy if exists "task groups deletable by the department" on vizserve_pms_task_groups;

create policy "task groups deletable by the department"
  on vizserve_pms_task_groups for delete to authenticated
  using (
    vizserve_pms_is_dept_admin(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid()
         and u.is_active
         and u.primary_department_id = vizserve_pms_task_groups.department_id
    )
    or vizserve_pms_may_collaborate(department_id)
  );


-- ---------------------------------------------------------------------------
-- 4. TIME.
--
-- ⚠️ THE FOURTH DEFINITION OF `vizserve_pms_may_log_time` BECOMES THE FIFTH, and
-- `20260907130000_p11_04_log_time_follows_editing.sql` opens with a warning
-- about exactly that. It is unavoidable — `create or replace` is the only way to
-- change a function every policy calls by name — so the rule that migration
-- states is what matters and it is preserved here: THIS SET MUST EQUAL THE SET
-- THAT MAY EDIT THE TASK (§3b). It does: the third clause below is the same
-- predicate, spelled for an explicit `p_user_id`.
--
-- ⚠️ `p_user_id`, NOT `auth.uid()`, IN THE NEW CLAUSE. `vizserve_pms_may_collaborate`
-- asks about the CALLER, and this function takes the person as an argument —
-- p11_04 records that trap against `vizserve_pms_manages_department` and it is
-- the same one. Every caller passes `auth.uid()` today; a function that ignores
-- its own argument is a trap set for whoever does not.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_may_log_time(p_task_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select vizserve_pms_is_on_task(p_task_id, p_user_id)

  or exists (
    select 1
      from vizserve_pms_tasks t
      join vizserve_pms_users u on u.id = p_user_id
     where t.id = p_task_id
       and u.is_active
       and u.primary_department_id = t.department_id
  )

  or exists (
    select 1
      from vizserve_pms_tasks t
      join vizserve_pms_user_managed_departments m
        on m.department_id = t.department_id
       and m.user_id = p_user_id
     where t.id = p_task_id
  )

  -- P13-01. An hour spent on shared work is an hour, and it belongs on the
  -- logger's own week — which their own lead reviews, because the entries
  -- policy scopes on the ENTRY OWNER's department and not on the task's.
  or exists (
    select 1
      from vizserve_pms_tasks t
      join vizserve_pms_users u on u.id = p_user_id
     where t.id = p_task_id
       and u.is_active
       and vizserve_pms_is_shared_department(t.department_id)
  );
$$;

grant execute on function vizserve_pms_may_log_time(uuid, uuid) to authenticated;

comment on function vizserve_pms_may_log_time(uuid, uuid) is
  'P13-01, on P11-04. Who may record hours against a task: anyone on it, any active '
  'member of its department, a lead of that department, or ANY active user when the '
  'task sits in a collaboration space. Deliberately the same set that may EDIT the '
  'task -- see p11_03 and section 3b of p13_01.';


-- ---------------------------------------------------------------------------
-- 5. CREATING WORK IN THE SPACE.
--
-- Three changes to `vizserve_pms_create_task`, and the last two are what make
-- the feature mean anything:
--
--   0. THE LIST DECIDES, when the list is a shared one. Every caller in the app
--      derives the department from the PERSON — the assignee's own row, or the
--      caller's — because until now that was the only thing that could decide
--      it. Standing in a collaboration list and pressing New task, that answer
--      is wrong in a way the old code could only report as an error: the task
--      would be filed under VizBytes with a list belonging to Collaboration
--      Projects, which `p_list_id`'s own check refuses AFTER the form has been
--      filled in.
--
--      ⚠️ DONE HERE RATHER THAN IN THE THREE CALLERS THAT BUILD THIS PAYLOAD.
--      `quickAddTask`'s own comments record that there are three copies of it
--      and that two of them were right — a rule that has to be re-implemented
--      per call site is a rule that will be missing from one of them. This is
--      the one place every path goes through.
--
--      It cannot be used to smuggle a task anywhere: the ONLY department it can
--      choose is one that is already shared, which is precisely the department
--      anybody may file into anyway (change 1). `vizserve_pms_create_personal_task`
--      does the same thing for the same reason — see §5a.
--
--   1. WHERE. A member may file into their own department or one they lead
--      (P7-14). Now also into a shared space.
--   2. WHO. The assignee test demands an active member of `p_department_id`.
--      Nobody's `primary_department_id` is the shared space and §2 guarantees it
--      never will be — so WITHOUT THIS CHANGE NO TASK IN THE COLLABORATION SPACE
--      COULD EVER BE ASSIGNED TO ANYBODY. In a shared space the test becomes
--      "an active user", which is the whole point: cross-department work needs
--      to be handed to the person doing it, whichever team they are on.
--
-- Everything else is p7_14's text, unchanged — including the list check, which
-- still demands the list belong to the department the task is being filed under
-- and therefore still refuses a team's task in another team's list.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_create_task(
  p_department_id  uuid,
  p_title          text,
  p_description    text default '',
  p_assignee_id    uuid default null,
  p_qa_assignee_id uuid default null,
  p_due_date       date default null,
  p_list_id        uuid default null,
  p_priority       vizserve_pms_task_priority default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor   uuid := auth.uid();
  v_title   text := nullif(btrim(coalesce(p_title, '')), '');
  v_task_id uuid;
  v_mine    uuid;
  v_shared  boolean;
  v_dept    uuid := p_department_id;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- The caller's own department, from their own row. Not a parameter, and that
  -- is the whole guard: a member cannot ASK to create somewhere else.
  select u.primary_department_id into v_mine
    from vizserve_pms_users u
   where u.id = v_actor and u.is_active;

  /*
   * P13-01, CHANGE 0 — THE LIST DECIDES, IF THE LIST IS A SHARED ONE.
   *
   * ⚠️ THIS OVERRIDES A PARAMETER THE CALLER SENT, which is the kind of thing
   * that deserves suspicion. It cannot widen anything: the only value it can
   * write is the id of a department that is ALREADY shared, and change 1 below
   * admits every active user into exactly those. A caller who passes a
   * collaboration list is asking for a collaboration task; this is what stops
   * that arriving as "That list belongs to another department." after the form
   * has been filled in. Every other department leaves `v_dept` alone.
   *
   * ⚠️ FIRST, BEFORE THE SCOPE CHECK, so the check below judges the department
   * the task will ACTUALLY be filed under and not the one that was proposed.
   */
  if p_list_id is not null then
    select l.department_id into v_dept
      from vizserve_pms_lists l
     where l.id = p_list_id
       and vizserve_pms_is_shared_department(l.department_id);

    v_dept := coalesce(v_dept, p_department_id);
  end if;

  -- Read once and reused three times below, because it is two table lookups
  -- otherwise and this runs on every task anybody creates.
  v_shared := vizserve_pms_may_collaborate(v_dept);

  -- P7-14. A lead may file into any department they lead; anyone else may file
  -- into their own and nowhere else. P13-01 adds: and anybody active may file
  -- into a collaboration space.
  if not (
    coalesce(vizserve_pms_manages_department(v_dept), false)
    or (v_mine is not null and v_dept = v_mine)
    or v_shared
  ) then
    raise exception 'That department is outside your scope.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_title is null then
    raise exception 'A task needs a title.' using errcode = 'check_violation';
  end if;

  -- Same rule as the approval path: work belongs to the department doing it, or
  -- someone ends up holding a task their own TL cannot see. This is also what
  -- stops a member assigning ACROSS departments now that they may assign at all.
  --
  -- ⚠️ P13-01 — AND A COLLABORATION SPACE IS THE EXCEPTION THAT PROVES IT. The
  -- reason above is "their own TL cannot see it"; in a shared space every TL can
  -- see it, because §3a admits everybody. So the department test relaxes to an
  -- activity test, and only there.
  if p_assignee_id is not null and not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_assignee_id
       and u.is_active
       and (v_shared or u.primary_department_id = v_dept)
  ) then
    raise exception 'That assignee is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id and l.department_id = v_dept
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, list_id, created_by, priority
  ) values (
    null, v_dept, v_title, coalesce(btrim(p_description), ''), 'OPEN',
    p_assignee_id, p_qa_assignee_id, p_due_date, p_list_id, v_actor, p_priority
  )
  returning id into v_task_id;

  perform vizserve_pms_write_audit_log(
    'task', v_task_id, 'created', v_actor, null,
    jsonb_build_object(
      'manual', true, 'title', v_title, 'assignee_id', p_assignee_id,
      'priority', p_priority
    )
  );

  if p_assignee_id is not null and p_assignee_id <> v_actor then
    perform vizserve_pms_notify(
      p_assignee_id, 'assigned', 'Assigned to you: ' || v_title,
      coalesce(btrim(p_description), ''), 'task', v_task_id, '/tasks/' || v_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end;
$$;


-- ---------------------------------------------------------------------------
-- 5a. `vizserve_pms_create_personal_task`, AND WHY THE DEPARTMENT MOVES.
--
-- ⚠️ THE SUBTLE ONE IN THIS FILE. This function files the task under the
-- CALLER'S OWN department, always. That is correct for personal work and it is
-- wrong the moment somebody types a line into a collaboration list: the task
-- would be filed under VizBytes while sitting in a list under Collaboration
-- Projects — visible to VizBytes, invisible to everybody else, in a list nobody
-- else's tree can explain. `vizserve_pms_create_task`'s own list check refuses
-- exactly that mismatch; this function's did not, because until now the two
-- could not disagree.
--
-- So: THE LIST DECIDES. If the chosen list lives in a shared space, the task is
-- filed there. Everything else is p11_06's text.
--
-- `is_personal` STAYS TRUE on such a task and that is deliberate — it records
-- WHO TYPED IT AND FOR WHOM (P12-16's header), never privacy. §3a admits the row
-- to everyone on the department clause without consulting the flag.
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
  v_department uuid;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_user from vizserve_pms_users where id = v_actor;

  if v_user.id is null or not v_user.is_active then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  if v_user.primary_department_id is null then
    raise exception 'You are not assigned to a department, so there is nowhere to file this.'
      using errcode = 'check_violation';
  end if;

  if v_title is null then
    raise exception 'A task needs a title.' using errcode = 'check_violation';
  end if;

  v_department := v_user.primary_department_id;

  -- P13-01 — the list decides, when the list is a shared one. Read before the
  -- check below so that check tests the department the task will ACTUALLY be
  -- filed under.
  if p_list_id is not null then
    select l.department_id into v_department
      from vizserve_pms_lists l
     where l.id = p_list_id
       and vizserve_pms_is_shared_department(l.department_id);

    v_department := coalesce(v_department, v_user.primary_department_id);
  end if;

  -- Lists are department-scoped, and a member can already read the ones in
  -- their own department. Borrowing another department's list would file the
  -- task somewhere its own lead does not look.
  --
  -- ⚠️ P11-06 ADDS THE OWNER CLAUSE, and this function is SECURITY DEFINER — so
  -- RLS is not standing behind it. Without the clause, a colleague's private
  -- list in the same department is a valid destination here, and the id is a
  -- parameter the browser sends.
  --
  -- ⚠️ P13-01 TESTS `v_department` RATHER THAN THE CALLER'S. For every ordinary
  -- list the two are the same value and this is character-for-character the old
  -- rule; for a collaboration list it is the branch above that already proved
  -- the list is shared, so this re-states it rather than widening it.
  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id
       and l.department_id = v_department
       and (l.owner_id is null or l.owner_id = v_actor)
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, list_id, created_by, is_personal, priority
  ) values (
    null, v_department, v_title, coalesce(btrim(p_description), ''), 'OPEN',
    v_actor, null, p_due_date, p_list_id, v_actor, true, p_priority
  )
  returning id into v_task_id;

  perform vizserve_pms_write_audit_log(
    'task', v_task_id, 'created', v_actor, null,
    jsonb_build_object('manual', true, 'personal', true, 'title', v_title,
                       'priority', p_priority)
  );

  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. MOVING WORK IN THE SPACE.
--
-- ⚠️ A FULL RESTATEMENT OF `vizserve_pms_transition_task` FROM
-- `20260908101000_p11_05_department_members_move_tasks.sql`, TO CHANGE ONE
-- ASSIGNMENT. plpgsql has no partial replace and this function is the only way
-- a status moves at all, so the choice is between restating it and not touching
-- it. DIFF THE BODY BELOW AGAINST p11_05 RATHER THAN READING IT FRESH: the only
-- intended difference is the `v_in_dept` clause, which is marked where it sits.
--
-- ⚠️ IF A LATER MIGRATION HAS ALREADY REWRITTEN THIS FUNCTION, APPLYING THIS
-- FILE SILENTLY REVERTS IT. Check `df+ vizserve_pms_transition_task` against
-- p11_05 before pasting. Nothing in the database can catch that for you.
--
-- ⚠️ THE QA SEAT IS UNTOUCHED, exactly as P11-05 left it - and in this space
-- it is moot rather than merely preserved. Every task here has
-- `request_id is null`, so `v_category` is 'internal' or 'personal' and the
-- function never reaches the transition table. Gate 2 and Gate 3 belong to
-- client work, and client work cannot be filed here (see the header).
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_transition_task(
  p_task_id   uuid,
  p_to_status vizserve_pms_task_status,
  p_comment   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task       vizserve_pms_tasks;
  v_rule       vizserve_pms_task_transitions;
  v_actor      uuid := auth.uid();
  v_comment    text := nullif(btrim(coalesce(p_comment, '')), '');
  v_is_pic     boolean;
  v_is_qa      boolean;
  v_leads      boolean;
  v_in_dept    boolean;
  v_category   text;
  v_reference  text;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- P7-00, carried forward for the third time. An unset seat is "not you",
  -- never "unknown".
  --
  -- P7-13: `v_is_pic` now admits anyone on the task, not just the accountable
  -- name. `vizserve_pms_is_on_task` also returns true for the QA reviewer, so
  -- the explicit `assignee_id` test is kept alongside it for readability rather
  -- than necessity — and `v_is_qa` stays a SEPARATE test, because the QA gate
  -- below must not be satisfiable by being on the task.
  v_is_pic := coalesce(v_task.assignee_id = v_actor, false)
              or coalesce(
                   exists (
                     select 1 from vizserve_pms_task_assignees a
                      where a.task_id = p_task_id and a.user_id = v_actor
                   ),
                   false
                 );
  v_is_qa  := coalesce(v_task.qa_assignee_id = v_actor, false);
  v_leads  := coalesce(vizserve_pms_manages_department(v_task.department_id), false);

  -- P11-05 — AN ACTIVE MEMBER OF THIS TASK'S DEPARTMENT.
  --
  -- The same test P11-03 used to open editing: `primary_department_id`, not a
  -- membership table, because that is what this schema means by "a member of a
  -- department" everywhere else.
  v_in_dept := coalesce(
                 exists (
                   select 1 from vizserve_pms_users u
                    where u.id = v_actor
                      and u.is_active
                      and u.primary_department_id = v_task.department_id
                 ),
                 false
               )
               -- P13-01 - THE ONE LINE THIS FILE CHANGES IN THIS FUNCTION.
               -- A collaboration space has no members of its own: nobody's
               -- primary_department_id points at it, and section 2 makes sure
               -- nobody's ever will. So the predicate above is false for EVERY
               -- person on EVERY task in the space, and without this nobody
               -- could move a card in it at all - not the person who created
               -- it, not the person it is assigned to.
               or coalesce(vizserve_pms_may_collaborate(v_task.department_id), false);

  -- The same three-way split the TypeScript mirror computes in `taskCategory`.
  -- A request wins over the personal flag: a task with a client behind it is
  -- client work whatever else is set on it.
  v_category := case
                  when v_task.request_id is not null then 'request'
                  when v_task.is_personal            then 'personal'
                  else 'internal'
                end;

  -- P11-05 — REVERSED. This read: "Being able to SEE a task is not being able
  -- to move it. A member of the department who is neither PIC nor QA has no
  -- business advancing it."
  --
  -- That is the same argument P7-14 made about editing, and it was answered the
  -- same way on 7 Sep: a task belongs to its DEPARTMENT, not to its PIC. A
  -- colleague who has just finished the work should mark it finished, not go
  -- and find whoever the task is filed under. P11-03 opened every other column
  -- on the row; leaving `status` behind made the one field people change most
  -- the only one still asking permission.
  --
  -- ⚠️ WHAT DID NOT CHANGE, and neither is a detail:
  --
  --   1. `status` STAYS OUTSIDE THE COLUMN UPDATE GRANT. This function is
  --      still the only way a status moves at all, so every move is checked
  --      against the transition table and every move writes history. Opening
  --      the grant instead would let any member set any status directly and
  --      skip the state machine entirely — that is not "a member may move a
  --      task", it is "there are no gates".
  --   2. THE QA SEAT BELOW IS UNTOUCHED. A department member still cannot pass
  --      work through Gate 2, because they are a member of their own
  --      department and that would mean everyone QAs their own work. The gate
  --      is the feature.
  if not (v_is_pic or v_is_qa or v_leads or v_in_dept) then
    raise exception 'That task is not yours to move.' using errcode = 'insufficient_privilege';
  end if;

  if v_task.status = p_to_status then
    raise exception 'That task is already %.', p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  -- ==========================================================================
  -- INTERNAL WORK MOVES FREELY. CLIENT WORK DOES NOT.
  --
  -- This is the distinction the slice is about, and it is where an internal
  -- task stops being a client ticket with fewer gates and becomes a different
  -- thing: a board card people drag about, which is what the team already does
  -- in ClickUp all day.
  --
  -- Every gate in the pipeline has somebody OUTSIDE THE COMPANY on the other
  -- end: a resolution before review, a reviewer before the client, the client
  -- before it is done. None of that applies to "read the brand guidelines" or
  -- "chase the supplier". P7-06 already conceded the point by adding five
  -- internal-only rows to the transition table, and that was the half measure —
  -- it still meant predicting, in a migration, every way a person might want to
  -- move their own work.
  --
  -- So for work with no client there is NO TABLE LOOKUP AT ALL. Any status to
  -- any status, no required fields, by anyone on the task or leading the
  -- department.
  --
  -- WHAT STAYS TRUE EVEN HERE, and neither is negotiable:
  --
  --   1. FOR_CLIENT_APPROVAL stays unreachable. That is not strictness, it is
  --      arithmetic: `vizserve_pms_issue_approval_token` raises "That task has
  --      no client to approve it", so a task parked there has no legal way out
  --      and no way to finish. Freedom to strand your own work is not freedom.
  --   2. EVERY MOVE STILL WRITES HISTORY. The insert below sits outside this
  --      branch. Free movement means no gates; it has never meant no record,
  --      and `status` stays outside the column UPDATE grant, so this function
  --      remains the only way a status changes at all.
  -- ==========================================================================
  if v_category <> 'request' then
    if p_to_status = 'FOR_CLIENT_APPROVAL' then
      raise exception 'There is no client to approve this one. It finishes here.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- Nothing further to ask. The ownership check above already established
    -- that the caller is on this task or leads its department.

  else
    -- ---- client work: the table is the authority, exactly as before --------
    select * into v_rule
      from vizserve_pms_task_transitions
     where from_status = v_task.status and to_status = p_to_status;

    -- Every illegal transition rejected server-side, by construction: if it is
    -- not in the table it does not happen.
    if v_rule.to_status is null then
      raise exception 'A task cannot go from % to %.', v_task.status, p_to_status
        using errcode = 'invalid_parameter_value';
    end if;

    -- A rule written for work WITHOUT a client cannot be borrowed by work with
    -- one. This is what stops a client task using P7-02's
    -- `QA_IN_PROGRESS -> COMPLETED` to skip Gate 3 entirely.
    if v_rule.applies_to in ('internal', 'personal') then
      raise exception 'This has a client behind it — it finishes when they sign off, not here.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- Who may make THIS move. A TL leading the department may act in either
    -- seat (they are frequently the QA), but a member cannot QA their own work
    -- by moving it past the gate themselves.
    --
    -- P11-05: the PIC seat admits the department. The QA seat does NOT, and the
    -- sentence above is exactly why — open it and every member could pass
    -- their own work through Gate 2, which is the one thing this gate exists to
    -- prevent. Gate 3 is a client with an emailed token and was never reachable
    -- from here at all.
    if v_rule.actor = 'pic' and not (v_is_pic or v_leads or v_in_dept) then
      raise exception 'Only the person in charge can do that.'
        using errcode = 'insufficient_privilege';
    end if;

    if v_rule.actor = 'qa' and not (v_is_qa or v_leads) then
      raise exception 'Only the QA reviewer can do that.'
        using errcode = 'insufficient_privilege';
    end if;

    -- The client and system rows belong to Phase 4. Until then only an admin
    -- may exercise them, which is what makes them testable now without a token.
    if v_rule.actor in ('client', 'system') and not vizserve_pms_is_admin() then
      raise exception 'That transition is made by the client, not from here.'
        using errcode = 'insufficient_privilege';
    end if;

    -- --- the gates ----------------------------------------------------------
    if v_rule.required_field = 'resolution'
       and (v_task.resolution is null or length(btrim(v_task.resolution)) = 0) then
      raise exception 'Record what you did in the resolution before sending this for QA.'
        using errcode = 'check_violation';
    end if;

    if v_rule.required_field = 'comment' and v_comment is null then
      raise exception 'A comment is required for that.' using errcode = 'check_violation';
    end if;
  end if;

  update vizserve_pms_tasks set status = p_to_status where id = p_task_id;

  insert into vizserve_pms_task_status_history
    (task_id, from_status, to_status, actor_id, comment, is_override)
  values
    (p_task_id, v_task.status, p_to_status, v_actor, v_comment, false);

  select r.reference_no into v_reference
    from vizserve_pms_requests r where r.id = v_task.request_id;

  -- --- notifications --------------------------------------------------------
  -- Only where somebody has to act. Ordinary status movement is inbox-only
  -- (docs/12 §3) and this is where that budget is actually spent.
  if p_to_status = 'FOR_QA' and v_task.qa_assignee_id is not null then
    perform vizserve_pms_notify(
      v_task.qa_assignee_id, 'qa_requested',
      'Ready for QA: ' || coalesce(v_reference, v_task.title),
      v_task.title, 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  -- QA sent it back. The PIC is the one who has to do something about it, and
  -- the comment travels with the notification so they do not have to go looking.
  if v_task.status = 'QA_IN_PROGRESS' and p_to_status = 'ONGOING'
     and v_task.assignee_id is not null then
    perform vizserve_pms_notify(
      v_task.assignee_id, 'status_changed',
      'QA sent back: ' || coalesce(v_reference, v_task.title),
      coalesce(v_comment, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'status', p_to_status);
end;
$$;


-- ---------------------------------------------------------------------------
-- 7. PUTTING A SECOND PERSON ON SHARED WORK.
--
-- `vizserve_pms_add_task_assignee` has the same two tests
-- `vizserve_pms_create_task` had, and the second one fails the same way: the
-- person being ADDED must be an active member of the task's department, and
-- nobody is a member of a shared one. Without this, a collaboration task could
-- have no second assignee at all — which is the one feature a cross-department
-- space exists for.
--
-- `remove` takes only the actor half: who may be REMOVED is not a department
-- question, and p11_06's own body has no such test on `p_user_id`.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_add_task_assignee(p_task_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor  uuid := auth.uid();
  v_task   vizserve_pms_tasks;
  v_shared boolean;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  v_shared := coalesce(vizserve_pms_may_collaborate(v_task.department_id), false);

  -- P11-06 — the department may put people on its own work. P13-01 — and
  -- everybody may put people on shared work.
  if not (
    coalesce(vizserve_pms_is_on_task(p_task_id, v_actor), false)
    or coalesce(vizserve_pms_manages_department(v_task.department_id), false)
    or coalesce(
         exists (
           select 1 from vizserve_pms_users u
            where u.id = v_actor
              and u.is_active
              and u.primary_department_id = v_task.department_id
         ),
         false
       )
    or v_shared
  ) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  -- ⚠️ P13-01 relaxes the DEPARTMENT half and keeps the ACTIVITY half. Same
  -- reasoning as `vizserve_pms_create_task`: the rule exists so nobody ends up
  -- holding work their own lead cannot see, and in a shared space every lead
  -- can see it.
  if not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_user_id
       and u.is_active
       and (v_shared or u.primary_department_id = v_task.department_id)
  ) then
    raise exception 'That person is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  values (p_task_id, p_user_id, v_actor)
  on conflict (task_id, user_id) do nothing;

  if p_user_id <> v_actor then
    perform vizserve_pms_notify(
      p_user_id, 'assigned', 'Added to: ' || v_task.title,
      coalesce(v_task.description, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true);
end;
$$;


-- ---------------------------------------------------------------------------
-- 8. @ MENTIONS IN THE SPACE.
--
-- Amier, 21 Sep, on top of the original ask: "under the collab project everyone
-- can be mention and everyone can see this and everyone can add also".
--
-- P7-71's roster asks two questions and BOTH answered "nobody" for a
-- collaboration task, for the same reason everything else in this file did:
-- they test `primary_department_id`, and nobody's points at the shared space.
--
--   `vizserve_pms_task_mention_candidates`  WHO may be mentioned. Its clause 3
--       is "in the task's department", so the roster held only the handful of
--       people already named ON the task plus whoever the actor could reach
--       anyway. A new clause 6 admits everybody active when the task is shared.
--
--   `vizserve_pms_mentionable_for_task`     WHETHER the caller gets a roster at
--       all. Its guard is a deliberately NARROW subset of the task SELECT
--       policy (read that migration's note before touching it) and it returns
--       EMPTY rather than raising — so a member typing `@` on a company-wide
--       task saw "No one to mention here" on a task they could edit, move and
--       log time against. One clause, matching §3b.
--
-- ⚠️ BOTH FULLY RESTATED FROM p7_71, for the reason §6 gives: plpgsql and sql
-- functions have no partial replace. DIFF THEM AGAINST THAT FILE — the only
-- intended differences are the two clauses, and each is marked where it sits.
--
-- ⚠️ `vizserve_pms_notify_task_comment` IS NOT RESTATED AND DOES NOT NEED TO BE.
-- It calls `vizserve_pms_task_mention_candidates` by name to decide who a
-- mention may notify, so it picks the new clause up on its own — which is also
-- why the WHO function had to be the one widened, rather than only the picker:
-- a name the picker offered but the trigger rejected would be a mention that
-- silently notified nobody.
--
-- ⚠️ NO GRANT ON THE CANDIDATE FUNCTION. p7_71 revokes it from
-- `public, anon, authenticated` on purpose — it answers about an ARBITRARY
-- actor, so it is reachable only from the definer wrapper that checks the
-- caller and from the notify trigger, which has no caller. `create or replace`
-- preserves existing privileges, so that revoke still stands after this file
-- and must not be "restored".
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_task_mention_candidates(
  p_task_id  uuid,
  p_actor_id uuid
)
returns table (id uuid, full_name text)
language sql
stable
security definer
set search_path = public, extensions
as $fn$
  select u.id, u.full_name
    from vizserve_pms_users u
   where u.is_active
     and (
       -- A. in range of the task
       exists (
         select 1
           from vizserve_pms_tasks t
          where t.id = p_task_id
            and (
              -- 1. on the task by name
              u.id = t.assignee_id
              or u.id = t.qa_assignee_id

              -- 2. on the task by the join table (P7-13)
              or exists (
                select 1 from vizserve_pms_task_assignees a
                 where a.task_id = t.id and a.user_id = u.id
              )

              -- 3. in the task's department (P11-03)
              or (
                t.department_id is not null
                and u.primary_department_id = t.department_id
              )

              -- 4. managing the task's department. Spelled out rather than
              --    calling vizserve_pms_manages_department, which answers about
              --    `auth.uid()` and this asks about `u`.
              or u.role >= 'admin'
              or (
                u.role >= 'team_leader'
                and t.department_id is not null
                and exists (
                  select 1 from vizserve_pms_user_managed_departments md
                   where md.user_id = u.id
                     and md.department_id = t.department_id
                )
              )

              -- 6. P13-01 - THE TASK IS IN A COLLABORATION SPACE, so everybody
              --    active is in range of it. Clause 3 above asks
              --    `u.primary_department_id = t.department_id`, and nobody's
              --    primary department is the shared space (section 2) - so
              --    without this the roster for a company-wide task held only
              --    the people already named on it, and `@` in the one place
              --    built for working across teams offered almost nobody.
              or vizserve_pms_is_shared_department(t.department_id)
            )
       )

       -- B. 5. within the actor's reach — the three general clauses of the
       --       users SELECT policy, asked about `p_actor_id` rather than about
       --       `auth.uid()`. An inactive actor reaches nobody, which is the
       --       same gate `vizserve_pms_current_role` applies.
       or exists (
         select 1
           from vizserve_pms_users actor
          where actor.id = p_actor_id
            and actor.is_active
            and (
              -- an admin or owner sees everybody, so may address everybody
              actor.role >= 'admin'

              -- your own team
              or (
                actor.primary_department_id is not null
                and u.primary_department_id = actor.primary_department_id
              )

              -- any department you lead or oversee
              or (
                actor.role >= 'team_leader'
                and exists (
                  select 1 from vizserve_pms_user_managed_departments md
                   where md.user_id = actor.id
                     and md.department_id = u.primary_department_id
                )
              )
            )
       )
     );
$fn$;


create or replace function vizserve_pms_mentionable_for_task(p_task_id uuid)
returns table (id uuid, full_name text)
language plpgsql
stable
security definer
set search_path = public, extensions
as $fn$
declare
  v_task vizserve_pms_tasks;
begin
  select * into v_task from vizserve_pms_tasks t where t.id = p_task_id;
  if v_task.id is null then return; end if;

  if not (
    vizserve_pms_is_on_task(p_task_id, auth.uid())
    or (
      not v_task.is_personal
      and (
        vizserve_pms_manages_department(v_task.department_id)
        or v_task.department_id = vizserve_pms_my_department()
        -- P13-01. The guard asks "may you comment here at all", and in a
        -- collaboration space everybody may. Without it the function returns
        -- EMPTY rather than refusing, so the picker would open on "No one to
        -- mention here" for a task the reader can plainly edit.
        or vizserve_pms_may_collaborate(v_task.department_id)
      )
    )
  ) then
    return;
  end if;

  return query
    -- The caller is the actor. There is no form of this that lets somebody ask
    -- about anybody else's reach — that is the whole reason the function below
    -- takes an actor and this one does not.
    select c.id, c.full_name
      from vizserve_pms_task_mention_candidates(p_task_id, auth.uid()) c
     -- Not yourself. Mentioning the person typing is a notification nobody
     -- needs, and a name in the list that does nothing reads as a bug.
     where c.id is distinct from auth.uid()
     order by c.full_name;
end;
$fn$;


-- ---------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT TOUCH, so the next person does not go
-- looking for the half that is missing:
--
--   `vizserve_pms_manages_department`   Nobody leads a shared space. It confers
--                                       no approvals, no DTR scope, no timesheet
--                                       review scope. Stated three times in this
--                                       file because it is the thing most likely
--                                       to be "fixed" later.
--   FORMS                               Not widened. A client form files into a
--                                       department's Client Requests folder and
--                                       enters Gate 1, which needs a lead. There
--                                       is none here.
--   INTERNAL REQUESTS / DTR / LEAVE     All scope on the PERSON's own
--                                       `primary_department_id`, which §2
--                                       guarantees is never a shared space. They
--                                       need no change and must not get one.
--   `vizserve_pms_check_subtask_parent` Untouched: a subtask stays in its
--                                       parent's department, so a collaboration
--                                       task's subtasks are collaboration tasks.
--   REPORTS                             Collaboration work will show up under
--                                       its own department name, which is
--                                       correct — it is not VizBytes's work.
-- ---------------------------------------------------------------------------
