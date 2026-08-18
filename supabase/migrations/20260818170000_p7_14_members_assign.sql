-- P7-14 / K2 — a member may put work on a colleague's list.
--
-- `vizserve_pms_create_task` has raised "That department is outside your scope."
-- for anyone who is not a team leader since P3-12, and that gate is the entire
-- reason `create_task` and `create_personal_task` are two functions rather than
-- one. The argument for the split was written down at the time: one function
-- answers "may I create work for SOMEONE ELSE", the other "may I record work
-- for MYSELF", and collapsing them gives one function whose parameter legality
-- depends on another parameter.
--
-- THAT ARGUMENT STILL HOLDS AND THE DECISION OVERRIDES IT (18 Aug 2026). The
-- team works the way ClickUp let them work: somebody notices a thing, makes a
-- card, and puts a colleague's name on it. Requiring a team leader for that is
-- the ceremony this app is supposed to remove.
--
-- SAY PLAINLY WHAT IT COSTS. After this migration a member can put work on a
-- colleague's list with no lead involved, and nobody is notified except the
-- person assigned. The only guard left is the department boundary.
--
-- Two rules keep that boundary real, and they are the reason this is not simply
-- "delete the check":
--
--   1. The department is STILL NOT A PARAMETER a member may choose. A member
--      may only create in their OWN department, resolved from their own row —
--      exactly as `vizserve_pms_create_personal_task` does. Creating work in a
--      department you are not in remains impossible, not merely refused.
--   2. A lead keeps the wider power. `vizserve_pms_manages_department` still
--      admits any department they lead, so nothing a TL could do before is
--      taken away.
--
-- Signature unchanged, so no drop and no regrant — the dance is only for a
-- CHANGED argument list.

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
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- The caller's own department, from their own row. Not a parameter, and that
  -- is the whole guard: a member cannot ASK to create somewhere else.
  select u.primary_department_id into v_mine
    from vizserve_pms_users u
   where u.id = v_actor and u.is_active;

  -- P7-14. A lead may file into any department they lead; anyone else may file
  -- into their own and nowhere else.
  if not (
    coalesce(vizserve_pms_manages_department(p_department_id), false)
    or (v_mine is not null and p_department_id = v_mine)
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
  if p_assignee_id is not null and not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_assignee_id and u.is_active and u.primary_department_id = p_department_id
  ) then
    raise exception 'That assignee is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id and l.department_id = p_department_id
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, list_id, created_by, priority
  ) values (
    null, p_department_id, v_title, coalesce(btrim(p_description), ''), 'OPEN',
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

  -- Unchanged, and now carrying more weight: this notification is the ONLY way
  -- somebody learns a colleague has given them work, because no lead is in the
  -- loop any more.
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
-- Reassignment.
--
-- The UPDATE policy's WITH CHECK currently demands the NEW row still have the
-- caller as PIC or QA (or that they lead the department, or are on the task),
-- so handing a task to somebody else already fails: the row you are trying to
-- write is a row you would no longer qualify for.
--
-- USING IS LEFT ALONE ON PURPOSE. It answers "may I touch this row at all" and
-- stays exactly as P7-13 left it — participants and department leads. Only the
-- WITH CHECK, which answers "is the result acceptable", is widened.
--
-- READ THIS BEFORE ASSUMING IT IS ONLY ABOUT INTERNAL WORK: this policy guards
-- CLIENT tasks too. After this a member may hand a client task to a colleague
-- in the same department without a lead. That follows from the decision and is
-- stated here rather than discovered later.
-- ---------------------------------------------------------------------------
drop policy "tasks updatable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks updatable by participants and department leads"
  on vizserve_pms_tasks for update to authenticated
  using (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    or vizserve_pms_is_on_task(id, auth.uid())
  )
  with check (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    or vizserve_pms_is_on_task(id, auth.uid())
    -- P7-14. The result may name a colleague, provided they are an active
    -- member of THIS task's department. Combined with USING above, the caller
    -- still has to be a participant or a lead to touch the row at all — this
    -- only stops the write failing because they wrote themselves out of it.
    --
    -- It tests the NEW assignee, not the caller: "you may hand this to someone
    -- in this department" rather than "members of this department may edit
    -- anything", which is what testing the caller would have meant.
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = vizserve_pms_tasks.assignee_id
         and u.is_active
         and u.primary_department_id = vizserve_pms_tasks.department_id
    )
  );

-- Unassigning entirely still fails for a sole PIC, and that is correct rather
-- than an oversight: with `assignee_id` null and nobody on the join table,
-- every clause above is false. A task with no owner is not a state anybody
-- asked for, and "hand it to someone else" is the operation that exists.
