-- P7-02 — every kind of work gets exactly one way to finish.
--
-- Before this file the ONLY route to COMPLETED was
-- FOR_CLIENT_APPROVAL -> COMPLETED with actor 'client'. That is correct for work
-- a client asked for and absurd for anything else: a personal task would have
-- had to be signed off by a client who does not exist.
--
-- Worse, the gate was open in both directions. Any task could be pushed into
-- FOR_CLIENT_APPROVAL, including one with no request — where
-- `vizserve_pms_issue_approval_token` refuses to mint a token ("That task has no
-- client to approve it") and the task then sits in a state with no legal exit
-- for anyone below admin. Closing that entry is what forces internal work to
-- have an ending of its own, which is the third row added below.
--
--   request   QA passes it -> FOR_CLIENT_APPROVAL -> the client decides
--   internal  QA passes it -> COMPLETED, because there is nobody outside to ask
--   personal  the person who made it marks it done
--
-- ⚠️ THIS FILE REPLACES `vizserve_pms_transition_task`, WHICH 20260818080000
--    JUST SECURITY-FIXED. The `coalesce(..., false)` guards are carried forward
--    below. Drop them and the P7-00 hole reopens silently — the tests in
--    tests/db/tasks.test.ts under "the ownership guard holds when a seat is
--    empty" are what catch that.

-- ---------------------------------------------------------------------------
-- Which tasks a rule applies to.
--
-- 'request' rather than 'client': `actor` already uses 'client' to mean "the
-- external client is the one who decides", and a neighbouring column where
-- 'client' meant "this task came from a client" would be two meanings of one
-- word in adjacent columns of the same row.
--
-- The primary key stays (from_status, to_status). One rule per pair means the
-- function looks it up and then checks compatibility — one step. Putting
-- applies_to in the key would allow several rows per pair and require
-- "prefer the specific over the general" resolution logic, which the TypeScript
-- mirror in lib/schemas/tasks.ts would then have to reimplement identically.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_task_transitions
  add column applies_to text not null default 'any'
  check (applies_to in ('any', 'personal', 'internal', 'request'));

comment on column vizserve_pms_task_transitions.applies_to is
  'any | personal | internal | request. `internal` includes personal work: a '
  'personal task is internal work whose owner may also close it directly.';

-- Only work with a client goes to the client.
update vizserve_pms_task_transitions
   set applies_to = 'request'
 where from_status = 'QA_IN_PROGRESS'
   and to_status   = 'FOR_CLIENT_APPROVAL';

-- The three FOR_CLIENT_APPROVAL -> * rows stay 'any' ON PURPOSE.
-- `vizserve_pms_force_task_status` does not read this table at all, so a TL can
-- still force a task into that state. Scoping the EXITS as well would leave a
-- forced task there permanently — gate the entry, never the way out.

insert into vizserve_pms_task_transitions
  (from_status, to_status, actor, required_field, applies_to)
values
  -- You made it for yourself, you close it. Still gated on a resolution: every
  -- other path to COMPLETED runs through ONGOING -> FOR_QA, which demands one,
  -- and "every completed task says what was done" is the invariant Phase 6
  -- reporting and the timesheet review both read.
  ('ONGOING', 'COMPLETED', 'pic', 'resolution', 'personal'),
  -- Reviewed, and there is nobody outside to sign it off. Only a QA reviewer
  -- reaches this, so it grants no authority that did not already exist — it
  -- restores an exit that closing the client gate would otherwise have removed.
  ('QA_IN_PROGRESS', 'COMPLETED', 'qa', null, 'internal');

-- ---------------------------------------------------------------------------
-- The state machine, taught about categories.
--
-- Same signature as before, so this is a plain `create or replace`: no drop, no
-- re-grant.
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

  -- P7-00, carried forward. An unset seat is "not you", never "unknown":
  -- comparing a NULL column with `=` yields NULL, `not NULL` is NULL, and
  -- `IF NULL THEN` does not fire. Without these three coalesces the guard below
  -- falls through entirely on any task with an empty QA seat.
  v_is_pic := coalesce(v_task.assignee_id    = v_actor, false);
  v_is_qa  := coalesce(v_task.qa_assignee_id = v_actor, false);
  v_leads  := coalesce(vizserve_pms_manages_department(v_task.department_id), false);

  -- The same three-way split the TypeScript mirror computes in `taskCategory`.
  -- A request wins over the personal flag: a task with a client behind it is
  -- client work whatever else is set on it.
  v_category := case
                  when v_task.request_id is not null then 'request'
                  when v_task.is_personal            then 'personal'
                  else 'internal'
                end;

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

  -- --- the category gate ----------------------------------------------------
  -- Three separate sentences rather than one generic refusal. A single message
  -- on all three branches is the thing that turns "the system explained itself"
  -- into "the system said no and I filed a bug".
  if v_rule.applies_to = 'request' and v_category <> 'request' then
    raise exception 'There is no client to approve this one. It finishes here.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_rule.applies_to = 'personal' and v_category <> 'personal' then
    raise exception 'This one was assigned to you, so it goes through review.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- 'internal' admits personal work too — a personal task is internal work.
  if v_rule.applies_to = 'internal' and v_category = 'request' then
    raise exception 'This has a client behind it — it finishes when they sign off, not here.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Who may make THIS move. A TL leading the department may act in either seat
  -- (they are frequently the QA), but a member cannot QA their own work by
  -- moving it past the gate themselves.
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
