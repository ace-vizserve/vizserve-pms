-- P17-01 — a person may work in more than one department (16 Oct 2026).
--
-- Victoria Montesclaros moved from VizMedia to VizAssists. Changing her
-- department hid every VizMedia task she had, because a task belongs to its
-- department (P11-03) and visibility follows the person's ONE department. The
-- ask: a MAIN department and SUB departments.
--
--   MAIN (`vizserve_pms_users.primary_department_id`, unchanged)
--     where her approvals go — leave, overtime, DTR corrections, reimbursement,
--     timesheet — and which attendance, leave and HR reports count her in. Her
--     personal lists live here. A department admin tick applies here only.
--
--   SUB (`vizserve_pms_user_departments`, new)
--     the TASK SIDE of membership and nothing else: read the department's
--     lists, folders and tasks, edit them, move them through the internal
--     transitions, be the PIC / QA / a co-assignee, be @-mentioned, log time
--     against them. Exactly what P11-03, P11-05 and P11-07 give a member of
--     their own department.
--
-- ⚠️ WHAT A SUB DEPARTMENT DOES NOT DO, and each is load-bearing:
--   * `vizserve_pms_manages_department` is UNTOUCHED. Nobody leads a team by
--     being a sub member of it, and no approval routing reads this table.
--   * DTR, timesheet, leave and the internal-request functions are UNTOUCHED.
--     They read `primary_department_id` and keep reading it.
--   * Nobody's PERSONAL tasks become visible: the read branch below carries
--     the same personal-list exclusion as the own-department branch.
--   * `vizserve_pms_my_department()` still returns the main department only.
--
-- THE SHAPE. One helper answers "is this person a member of this department":
-- `vizserve_pms_is_department_member(department, user)` — main OR sub. Every
-- function below that asked `u.primary_department_id = X` about TASK WORK now
-- asks that instead; each is otherwise a verbatim copy of its latest
-- definition, named in the comment above it. Policies get an ADDED branch,
-- `vizserve_pms_also_works_in(department_id)`, rather than a rewrite.
--
-- ⚠️ NOT `vizserve_pms_may_collaborate`. That helper already sits in most of
-- these policies and widening it looks like a one-line change — but in
-- `create_task` and `add_task_assignee` it also relaxes who may be ASSIGNED to
-- "anybody active", which is right for the shared space and wrong here.
--
-- ⚠️ APPLY BY HAND in the SQL editor, in one run. Never `db:push`. The app
-- reads the new table in its own query and degrades to "no sub departments"
-- until this is pasted, so the order of deploy and paste does not matter.


-- ---------------------------------------------------------------------------
-- 1. The table.
-- ---------------------------------------------------------------------------
create table if not exists vizserve_pms_user_departments (
  user_id       uuid not null references vizserve_pms_users (id) on delete cascade,
  department_id uuid not null references vizserve_pms_departments (id) on delete restrict,
  added_by      uuid references vizserve_pms_users (id) on delete set null,
  added_at      timestamptz not null default now(),
  primary key (user_id, department_id)
);

create index if not exists vizserve_pms_user_departments_department_idx
  on vizserve_pms_user_departments (department_id);

comment on table vizserve_pms_user_departments is
  'P17-01. Sub departments: where a person also does task work. Never their main '
  'department (primary_department_id), never a shared space. Approvals ignore it.';

alter table vizserve_pms_user_departments enable row level security;
revoke all on vizserve_pms_user_departments from anon;
grant select on vizserve_pms_user_departments to authenticated;
grant all on vizserve_pms_user_departments to service_role;

-- A sub department is never the main one, and never a shared space — everybody
-- is already in Collaboration Projects (P13-01 §2).
create or replace function vizserve_pms_user_departments_guard()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if exists (
    select 1 from vizserve_pms_users u
     where u.id = new.user_id and u.primary_department_id = new.department_id
  ) then
    raise exception 'That is already their main department.' using errcode = 'check_violation';
  end if;

  if vizserve_pms_is_shared_department(new.department_id) then
    raise exception
      'Collaboration Projects is a shared space, not a team — everybody is already in it.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists vizserve_pms_user_departments_guard on vizserve_pms_user_departments;
