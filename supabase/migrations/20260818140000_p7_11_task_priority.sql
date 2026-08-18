-- P7-11 — task priority: Urgent, High, Normal, Low, or none.
--
-- WHO SETS IT, and why the question about client work dissolves.
--
-- Whoever creates the task sets its priority. For personal work that is the
-- member, for internal work the team leader, and for CLIENT work the team
-- leader at Gate 1 — because `vizserve_pms_approve_request` is the statement
-- that inserts the task row. There is no earlier moment at which anyone could
-- set a task's priority, least of all the client: before Gate 1 there is no
-- task, only a request.
--
-- A client may still SAY how urgent it is. Forms are dynamic (D20), so a form
-- can carry an "Urgency" field and it lands in `field_values`, which the lead
-- reads while approving. That is the shape `target_date` /
-- `approved_target_date` already has on the request, and the argument written
-- there applies here unchanged: the client asks, the lead decides, both
-- survive, and the delta between them is the thing that proves Gate 1 is doing
-- work rather than rubber-stamping.
--
-- NULLABLE, WITH NO DEFAULT, and that is the design rather than an omission.
-- The picker this was modelled on offers a fifth option, "Clear", which does
-- not mean Normal — it means no priority on this task. Defaulting every row to
-- NORMAL would put a flag on every task in the system, and a mark carried by
-- everything marks nothing. Absence is the ordinary case; presence is a
-- judgement somebody made. Every task that exists today backfills to null,
-- which is true: nobody has ranked them.
--
-- ONE STATEMENT, NOT TWO. `priority` is in the column UPDATE grant, so a screen
-- COULD create a task and then set the priority in a second call. It does not,
-- and the three signature changes below are the cost of that. A task that
-- exists for even a moment at the wrong sort position is a task the board shows
-- in the wrong place, and "create it then immediately fix it" is the pattern
-- that made `reassignTask` a separate call site the `is_personal` design then
-- had to work around.

-- ---------------------------------------------------------------------------
-- The type.
--
-- DECLARED LOW → HIGH. Postgres compares and orders enums by declaration order,
-- so `priority >= 'HIGH'` and `order by priority desc nulls last` work directly
-- with no CASE expression and no lookup table — the same property the role enum
-- relies on for `role >= required`. Reversing this list silently inverts every
-- priority sort in the application, so it is not a cosmetic ordering.
--
-- `CREATE TYPE` may share a migration with statements that use it. The rule
-- that forced p7_03/p7_04 apart is `ALTER TYPE … ADD VALUE`, which cannot be
-- used in the transaction that adds it. This is a new type, so there is nothing
-- to wait for.
-- ---------------------------------------------------------------------------
create type vizserve_pms_task_priority as enum ('LOW', 'NORMAL', 'HIGH', 'URGENT');

alter table vizserve_pms_tasks
  add column priority vizserve_pms_task_priority;

comment on column vizserve_pms_tasks.priority is
  'P7-11. Urgent/High/Normal/Low, or NULL for "nobody ranked this" — which is '
  'not the same as NORMAL and is the ordinary state. Set by whoever creates the '
  'task; for client work that is the team leader at Gate 1, because that is the '
  'statement that creates the task. Unlike status and is_personal this column '
  'IS in the column-level UPDATE grant: re-prioritising is ordinary work.';

-- No index, deliberately. This is a single-tenant install with sixteen users
-- and a task table in the hundreds; a sort index here would be maintained
-- forever to save a scan nobody can perceive. Add
-- `(department_id, priority desc nulls last)` when a list is measurably slow,
-- not before.

-- ---------------------------------------------------------------------------
-- The grant — priority is WRITABLE, unlike status and is_personal.
--
-- Re-prioritising a task is ordinary work, not a state transition: no history
-- row, no legality table, no side effects. So it belongs in the column list
-- rather than behind a function.
--
-- This RESTATES the whole list rather than adding to it, because Postgres has
-- no "grant one more column" that composes with an earlier revoke. The list
-- below must stay identical to 20260803130000_p3_tasks_qa.sql:193-196 plus
-- `priority` — if a column silently disappears from here it becomes read-only
-- across the app with no error anywhere, just an UPDATE that reports success
-- and changes nothing.
--
-- `status` and `is_personal` stay OUT, which is what makes the state machine
-- and the three-way task category real rather than merely intended.
-- ---------------------------------------------------------------------------
revoke update on vizserve_pms_tasks from authenticated;

