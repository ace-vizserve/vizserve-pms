-- P16-02 — one list per client form, and a request can be cancelled (7 Oct 2026).
--
-- 1. The list. A client form files into ITS OWN list in Client Requests — the
--    one vizserve_pms_ensure_form_list creates on first publish — and nowhere
--    else. Gate 1 no longer picks a list, the form settings no longer pick one,
--    and a task that came from a form cannot be moved out of that list.
--    `default_list_id` is re-pointed at the own list so every reader agrees.
--
-- 2. CANCELLED. A new request status, separate from REJECTED so a wrong-form
--    submission or a duplicate is not counted as a refusal. A Team Leader or the
--    Manager (vizserve_pms_can_approve, the Gate 1 authority) cancels with a
--    reason while the request is pending or returned. Cancelling approved work
--    arrives with task cancellation (P16-03).
--
-- ⚠️ APPLY BY HAND in the SQL editor. Never `db:push`. `add value` cannot run
-- inside a transaction block on older Postgres; if the editor refuses it, run
-- the first statement alone, then the rest.

alter type vizserve_pms_request_status add value if not exists 'CANCELLED';


-- ---------------------------------------------------------------------------
-- 1a. Every client form points at its own list.
-- ---------------------------------------------------------------------------
update vizserve_pms_forms f
   set default_list_id = l.id
  from vizserve_pms_lists l
 where l.form_id = f.id
   and f.purpose = 'CLIENT_REQUEST'
   and f.default_list_id is distinct from l.id;


-- ---------------------------------------------------------------------------
-- 1b. Gate 1 approves into the form's own list. Same function as
--     20260930180000_p14_12_client_flow_complete.sql; only the list changed.
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

  select f.department_id into v_department_id
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  -- P16-02. Always the form's own list. `p_list_id` is ignored — kept only so
  -- the signature does not change under a caller.
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


-- ---------------------------------------------------------------------------
-- 1c. A task from a client form stays in its form's list.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_tasks_request_list_lock()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if old.request_id is not null and new.list_id is distinct from old.list_id then
    raise exception 'A task from a client form stays in that form''s list.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_tasks_request_list_lock on vizserve_pms_tasks;
create trigger vizserve_pms_tasks_request_list_lock
  before update of list_id on vizserve_pms_tasks
  for each row execute function vizserve_pms_tasks_request_list_lock();


-- ---------------------------------------------------------------------------
-- 2. Cancel a request.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_cancel_request(p_request_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request       vizserve_pms_requests;
  v_department_id uuid;
  v_reason        text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select r.* into v_request
    from vizserve_pms_requests r
   where r.id = p_request_id
   for update;

  if v_request.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  select f.department_id into v_department_id
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  if not vizserve_pms_can_approve(v_department_id) then
    raise exception 'Only this department''s Team Leader or the Manager can cancel it.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_request.status not in ('PENDING_REVIEW', 'RETURNED') then
    raise exception 'That request has already been %.', lower(v_request.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  if v_reason is null then
    raise exception 'Say why it is being cancelled.' using errcode = 'check_violation';
  end if;

  update vizserve_pms_requests
     set status          = 'CANCELLED',
         decision_reason = v_reason,
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_request_id;

  perform vizserve_pms_write_audit_log(
    'request', p_request_id, 'cancelled', auth.uid(),
    jsonb_build_object('status', v_request.status),
    jsonb_build_object('status', 'CANCELLED', 'reason', v_reason)
  );

  return jsonb_build_object(
    'ok', true,
    'status', 'CANCELLED',
    'reference_no', v_request.reference_no,
    'requester_email', v_request.requester_email,
    'requester_name', v_request.requester_name,
    'title', v_request.title
  );
end;
$$;

revoke all on function vizserve_pms_cancel_request(uuid, text) from public, anon;
grant execute on function vizserve_pms_cancel_request(uuid, text) to authenticated;
