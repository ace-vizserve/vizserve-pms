-- P7-78 — QA sending work back EMAILS the PIC.
--
-- It was raised as `status_changed`, which is inbox-only by design (docs/12 §3:
-- ordinary movement is noise). A QA return is not ordinary movement — the PIC
-- has to act on it, the same test that makes `qa_requested` an email. So it
-- gets its own type, email on, and `status_changed` stays quiet for everything
-- else.
--
-- `vizserve_pms_transition_task` reproduced whole from
-- 20260921090000_p13_01_collaboration_space.sql; the only change is the type on
-- the QA-return notify. Signature unchanged, so grants survive.
--
-- ⚠️ APPLY 20260923120000 FIRST — it adds the enum value this file uses.
-- ---------------------------------------------------------------------------

insert into vizserve_pms_notification_type_settings (type, send_email, description) values
  ('qa_returned', true,
   'P7-78. QA sent a task back to its PIC. The PIC has to act, so it emails.')
on conflict (type) do nothing;

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
      -- P7-78. Its own type, so it emails; `status_changed` stays inbox-only.
      v_task.assignee_id, 'qa_returned',
      'QA sent back: ' || coalesce(v_reference, v_task.title),
      coalesce(v_comment, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'status', p_to_status);
end;
$$;
