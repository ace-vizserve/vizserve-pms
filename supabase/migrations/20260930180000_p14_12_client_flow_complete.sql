-- P14-12 — THE CLIENT REQUEST FLOW, COMPLETE (30 Sep 2026).
--
-- The client request process was missing its middle: PIC and QA assignment,
-- the QA hand-off and QA sending work back all lived under "Tasks", because the
-- same task functions serve internal tasks too. The client flow now has its own
-- stages for them, emitted whenever the task belongs to a client request;
-- internal tasks keep the Tasks events.
--
-- Every event also gets an explicit KIND — a numbered step, an outcome, or a
-- side event — and each side event says where it BRANCHES FROM and where the
-- work RETURNS TO (or that it ends the process), so the settings screen draws
-- the flow — loops included — from data rather than guessing from sort order.
-- A "Sent to the client" step (Gate 3) is added so "Client asked for changes"
-- has a step to branch from; nobody is told at it by default.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p14_11. Never `db:push`.


-- ===========================================================================
-- 1. KIND.
-- ===========================================================================
alter table vizserve_pms_notification_events
  add column if not exists stage_kind text not null default 'step'
    check (stage_kind in ('step', 'outcome', 'side', 'event'));

-- Where a SIDE event leaves the flow and where the work goes next. A null
-- branch_from means "at any step"; a null returns_to means it ends the process.
alter table vizserve_pms_notification_events
  add column if not exists branch_from text references vizserve_pms_notification_events (key),
  add column if not exists returns_to  text references vizserve_pms_notification_events (key);


-- ===========================================================================
-- 2. THE CLIENT FLOW'S TASK STAGES.
-- ===========================================================================
insert into vizserve_pms_notification_events
  (key, flow, flow_label, flow_sort, stage_label, sort, notification_type, ends_flow, description)
values
  ('client.pic_assigned',  'client_request', 'Client requests', 1, 'PIC assigned',     3, 'assigned',     false, 'The Team Leader chose who does the work.'),
  ('client.qa_assigned',   'client_request', 'Client requests', 1, 'QA assigned',      4, 'qa_requested', false, 'The Team Leader chose who checks it.'),
  ('client.ready_for_qa',  'client_request', 'Client requests', 1, 'Ready for QA',     5, 'qa_requested', false, 'The PIC finished and handed it to QA.'),
  ('client.qa_returned',   'client_request', 'Client requests', 1, 'QA sent it back',  6, 'qa_returned',  false, 'QA found something to fix.'),
  ('client.sent_to_client','client_request', 'Client requests', 1, 'Sent to the client', 7, 'status_changed', false, 'QA passed it and the client was emailed to approve it.')
on conflict (key) do nothing;

update vizserve_pms_notification_events set sort = 8  where key = 'client.approved';
update vizserve_pms_notification_events set sort = 9  where key = 'client.changes_requested';
update vizserve_pms_notification_events set sort = 10 where key = 'client.no_response';

-- Same recipients and switches as the Tasks event each one mirrors.
insert into vizserve_pms_notification_rules (event_key, audience_kind, audience, user_id, in_app, email, locked)
select m.client_key, r.audience_kind, r.audience, r.user_id, r.in_app, r.email, r.locked
  from (values
    ('client.pic_assigned', 'task.assigned'),
    ('client.qa_assigned',  'task.qa_assigned'),
    ('client.ready_for_qa', 'task.ready_for_qa'),
    ('client.qa_returned',  'task.qa_returned')
  ) as m(client_key, task_key)
  join vizserve_pms_notification_rules r on r.event_key = m.task_key
on conflict do nothing;

-- The PIC rule on assignment was keyed `assignee`; approve_request supplies it
-- under that name, so it carries over unchanged.


-- ===========================================================================
-- 2b. NO LOCKED IN-APP. Admin can switch anybody's in-app notification off;
-- the approvals queue and the top-bar notice still show pending work. `locked`
-- stays only to group "needs to act" recipients on the screen.
-- ===========================================================================
alter table vizserve_pms_notification_rules
  drop constraint if exists vizserve_pms_notification_rules_locked_in_app;


-- ===========================================================================
-- 3. EVERY EVENT'S KIND.
-- ===========================================================================
update vizserve_pms_notification_events set stage_kind = 'outcome' where ends_flow;

update vizserve_pms_notification_events set stage_kind = 'side' where key in (
  'client.qa_returned', 'client.changes_requested',
  'leave.withdrawn', 'internal.withdrawn',
  'timesheet.returned', 'timesheet.withdrawn'
);

-- Tasks are not a sequence: their events happen in any order, any number of times.
update vizserve_pms_notification_events set stage_kind = 'event' where flow = 'task';

-- Where each side event branches off, and where the work goes next.
update vizserve_pms_notification_events e
   set branch_from = v.branch_from, returns_to = v.returns_to
  from (values
    ('client.qa_returned',       'client.ready_for_qa',   'client.pic_assigned'),
    ('client.changes_requested', 'client.sent_to_client', 'client.pic_assigned'),
    ('timesheet.returned',       'timesheet.submitted',   'timesheet.submitted'),
    ('timesheet.withdrawn',      'timesheet.submitted',        null),
    ('leave.withdrawn',          'leave.reliever_asked',       null),
    ('internal.withdrawn',       'internal.team_leader_step',  null)
  ) as v(key, branch_from, returns_to)
 where e.key = v.key;


-- ===========================================================================
-- 4. GATE 1 AND THE TASK STATUS CHANGES EMIT THE CLIENT STAGES.
--    The p14_10 bodies with only the event keys changed.
-- ===========================================================================
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

  -- P7-23. Checked beside "choose who will do the work" because it is the same
  -- kind of rule: an approval that does not say where the work goes is not a
  -- complete approval. The sentence names the way out, since a reviewer looking
  -- at a form with no inbox list cannot be expected to know P7-18 exists.
  if v_list_id is null then
    raise exception 'Choose the list this task will go under. This form has no default list set.'
      using errcode = 'check_violation';
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

  -- `field_values` travels with the task. It always has — the reason the
  -- client's answers looked "neglected" was P7-22's policy, and a form with no
  -- custom fields having nothing to carry. Left here as the note saying so.
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
    'list_id', v_list_id
  );
end;
$$;

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
