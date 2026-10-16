-- P17-01b — a task for yourself, typed into a sub department's list (16 Oct 2026).
--
-- P17-01 let a sub member see and work in the department's lists, but
-- `vizserve_pms_create_personal_task` — the path "Myself" takes, from the list
-- composer and the new-task dialog — still filed every task under the caller's
-- MAIN department, so a VizMedia list refused it: "That list belongs to another
-- department." This adds the sub-department case beside P13-01's shared one.
--
-- The latest definition (20260921090000_p13_01_collaboration_space.sql),
-- verbatim apart from the marked block. A personal list still only ever holds
-- its owner's tasks, and the department check below is unchanged.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after P17-01. Never `db:push`.

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

    -- P17-01b. Or an ordinary list in one of the caller's SUB departments: the
    -- task is filed there, as a member of that department would file it. Only
    -- when the shared branch above did not decide.
    if v_department = v_user.primary_department_id then
      select l.department_id into v_department
        from vizserve_pms_lists l
       where l.id = p_list_id
         and l.owner_id is null
         and vizserve_pms_is_department_member(l.department_id, v_actor);

      v_department := coalesce(v_department, v_user.primary_department_id);
    end if;
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
