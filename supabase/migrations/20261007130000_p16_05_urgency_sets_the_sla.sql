-- P16-05 — the Team Leader sets the urgency; the SLA date follows (7 Oct 2026).
--
-- Each client form carries two numbers, in working days: Urgent (default 3)
-- and Non-urgent (default 5). At Gate 1 the Team Leader picks one, and the due
-- date is that many working days from the approval — weekends and holidays
-- skipped (vizserve_pms_add_business_days). It is read-only: the date picker
-- that let Gate 1 type a date is gone. The client's ideal finish date stays on
-- the request for context and is never the due date, so metrics measure the
-- team against the SLA.
--
-- The urgency can be changed later by the same people; the date is recomputed
-- from the day it was approved and the task's due date follows. Audited.
--
-- vizserve_pms_approve_request changes signature (urgency in, the date, list
-- and priority parameters out), so the old one is dropped first. Priority
-- follows the urgency: Urgent → Urgent, Non-urgent → Normal.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p16_02. Never `db:push`.

alter table vizserve_pms_forms
  add column if not exists urgent_days integer not null default 3,
  add column if not exists normal_days integer not null default 5;

alter table vizserve_pms_forms
  drop constraint if exists vizserve_pms_forms_urgency_days_range,
  add constraint vizserve_pms_forms_urgency_days_range
    check (urgent_days between 1 and 60 and normal_days between 1 and 60);

alter table vizserve_pms_requests
  add column if not exists urgency text;

alter table vizserve_pms_requests
  drop constraint if exists vizserve_pms_requests_urgency_shape,
  add constraint vizserve_pms_requests_urgency_shape
    check (urgency is null or urgency in ('URGENT', 'NON_URGENT'));

comment on column vizserve_pms_requests.urgency is
  'P16-05. Set at Gate 1. With the form''s urgent_days / normal_days it decides approved_target_date — the SLA due date.';


drop function if exists vizserve_pms_approve_request(uuid, uuid, uuid, date, text, text, uuid, vizserve_pms_task_priority);

-- Same function as p16_02 otherwise.
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

grant execute on function vizserve_pms_approve_request(uuid, uuid, uuid, text, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Change the urgency after Gate 1.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_set_request_urgency(p_request_id uuid, p_urgency text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request       vizserve_pms_requests;
  v_department_id uuid;
  v_days          integer;
  v_due           date;
  v_task_id       uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;
  if p_urgency is null or p_urgency not in ('URGENT', 'NON_URGENT') then
    raise exception 'Choose Urgent or Non-urgent.' using errcode = 'check_violation';
  end if;

  select * into v_request from vizserve_pms_requests where id = p_request_id for update;
  if v_request.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;
  if v_request.status <> 'APPROVED' then
    raise exception 'Only approved work has an urgency to change.' using errcode = 'invalid_parameter_value';
  end if;

  select f.department_id,
         case p_urgency when 'URGENT' then f.urgent_days else f.normal_days end
    into v_department_id, v_days
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  if not vizserve_pms_can_approve(v_department_id) then
    raise exception 'Only this department''s Team Leader or the Manager can change it.'
      using errcode = 'insufficient_privilege';
  end if;

  select t.id into v_task_id from vizserve_pms_tasks t where t.request_id = p_request_id;
  if v_task_id is not null and exists (
    select 1 from vizserve_pms_tasks t
     where t.id = v_task_id and t.status in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
  ) then
    raise exception 'That work is already closed.' using errcode = 'invalid_parameter_value';
  end if;

  -- From the day it was approved, so changing it does not restart the clock.
  v_due := (vizserve_pms_add_business_days(coalesce(v_request.reviewed_at, now()), v_days)
            at time zone 'Asia/Manila')::date;

  update vizserve_pms_requests
     set urgency = p_urgency, approved_target_date = v_due
   where id = p_request_id;

  if v_task_id is not null then
    update vizserve_pms_tasks
       set due_date = v_due,
           priority = case p_urgency when 'URGENT' then 'URGENT' else 'NORMAL' end::vizserve_pms_task_priority
     where id = v_task_id;
  end if;

  perform vizserve_pms_write_audit_log(
    'request', p_request_id, 'urgency_changed', auth.uid(),
    jsonb_build_object('urgency', v_request.urgency, 'approved_target_date', v_request.approved_target_date),
    jsonb_build_object('urgency', p_urgency, 'approved_target_date', v_due)
  );

  return jsonb_build_object('ok', true, 'urgency', p_urgency, 'approved_target_date', v_due);
end;
$$;

revoke all on function vizserve_pms_set_request_urgency(uuid, text) from public, anon;
grant execute on function vizserve_pms_set_request_urgency(uuid, text) to authenticated;