create trigger vizserve_pms_user_departments_guard
  before insert or update on vizserve_pms_user_departments
  for each row execute function vizserve_pms_user_departments_guard();

-- Promoting a sub department to main removes the sub row, so the two never
-- overlap and the editor never shows a team twice.
create or replace function vizserve_pms_users_drop_sub_on_main_change()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.primary_department_id is not null then
    delete from vizserve_pms_user_departments
     where user_id = new.id and department_id = new.primary_department_id;
  end if;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_users_drop_sub_on_main_change on vizserve_pms_users;
create trigger vizserve_pms_users_drop_sub_on_main_change
  after insert or update of primary_department_id on vizserve_pms_users
  for each row execute function vizserve_pms_users_drop_sub_on_main_change();


-- ---------------------------------------------------------------------------
-- 2. The helpers.
-- ---------------------------------------------------------------------------

-- Main OR sub, asked about any user. The one test for "a member of this
-- department" in task work. Active only, like every check it replaces.
create or replace function vizserve_pms_is_department_member(p_department_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p_department_id is not null and p_user_id is not null and exists (
    select 1 from vizserve_pms_users u
     where u.id = p_user_id
       and u.is_active
       and (
         u.primary_department_id = p_department_id
         or exists (
           select 1 from vizserve_pms_user_departments s
            where s.user_id = u.id and s.department_id = p_department_id
         )
       )
  );
$$;

revoke all on function vizserve_pms_is_department_member(uuid, uuid) from public, anon;
grant execute on function vizserve_pms_is_department_member(uuid, uuid) to authenticated;

-- The caller's sub departments. Same gates as `vizserve_pms_my_department()`:
-- active, and holding app access.
create or replace function vizserve_pms_my_sub_department_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.department_id
    from vizserve_pms_user_departments s
    join vizserve_pms_users u on u.id = s.user_id
   where s.user_id = (select auth.uid())
     and u.is_active
     and 'vizserve-pms' = any(u.app_access);
$$;

revoke all on function vizserve_pms_my_sub_department_ids() from public, anon;
grant execute on function vizserve_pms_my_sub_department_ids() to authenticated;

-- The policy branch: is this one of the caller's sub departments?
create or replace function vizserve_pms_also_works_in(p_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p_department_id is not null
     and p_department_id in (select vizserve_pms_my_sub_department_ids());
$$;

revoke all on function vizserve_pms_also_works_in(uuid) from public, anon;
grant execute on function vizserve_pms_also_works_in(uuid) to authenticated;

-- People who are SUB members of a department the caller belongs to (main or
-- sub) or leads. The other half of the users read below.
create or replace function vizserve_pms_sub_department_colleague_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select s.user_id
    from vizserve_pms_user_departments s
   where s.department_id = vizserve_pms_my_department()
      or s.department_id in (select vizserve_pms_my_sub_department_ids())
      or vizserve_pms_manages_department(s.department_id);
$$;

revoke all on function vizserve_pms_sub_department_colleague_ids() from public, anon;
grant execute on function vizserve_pms_sub_department_colleague_ids() to authenticated;


-- ---------------------------------------------------------------------------
-- 3. Who may read the table. Yourself, the departments you are in, the ones
--    you lead, and the admin rungs. Writes: the service role only, through the
--    Users screen — nobody adds themselves to a team.
-- ---------------------------------------------------------------------------
drop policy if exists "user departments readable in scope" on vizserve_pms_user_departments;
create policy "user departments readable in scope"
  on vizserve_pms_user_departments for select to authenticated
  using (
    user_id = (select auth.uid())
    or vizserve_pms_is_department_member(department_id, (select auth.uid()))
    or vizserve_pms_manages_department(department_id)
    or (select vizserve_pms_is_admin())
  );


-- ---------------------------------------------------------------------------
-- 4. People. ADDITIVE — the two existing users policies are untouched. A sub
--    member sees the department's people, and the department (and its lead)
--    sees the sub member, or nobody could assign them.
-- ---------------------------------------------------------------------------
drop policy if exists "users read through sub departments" on vizserve_pms_users;
create policy "users read through sub departments"
  on vizserve_pms_users for select to authenticated
  using (
    is_active
    and (
      primary_department_id in (select vizserve_pms_my_sub_department_ids())
      or id in (select vizserve_pms_sub_department_colleague_ids())
    )
  );


-- ---------------------------------------------------------------------------
-- 5. Tasks. The read policy is
--    20261001090000_p14_14_manager_reads_every_task.sql verbatim plus ONE
--    branch: the own-department branch again, for sub departments, with the
--    same personal-list exclusion.
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
        -- P14-14. The Manager oversees every department (P14-04).
        or (select vizserve_pms_current_role()) = 'manager'
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
    -- P17-01. A sub department, read exactly like the main one above.
    or (
      department_id in (select vizserve_pms_my_sub_department_ids())
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

-- 20260921090000_p13_01_collaboration_space.sql plus the P17-01 branch.
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
    or vizserve_pms_also_works_in(department_id)
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
    or vizserve_pms_also_works_in(department_id)
  );


-- ---------------------------------------------------------------------------
-- 6. Lists. 20260921090000_p13_01_collaboration_space.sql plus the P17-01
--    branch, always beside `owner_id is null`: a sub member never touches
--    anybody's personal list.
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
      or vizserve_pms_also_works_in(department_id)
    )
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
      or vizserve_pms_also_works_in(department_id)
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
      or vizserve_pms_also_works_in(department_id)
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
    or (owner_id is null and vizserve_pms_also_works_in(department_id))
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
    or (owner_id is null and vizserve_pms_also_works_in(department_id))
  );


