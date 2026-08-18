-- P7-00 — the ownership guard fell through when a seat was empty.
--
-- THIS IS A SECURITY FIX, and it is the whole file. Nothing else changes.
--
-- `vizserve_pms_transition_task` decided who may move a task like this:
--
--   v_is_pic := v_task.assignee_id    = v_actor;
--   v_is_qa  := v_task.qa_assignee_id = v_actor;
--   if not (v_is_pic or v_is_qa or v_leads) then raise ...
--
-- `qa_assignee_id` is nullable. Comparing NULL with `=` yields NULL, not false.
-- So for a task with no QA reviewer, and a caller who is neither the PIC nor a
-- department lead, the expression was:
--
--   not (false or NULL or false)  ->  not NULL  ->  NULL
--
-- and `IF NULL THEN` does not fire. The guard did not reject — it evaluated to
-- unknown and fell straight through. Any signed-in user could then move that
-- task, including FOR_QA -> QA_IN_PROGRESS -> FOR_CLIENT_APPROVAL, which is the
-- transition that emails the real client.
--
-- This was demonstrated before it was fixed. `tests/db/tasks.test.ts`, describe
-- "the ownership guard holds when a seat is empty": a member of ANOTHER
-- department moved a QA-less task and the call returned no error. The same
-- caller was correctly refused on a task whose QA seat was filled, which is what
-- makes the condition precisely "the seat is NULL" rather than anything about
-- who was calling.
--
-- Three-valued logic reads as correct forever, which is why this sat unnoticed:
-- the code says exactly what it means and still does not do it.
--
-- The function body below is character-for-character the one from
-- 20260803130000_p3_tasks_qa.sql apart from the three assignments. Same
-- signature, so this is a plain `create or replace` — no drop, no re-grant.
--
-- ⚠️ ANY FUTURE `create or replace` OF THIS FUNCTION MUST CARRY THE COALESCE
--    FORWARD. Replacing the body reintroduces the hole silently. The tests named
--    above are what catch that.

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
  v_reference  text;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- THE FIX. An unset seat is "not you", never "unknown". Both columns are
  -- nullable, so both comparisons need it.
  --
  -- `v_leads` is wrapped too, even though vizserve_pms_manages_department cannot
  -- return null today. The point is that this guard stops DEPENDING on that
  -- staying true: a boolean that decides authorization should be a boolean.
  v_is_pic := coalesce(v_task.assignee_id    = v_actor, false);
  v_is_qa  := coalesce(v_task.qa_assignee_id = v_actor, false);
  v_leads  := coalesce(vizserve_pms_manages_department(v_task.department_id), false);

  -- Being able to SEE a task is not being able to move it. A member of the
  -- department who is neither PIC nor QA has no business advancing it.
  if not (v_is_pic or v_is_qa or v_leads) then
    raise exception 'That task is not yours to move.' using errcode = 'insufficient_privilege';
  end if;

  if v_task.status = p_to_status then
    raise exception 'That task is already %.', p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_rule
    from vizserve_pms_task_transitions
   where from_status = v_task.status and to_status = p_to_status;

  -- Every illegal transition rejected server-side, by construction: if it is not
  -- in the table it does not happen.
  if v_rule.to_status is null then
    raise exception 'A task cannot go from % to %.', v_task.status, p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Who may make THIS move. A TL leading the department may act in either seat
  -- (they are frequently the QA), but a member cannot QA their own work by
  -- moving it past the gate themselves.
  --
  -- These two branches had the same NULL fall-through as the guard above — an
  -- unset QA seat made `not (v_is_qa or v_leads)` unknown, so the 'qa' rule
  -- admitted anyone who got past the first check. Fixed at the source: both
  -- variables are now always boolean, so these read as written.
  if v_rule.actor = 'pic' and not (v_is_pic or v_leads) then
    raise exception 'Only the person in charge can do that.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_rule.actor = 'qa' and not (v_is_qa or v_leads) then
    raise exception 'Only the QA reviewer can do that.'
      using errcode = 'insufficient_privilege';
  end if;

  -- The client and system rows belong to Phase 4. Until then only an admin may
  -- exercise them, which is what makes them testable now without a token.
  if v_rule.actor in ('client', 'system') and not vizserve_pms_is_admin() then
    raise exception 'That transition is made by the client, not from here.'
      using errcode = 'insufficient_privilege';
  end if;

  -- --- the gates ------------------------------------------------------------
  if v_rule.required_field = 'resolution'
     and (v_task.resolution is null or length(btrim(v_task.resolution)) = 0) then
    raise exception 'Record what you did in the resolution before sending this for QA.'
      using errcode = 'check_violation';
  end if;

  if v_rule.required_field = 'comment' and v_comment is null then
    raise exception 'A comment is required for that.' using errcode = 'check_violation';
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