grant update (
  title, description, resolution, output_link,
  due_date, assignee_id, qa_assignee_id, list_id, priority
) on vizserve_pms_tasks to authenticated;

-- No policy change and no new policy. The existing UPDATE policy on
-- vizserve_pms_tasks already scopes writes to the PIC, the QA reviewer and the
-- department's leads, which is exactly who should be re-prioritising. Said here
-- so nobody goes looking for the policy this migration "forgot".

-- ---------------------------------------------------------------------------
-- 1/3 — vizserve_pms_create_task gains p_priority.
--
-- Body unchanged apart from the new parameter and the new insert column. It is
-- reproduced in full because `create or replace` replaces the whole function:
-- there is no way to add a parameter to the one that is already there.
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
  v_title   text := nullif(btrim(coalesce(p_title, '')), '');
  v_task_id uuid;
begin
  if not vizserve_pms_manages_department(p_department_id) then
    raise exception 'That department is outside your scope.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_title is null then
    raise exception 'A task needs a title.' using errcode = 'check_violation';
  end if;

  -- Same rule as the approval path: work belongs to the department doing it, or
  -- someone ends up holding a task their own TL cannot see.
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
    p_assignee_id, p_qa_assignee_id, p_due_date, p_list_id, auth.uid(), p_priority
  )
  returning id into v_task_id;

  perform vizserve_pms_write_audit_log(
    'task', v_task_id, 'created', auth.uid(), null,
    jsonb_build_object(
      'manual', true, 'title', v_title, 'assignee_id', p_assignee_id,
      'priority', p_priority
    )
  );

  if p_assignee_id is not null then
    perform vizserve_pms_notify(
      p_assignee_id, 'assigned', 'Assigned to you: ' || v_title,
      coalesce(btrim(p_description), ''), 'task', v_task_id, '/tasks/' || v_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end;
$$;

-- THE DROP IS NOT OPTIONAL. `create or replace` with a longer argument list
-- creates a SECOND function rather than replacing the first; both then exist,
-- and PostgREST resolves overloads by argument NAME, so a caller sending the
-- original seven matches both and gets an ambiguity error instead of a task.
-- Precedent: 20260804140000_p2_06_target_list.sql, which had to do exactly this.
drop function if exists vizserve_pms_create_task(uuid, text, text, uuid, uuid, date, uuid);

grant execute on function
  vizserve_pms_create_task(uuid, text, text, uuid, uuid, date, uuid, vizserve_pms_task_priority)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 2/3 — vizserve_pms_create_personal_task gains p_priority.
--
-- Note what this function still does NOT take: no department, no assignee.
-- Those are not the caller's to choose and are resolved from their own user
-- row. Priority is different in kind — how urgent your own work is IS yours to
-- decide, which is the entire distinction this parameter list encodes.
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
  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id and l.department_id = v_user.primary_department_id
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

drop function if exists vizserve_pms_create_personal_task(text, text, date, uuid);

grant execute on function
  vizserve_pms_create_personal_task(text, text, date, uuid, vizserve_pms_task_priority)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 3/3 — vizserve_pms_approve_request gains p_priority.
--
-- THIS IS THE ONE THAT MATTERS. It is the only moment a client task can be
-- given a priority, because it is the statement that creates the task — the
-- lead is already choosing the assignee, the QA reviewer, the list and the
-- negotiated date here, and how urgent it is belongs in the same decision.
--
-- Reproduced in full from 20260804140000_p2_06_target_list.sql with the
-- parameter and one insert column added. Nothing else changes.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_approve_request(
  p_request_id           uuid,
  p_assignee_id          uuid,
  p_qa_assignee_id       uuid,
  p_approved_target_date date default null,
  p_title                text default null,
  p_description          text default null,
  p_list_id              uuid default null,
  p_priority             vizserve_pms_task_priority default null
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

  select f.department_id, f.default_list_id
    into v_department_id, v_list_id
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  -- The TL's choice wins; the form's default is the fallback. Null from the
  -- caller means "unchanged", not "clear it" — clearing is not something the
  -- review screen offers, and treating an absent parameter as a deletion is how
  -- a default silently stops applying.
  v_list_id := coalesce(p_list_id, v_list_id);

  perform vizserve_pms_record_decision(
    'request', p_request_id, v_department_id, 'approved', null
  );

  if p_assignee_id is null then
    raise exception 'Choose who will do the work.' using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_assignee_id and u.is_active and u.primary_department_id = v_department_id
  ) then
    raise exception 'That assignee is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  if p_qa_assignee_id is not null and not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_qa_assignee_id and u.is_active
       and (u.primary_department_id = v_department_id
            or vizserve_pms_manages_department_for(u.id, v_department_id))
  ) then
    raise exception 'That QA reviewer is not available for this department.'
      using errcode = 'check_violation';
  end if;

  -- Same rule as manual creation: a list belongs to one department, and a task
  -- filed under another department's list is invisible to the team that owns it.
  if v_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = v_list_id and l.department_id = v_department_id
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  v_title       := coalesce(nullif(btrim(coalesce(p_title, '')), ''), v_request.title);
  v_description := coalesce(nullif(btrim(coalesce(p_description, '')), ''), v_request.description);
  v_due         := coalesce(p_approved_target_date, v_request.target_date);

  update vizserve_pms_requests
     set status               = 'APPROVED',
         approved_target_date = v_due,
         title                = v_title,
         description          = v_description,
         reviewed_by          = auth.uid(),
         reviewed_at          = now()
   where id = p_request_id
  returning reference_no into v_reference;

  insert into vizserve_pms_tasks (
    request_id, department_id, list_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, field_values, created_by, priority
  ) values (
    p_request_id, v_department_id, v_list_id, v_title, v_description, 'OPEN',
    p_assignee_id, p_qa_assignee_id, v_due, v_request.field_values, auth.uid(), p_priority
  )
  returning id into v_task_id;

  -- P2-03 — recorded only when something genuinely changed. A trail where every
  -- approval logs an edit is a trail in which a real edit is invisible.
  if v_title is distinct from v_request.title
     or v_description is distinct from v_request.description
     or v_due is distinct from v_request.target_date
  then
    perform vizserve_pms_write_audit_log(
      'request', p_request_id, 'edited', auth.uid(),
      jsonb_build_object(
        'title', v_request.title,
        'description', v_request.description,
        'target_date', v_request.target_date
      ),
      jsonb_build_object(
        'title', v_title,
        'description', v_description,
        'approved_target_date', v_due
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
      'priority', p_priority
    )
  );

  perform vizserve_pms_notify(
    p_assignee_id,
    'assigned',
    'Assigned to you: ' || v_reference,
    v_title,
    'task',
    v_task_id,
    '/tasks/' || v_task_id::text
  );

  if p_qa_assignee_id is not null and p_qa_assignee_id <> p_assignee_id then
    perform vizserve_pms_notify(
      p_qa_assignee_id,
      'qa_requested',
      'You are QA on ' || v_reference,
      v_title,
      'task',
      v_task_id,
      '/tasks/' || v_task_id::text
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'task_id', v_task_id,
    'reference_no', v_reference,
    'approved_target_date', v_due,
    'list_id', v_list_id
  );
end;
$$;

-- The seven-argument version becomes ambiguous with the eight for any caller
-- that omits the last parameter. Same reason as P2-06's own drop, one line
-- above where that one used to be.
drop function if exists vizserve_pms_approve_request(uuid, uuid, uuid, date, text, text, uuid);

grant execute on function
  vizserve_pms_approve_request(uuid, uuid, uuid, date, text, text, uuid, vizserve_pms_task_priority)
  to authenticated, service_role;