-- ---------------------------------------------------------------------------
-- 7. Folders. 20260921090000_p13_01_collaboration_space.sql plus the branch.
-- ---------------------------------------------------------------------------
drop policy if exists "task groups readable in department" on vizserve_pms_task_groups;
create policy "task groups readable in department"
  on vizserve_pms_task_groups for select to authenticated
  using (
    vizserve_pms_manages_department(department_id)
    or department_id = vizserve_pms_my_department()
    or vizserve_pms_may_collaborate(department_id)
    or vizserve_pms_also_works_in(department_id)
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
    or vizserve_pms_also_works_in(department_id)
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
    or vizserve_pms_also_works_in(department_id)
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
    or vizserve_pms_also_works_in(department_id)
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
    or vizserve_pms_also_works_in(department_id)
  );


-- ---------------------------------------------------------------------------
-- 8. Functions. Each is its latest definition, copied verbatim, with every
--    `primary_department_id = <task department>` membership test replaced by
--    `vizserve_pms_is_department_member(<task department>, <user>)`. Nothing
--    else in them changes.
-- ---------------------------------------------------------------------------

-- vizserve_pms_may_log_time — 20260921090000_p13_01_collaboration_space.sql
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
       and vizserve_pms_is_department_member(t.department_id, u.id)
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


-- vizserve_pms_may_change_task — 20261005090000_p15_10_recurring_tasks.sql
create or replace function vizserve_pms_may_change_task(p_task vizserve_pms_tasks, p_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select p_actor is not null and (
    coalesce(vizserve_pms_is_on_task(p_task.id, p_actor), false)
    or coalesce(vizserve_pms_manages_department(p_task.department_id), false)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = p_actor and u.is_active and vizserve_pms_is_department_member(p_task.department_id, u.id)
    )
    or coalesce(vizserve_pms_may_collaborate(p_task.department_id), false)
  );
$$;


-- vizserve_pms_can_manage_list — 20260917120000_p7_73_list_custom_fields.sql
create or replace function vizserve_pms_can_manage_list(p_list_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_lists l
     where l.id = p_list_id
       and (
         (
           l.owner_id is null
           and (
             vizserve_pms_manages_department(l.department_id)
             or vizserve_pms_is_dept_admin(l.department_id)
             or exists (
               select 1 from vizserve_pms_users u
                where u.id = auth.uid()
                  and u.is_active
                  and vizserve_pms_is_department_member(l.department_id, u.id)
             )
           )
         )
         or (
           l.owner_id = auth.uid()
           and exists (select 1 from vizserve_pms_users u where u.id = auth.uid() and u.is_active)
         )
       )
  )
$$;


-- vizserve_pms_add_task_assignee — 20260930160000_p14_10_processes_emit.sql
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
              and vizserve_pms_is_department_member(v_task.department_id, u.id)
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
       and (v_shared or vizserve_pms_is_department_member(v_task.department_id, u.id))
  ) then
    raise exception 'That person is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  values (p_task_id, p_user_id, v_actor)
  on conflict (task_id, user_id) do nothing;

  if p_user_id <> v_actor then
    perform vizserve_pms_emit(
      'task.assigned',
      jsonb_build_object('assignee', jsonb_build_array(p_user_id)),
      'Added to: ' || v_task.title,
      coalesce(v_task.description, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true);
end;
$$;


-- vizserve_pms_remove_task_assignee — 20260908111000_p11_06_comments_files_assignees.sql
create or replace function vizserve_pms_remove_task_assignee(p_task_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_task  vizserve_pms_tasks;
  v_next  uuid;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- P11-06 — the department may put people on its own work.
  --
  -- This read `is_on_task OR manages_department`, which meant a colleague could
  -- edit every field on a task, move it, and log hours against it, but could not
  -- add the second person who was going to help — the one change that makes all
  -- of the others make sense.
  --
  -- The person being ADDED is still checked below, and that check is the real
  -- guard: they must be an active member of this task's department. Widening who
  -- may press the button does not widen who can end up on the task.
  if not (
    coalesce(vizserve_pms_is_on_task(p_task_id, v_actor), false)
    or coalesce(vizserve_pms_manages_department(v_task.department_id), false)
    or coalesce(
         exists (
           select 1 from vizserve_pms_users u
            where u.id = v_actor
              and u.is_active
              and vizserve_pms_is_department_member(v_task.department_id, u.id)
         ),
         false
       )
  ) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  if p_user_id = v_task.assignee_id then
    -- P7-43. A CLIENT task keeps its person in charge, and taking them off is a
    -- reassignment — a different decision, with its own control and its own
    -- department rule (P7-14).
    if v_task.request_id is not null then
      raise exception 'That is the person this task is assigned to. Reassign it instead.'
        using errcode = 'check_violation';
    end if;

    -- An INTERNAL task has no such person. Hand the column to somebody else who
    -- is already on the task, oldest membership first so the choice is stable
    -- and explicable rather than whatever the planner returned. `user_id`
    -- breaks a tie on identical `added_at`, which the import files produce
    -- because they insert in one statement.
    select a.user_id into v_next
      from vizserve_pms_task_assignees a
     where a.task_id = p_task_id
       and a.user_id <> p_user_id
     order by a.added_at, a.user_id
     limit 1;

    -- Null when they were the last one. That is an unassigned task, not an
    -- error — see the header.
    update vizserve_pms_tasks
       set assignee_id = v_next
     where id = p_task_id;
  end if;

  delete from vizserve_pms_task_assignees
   where task_id = p_task_id and user_id = p_user_id;

  return jsonb_build_object('ok', true);
end;
$$;


-- vizserve_pms_create_task — 20260930160000_p14_10_processes_emit.sql
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
    or vizserve_pms_is_department_member(v_dept, v_actor)
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
       and (v_shared or vizserve_pms_is_department_member(v_dept, u.id))
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
    perform vizserve_pms_emit(
      'task.assigned',
      jsonb_build_object('assignee', jsonb_build_array(p_assignee_id)),
      'Assigned to you: ' || v_title,
      coalesce(btrim(p_description), ''), 'task', v_task_id, '/tasks/' || v_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end;
$$;


-- vizserve_pms_copy_task — 20260916120000_p7_69_copy_task.sql
create or replace function vizserve_pms_copy_task(
  p_task_id uuid,
  p_list_id uuid,
  p_include text[] default array['description', 'priority', 'estimate', 'checklist']
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor  uuid := auth.uid();
  v_mine   uuid;
  v_source vizserve_pms_tasks;
  v_dept   uuid;
  v_new    uuid;
  v_title  text;
  v_has    boolean;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_source from vizserve_pms_tasks t where t.id = p_task_id;

  if v_source.id is null then
    raise exception 'That task does not exist.' using errcode = 'no_data_found';
  end if;

  /*
   * ⚠️ THE READ IS CHECKED BY HAND BECAUSE THIS IS `security definer`. RLS is
   * bypassed inside here, so the predicate the task's own SELECT policy would
   * have applied has to be restated — the one place in this file where the
   * P11-06 "defer, do not restate" rule cannot be followed, and the reason it
   * is written out rather than assumed. A member reads their department's
   * tasks; a lead reads the departments they lead.
   */
  select u.primary_department_id into v_mine
    from vizserve_pms_users u
   where u.id = v_actor and u.is_active;

  v_dept := v_source.department_id;

  if not (
    coalesce(vizserve_pms_manages_department(v_dept), false)
    or vizserve_pms_is_department_member(v_dept, v_actor)
  ) then
    raise exception 'That task is outside your scope.' using errcode = 'insufficient_privilege';
  end if;

  -- The target list, in the SAME department. Null means "no list", which is a
  -- real place for a task to live and is how a copy lands unfiled.
  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id and l.department_id = v_dept
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  /*
   * ⚠️ "(copy)" ONLY WHEN IT LANDS BESIDE THE ORIGINAL. Two identical titles in
   * one list is a list you cannot read; two identical titles in two lists is
   * the normal case — "Updating of Student P-Files" is the same work in a new
   * month and does not want a suffix it will carry forever.
   */
  v_title := case
    when p_list_id is not distinct from v_source.list_id then left(v_source.title || ' (copy)', 200)
    else v_source.title
  end;

  insert into vizserve_pms_tasks (
    request_id, department_id, list_id, is_personal, title, description, status,
    assignee_id, qa_assignee_id, due_date, start_date, priority, estimate_minutes,
    created_by
  ) values (
    null,
    v_dept,
    p_list_id,
    false,
    v_title,
    case when 'description' = any(p_include) then v_source.description else '' end,
    'OPEN',
    case when 'assignees' = any(p_include) then v_source.assignee_id else null end,
    case when 'assignees' = any(p_include) then v_source.qa_assignee_id else null end,
    case when 'dates' = any(p_include) then v_source.due_date else null end,
    case when 'dates' = any(p_include) then v_source.start_date else null end,
    case when 'priority' = any(p_include) then v_source.priority else null end,
    case when 'estimate' = any(p_include) then v_source.estimate_minutes else null end,
    v_actor
  )
  returning id into v_new;

  -- P7-13's second assignees. Only alongside the PIC — a task carrying five
  -- participants and no owner is not a state this app produces on purpose.
  if 'assignees' = any(p_include) then
    insert into vizserve_pms_task_assignees (task_id, user_id)
    select v_new, a.user_id
      from vizserve_pms_task_assignees a
     where a.task_id = p_task_id
    on conflict do nothing;
  end if;

  -- P7-68. Unticked, whatever the original says: the procedure is about to be
  -- followed again, and copying the ticks would claim it already has been.
  if 'checklist' = any(p_include) then
    insert into vizserve_pms_task_checklist_items (task_id, group_label, label, is_done, position)
    select v_new, c.group_label, c.label, false, c.position
      from vizserve_pms_task_checklist_items c
     where c.task_id = p_task_id;
  end if;

  /*
   * ⚠️ SUBTASKS ARE COPIED AS SUBTASKS OF THE COPY, and only one level deep —
   * which costs nothing to enforce here because one level is all that can
   * exist. The P7-09 trigger refuses a parent that already has one.
   *
   * They inherit nothing but their titles: a subtask's assignee and dates
   * belong to the cycle that produced them.
   */
  if 'subtasks' = any(p_include) then
    select exists (select 1 from vizserve_pms_tasks s where s.parent_task_id = p_task_id) into v_has;

    if v_has then
      insert into vizserve_pms_tasks (
        request_id, department_id, list_id, is_personal, title, description,
        status, parent_task_id, created_by
      )
      select null, v_dept, p_list_id, false, s.title,
             case when 'description' = any(p_include) then s.description else '' end,
             'OPEN', v_new, v_actor
        from vizserve_pms_tasks s
       where s.parent_task_id = p_task_id
       order by s.created_at;
    end if;
  end if;

  return v_new;
end;
$$;


-- vizserve_pms_transition_task — 20261007150000_p16_08_qa_review_needs_a_comment.sql
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
                      and vizserve_pms_is_department_member(v_task.department_id, u.id)
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

    -- P16-08 — leaving a review is a review, and every review says what was
    -- checked. Back into the queue is the one exit that is not.
    if v_task.status = 'QA_IN_PROGRESS'
       and p_to_status <> 'FOR_QA'
       and v_comment is null then
      raise exception 'A comment is required for that.' using errcode = 'check_violation';
    end if;

    -- Nothing further to ask beyond that. The ownership check above established
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
    perform vizserve_pms_emit(
      case when v_task.request_id is not null then 'client.ready_for_qa' else 'task.ready_for_qa' end,
      jsonb_build_object('qa', jsonb_build_array(v_task.qa_assignee_id)),
      'Ready for QA: ' || coalesce(v_reference, v_task.title),
      v_task.title, 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  -- QA sent it back. The PIC is the one who has to do something about it, and
  -- the comment travels with the notification so they do not have to go looking.
  if v_task.status = 'QA_IN_PROGRESS' and p_to_status = 'ONGOING'
     and v_task.assignee_id is not null then
    perform vizserve_pms_emit(
      case when v_task.request_id is not null then 'client.qa_returned' else 'task.qa_returned' end,
      jsonb_build_object('pic', jsonb_build_array(v_task.assignee_id)),
      'QA sent back: ' || coalesce(v_reference, v_task.title),
      coalesce(v_comment, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  -- P14-12. QA passed it to the client (Gate 3). Nobody is told by default;
  -- Admin can add recipients to this stage.
  if p_to_status = 'FOR_CLIENT_APPROVAL' and v_task.request_id is not null then
    perform vizserve_pms_emit(
      'client.sent_to_client',
      jsonb_build_object(
        'pic', jsonb_build_array(v_task.assignee_id),
        'qa', jsonb_build_array(v_task.qa_assignee_id),
        'dept_team_leaders', coalesce((select jsonb_agg(t) from vizserve_pms_team_leaders_of(v_task.department_id) t), '[]'::jsonb)
      ),
      'Sent to the client: ' || coalesce(v_reference, v_task.title),
      v_task.title, 'task', p_task_id, '/tasks/' || p_task_id::text,
      array[v_actor]
    );
  end if;

  return jsonb_build_object('ok', true, 'status', p_to_status);
end;
$$;


-- vizserve_pms_approve_request — 20261007130000_p16_05_urgency_sets_the_sla.sql
create or replace function vizserve_pms_approve_request(
  p_request_id     uuid,
  p_assignee_id    uuid,
  p_qa_assignee_id uuid,
  p_urgency        text,
  p_title          text default null,
  p_description    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request       vizserve_pms_requests;
  v_department_id uuid;
  v_task_id       uuid;
  v_title         text;
  v_description   text;
  v_due           date;
  v_reference     text;
  v_list_id       uuid;
  v_days          integer;
  v_priority      vizserve_pms_task_priority;
begin
  select r.* into v_request
    from vizserve_pms_requests r
   where r.id = p_request_id
   for update;

  if v_request.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_request.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_request.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  if p_urgency is null or p_urgency not in ('URGENT', 'NON_URGENT') then
    raise exception 'Choose Urgent or Non-urgent.' using errcode = 'check_violation';
  end if;

  select f.department_id,
         case p_urgency when 'URGENT' then f.urgent_days else f.normal_days end
    into v_department_id, v_days
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  -- P16-02. Always the form's own list.
  select l.id into v_list_id
    from vizserve_pms_lists l
   where l.form_id = v_request.form_id;

  perform vizserve_pms_record_decision(
    'request', p_request_id, v_department_id, 'approved', null
  );

  if p_assignee_id is null then
    raise exception 'Choose who will do the work.' using errcode = 'check_violation';
  end if;

  -- P7-23. Checked beside "choose who will do the work" because it is the same
  -- kind of rule: an approval that does not say where the work goes is not a
  -- complete approval. The sentence names the way out, since a reviewer looking
  -- at a form with no inbox list cannot be expected to know P7-18 exists.
  if v_list_id is null then
    raise exception 'This form has no list yet. Publish it once so its list is created.'
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_assignee_id and u.is_active and vizserve_pms_is_department_member(v_department_id, u.id)
  ) then
    raise exception 'That assignee is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  if p_qa_assignee_id is not null and not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_qa_assignee_id and u.is_active
       and (vizserve_pms_is_department_member(v_department_id, u.id)
            or vizserve_pms_manages_department_for(u.id, v_department_id))
  ) then
    raise exception 'That QA reviewer is not available for this department.'
      using errcode = 'check_violation';
  end if;

  -- Same rule as manual creation: a list belongs to one department, and a task
  -- filed under another department's list is invisible to the team that owns it.
  --
  -- The null branch is kept even though the raise above makes it unreachable:
  -- it costs nothing, and a future edit that softens the requirement should not
  -- silently turn this into a null-comparison that admits everything.
  if v_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = v_list_id and l.department_id = v_department_id
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  v_title       := coalesce(nullif(btrim(coalesce(p_title, '')), ''), v_request.title);
  v_description := coalesce(nullif(btrim(coalesce(p_description, '')), ''), v_request.description);
  -- P16-05. The due date is the SLA: working days from today by urgency.
  -- The client's ideal finish date (`target_date`) is kept and never used here.
  v_due      := (vizserve_pms_add_business_days(now(), v_days) at time zone 'Asia/Manila')::date;
  v_priority := case p_urgency when 'URGENT' then 'URGENT' else 'NORMAL' end::vizserve_pms_task_priority;

  update vizserve_pms_requests
     set status               = 'APPROVED',
         approved_target_date = v_due,
         urgency              = p_urgency,
         title                = v_title,
         description          = v_description,
         reviewed_by          = auth.uid(),
         reviewed_at          = now()
   where id = p_request_id
  returning reference_no into v_reference;

  -- `field_values` travels with the task. It always has — the reason the
  -- client's answers looked "neglected" was P7-22's policy, and a form with no
  -- custom fields having nothing to carry. Left here as the note saying so.
  insert into vizserve_pms_tasks (
    request_id, department_id, list_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, field_values, created_by, priority
  ) values (
    p_request_id, v_department_id, v_list_id, v_title, v_description, 'OPEN',
    p_assignee_id, p_qa_assignee_id, v_due, v_request.field_values, auth.uid(), v_priority
  )
  returning id into v_task_id;

  -- P2-03 — recorded only when something genuinely changed. A trail where every
  -- approval logs an edit is a trail in which a real edit is invisible.
  if v_title is distinct from v_request.title
     or v_description is distinct from v_request.description
  then
    perform vizserve_pms_write_audit_log(
      'request', p_request_id, 'edited', auth.uid(),
      jsonb_build_object(
        'title', v_request.title,
        'description', v_request.description
      ),
      jsonb_build_object(
        'title', v_title,
        'description', v_description
      )
    );
  end if;

  perform vizserve_pms_write_audit_log(
    'task', v_task_id, 'created', auth.uid(), null,
    jsonb_build_object(
      'request_id', p_request_id,
      'reference_no', v_reference,
      'assignee_id', p_assignee_id,
      'qa_assignee_id', p_qa_assignee_id,
      'due_date', v_due,
      'list_id', v_list_id,
      'priority', v_priority,
      'urgency', p_urgency
    )
  );

  perform vizserve_pms_emit(
    'client.pic_assigned',
    jsonb_build_object('assignee', jsonb_build_array(p_assignee_id)),
    'Assigned to you: ' || v_reference,
    v_title,
    'task', v_task_id, '/tasks/' || v_task_id::text
  );

  if p_qa_assignee_id is not null and p_qa_assignee_id <> p_assignee_id then
    perform vizserve_pms_emit(
      'client.qa_assigned',
      jsonb_build_object('qa', jsonb_build_array(p_qa_assignee_id)),
      'You are QA on ' || v_reference,
      v_title,
      'task', v_task_id, '/tasks/' || v_task_id::text
    );
  end if;

  -- P7-77. The PIC and the QA reviewer are both on the task's assignee list.
  -- `assignee_id` and `qa_assignee_id` still name their roles; this is who is
  -- working on it. The PIC's row cannot be removed later on a client task —
  -- P7-43's remove function refuses it and says "reassign instead".
  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  select v_task_id, person, auth.uid()
    from unnest(array[p_assignee_id, p_qa_assignee_id]) as person
   where person is not null
  on conflict (task_id, user_id) do nothing;

  -- P14-10. The department's Team Leaders (vizserve_pms_team_leaders_of).
  -- Anyone already told as PIC or QA above is skipped rather than emailed twice.
  perform vizserve_pms_emit(
    'client.gate1_approved',
    jsonb_build_object('dept_team_leaders', coalesce((select jsonb_agg(t) from vizserve_pms_team_leaders_of(v_department_id) t), '[]'::jsonb)),
    'Approved: ' || v_title || ' (' || v_reference || ')',
    'Now a task.',
    'task', v_task_id, '/tasks/' || v_task_id::text,
    array[p_assignee_id]
  );

  return jsonb_build_object(
    'ok', true,
    'task_id', v_task_id,
    'reference_no', v_reference,
    'approved_target_date', v_due,
    'list_id', v_list_id,
    'urgency', p_urgency
  );
end;
$$;


-- vizserve_pms_department_capacity — 20261007110100_p16_03b_task_cancel_archive_delete.sql
create or replace function vizserve_pms_department_capacity(
  p_department_id uuid,
  p_target_date   date default null
)
returns table (
  user_id        uuid,
  full_name      text,
  role           vizserve_pms_user_role,
  open_count     integer,
  due_before     integer,
  overdue_count  integer,
  next_due_dates date[]
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    u.id,
    u.full_name,
    u.role,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
    )::integer,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
        and p_target_date is not null
        and t.due_date is not null
        and t.due_date <= p_target_date
    )::integer,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
        and t.due_date is not null
        -- Manila, not UTC. "Overdue" is a question about the local calendar day,
        -- and a UTC comparison marks work late several hours early.
        and t.due_date < (now() at time zone 'Asia/Manila')::date
    )::integer,
    coalesce(
      (
        select array_agg(d order by d)
          from (
            select t2.due_date as d
              from vizserve_pms_tasks t2
             where t2.assignee_id = u.id
               and t2.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
               and t2.due_date is not null
             order by t2.due_date
             limit 3
          ) nearest
      ),
      '{}'::date[]
    )
  from vizserve_pms_users u
  left join vizserve_pms_tasks t on t.assignee_id = u.id
  where u.is_active
    and vizserve_pms_is_department_member(p_department_id, u.id)
    -- Only callable by someone with scope over the department. Without this,
    -- SECURITY DEFINER would hand any signed-in user a headcount and workload
    -- report for every team in the company.
    and vizserve_pms_manages_department(p_department_id)
  group by u.id, u.full_name, u.role
  order by u.full_name
$$;


-- vizserve_pms_task_mention_candidates — 20260921090000_p13_01_collaboration_space.sql
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
                and vizserve_pms_is_department_member(t.department_id, u.id)
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
