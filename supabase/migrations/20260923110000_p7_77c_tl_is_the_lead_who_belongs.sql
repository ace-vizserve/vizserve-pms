-- P7-77c — "Team Leader" means the department's lead who BELONGS to it.
--
-- P7-77 and P7-77b picked Team Leaders by `role = 'team_leader'`. VizBytes has
-- nobody with that role: its lead, Amier, is an `owner`. So from P7-77b on, a
-- VizBytes request notified NOBODY at submission, and its approval notified no
-- Team Leader.
--
-- The rule, settled 23 Sep 2026: a department's Team Leader is somebody who
-- leads it (`vizserve_pms_user_managed_departments`) AND whose home department
-- (`primary_department_id`) is that department. Any role. For VizBytes that is
-- Amier alone; Joel (VizAssists) and the managers with no home department lead
-- it without belonging to it, and are not told.
--
-- ⚠️ Who may APPROVE is unchanged — still `role >= 'team_leader'` over managed
-- departments. This decides only who is notified.
--
-- ⚠️ A department whose leads all have another home department (or none) now
-- notifies nobody at Gate 1. They still see requests in /requests.
--
-- Both functions reproduced whole from the files that last defined them, with
-- only the marked filters changed:
--
--   vizserve_pms_approve_request   20260923090100_p7_77_gate1_recipients.sql
--   vizserve_pms_submit_request    20260923100000_p7_77b_submission_tl_only.sql
--
-- Signatures unchanged; grants survive. approve_request's restated anyway.
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

  -- P7-77. The PIC and the QA reviewer are both on the task's assignee list.
  -- `assignee_id` and `qa_assignee_id` still name their roles; this is who is
  -- working on it. The PIC's row cannot be removed later on a client task —
  -- P7-43's remove function refuses it and says "reassign instead".
  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  select v_task_id, person, auth.uid()
    from unnest(array[p_assignee_id, p_qa_assignee_id]) as person
   where person is not null
  on conflict (task_id, user_id) do nothing;

  -- P7-77c. The department's Team Leaders: leads who belong to it, any role.
  -- Anyone already told as PIC or QA above is skipped rather than emailed twice.
  perform vizserve_pms_notify(
    md.user_id,
    'request_approved',
    'Approved: ' || v_title || ' (' || v_reference || ')',
    'Now a task.',
    'task',
    v_task_id,
    '/tasks/' || v_task_id::text
  )
  from vizserve_pms_user_managed_departments md
  join vizserve_pms_users u on u.id = md.user_id
  where md.department_id = v_department_id
    and u.is_active
    and u.primary_department_id = v_department_id
    and md.user_id <> p_assignee_id
    and md.user_id is distinct from p_qa_assignee_id;

  return jsonb_build_object(
    'ok', true,
    'task_id', v_task_id,
    'reference_no', v_reference,
    'approved_target_date', v_due,
    'list_id', v_list_id
  );
end;
$$;

grant execute on function vizserve_pms_approve_request(
  uuid, uuid, uuid, date, text, text, uuid, vizserve_pms_task_priority
) to authenticated;

-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_submit_request(
  p_slug        text,
  p_payload     jsonb,
  p_attachments jsonb default '[]'::jsonb,
  p_ip          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_form          vizserve_pms_forms;
  v_limits        vizserve_pms_public_submission_limits;
  v_field         record;
  v_errors        jsonb := '{}'::jsonb;
  v_value         jsonb;
  v_field_values  jsonb := '{}'::jsonb;
  v_email         text := btrim(coalesce(p_payload ->> 'requester_email', ''));
  v_name          text := btrim(coalesce(p_payload ->> 'requester_name', ''));
  v_title         text := btrim(coalesce(p_payload ->> 'title', ''));
  v_description   text := btrim(coalesce(p_payload ->> 'description', ''));
  v_target_date   text := nullif(btrim(coalesce(p_payload ->> 'target_date', '')), '');
  v_org           text := nullif(btrim(coalesce(p_payload ->> 'requester_org', '')), '');
  v_parsed_date   date;
  v_reference_no  text;
  v_request_id    uuid;
  v_recent_ip     integer;
  v_recent_email  integer;
  v_valid_files   integer := 0;
begin
  select * into v_form
    from vizserve_pms_forms
   where slug = p_slug and is_public and is_active;

  if v_form.id is null then
    return jsonb_build_object('ok', false, 'error', 'form_not_found');
  end if;

  -- --- rate limiting (P1-15) ----------------------------------------------
  select * into v_limits from vizserve_pms_public_submission_limits where id;

  select count(*) into v_recent_ip
    from vizserve_pms_public_submission_log
   where ip = p_ip
     and p_ip is not null
     and created_at > now() - interval '1 hour';

  select count(*) into v_recent_email
    from vizserve_pms_public_submission_log
   where email = v_email
     and v_email <> ''
     and created_at > now() - interval '1 hour';

  if v_recent_ip >= v_limits.per_ip_per_hour or v_recent_email >= v_limits.per_email_per_hour then
    insert into vizserve_pms_public_submission_log (form_id, ip, email, accepted)
    values (v_form.id, p_ip, nullif(v_email, ''), false);

    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- --- core identity + completeness ---------------------------------------
  if v_name = '' then
    v_errors := v_errors || jsonb_build_object('requester_name', 'Your name is required.');
  end if;

  if v_email = '' then
    v_errors := v_errors || jsonb_build_object('requester_email', 'An email address is required.');
  elsif v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    v_errors := v_errors || jsonb_build_object('requester_email', 'Enter a valid email address.');
  end if;

  if v_title = '' then
    v_errors := v_errors || jsonb_build_object('title', 'A short title is required.');
  end if;

  if v_description = '' then
    v_errors := v_errors || jsonb_build_object('description', 'A description is required.');
  end if;

  if v_target_date is null then
    v_errors := v_errors || jsonb_build_object('target_date', 'A target date is required.');
  else
    begin
      v_parsed_date := v_target_date::date;
    exception when others then
      v_errors := v_errors || jsonb_build_object('target_date', 'Enter a valid date.');
    end;
  end if;

  -- --- per-form fields ------------------------------------------------------
  for v_field in
    select * from vizserve_pms_form_fields
     where form_id = v_form.id and is_active
     order by sort_order
  loop
    v_value := p_payload -> 'field_values' -> v_field.field_key;

    if v_field.is_required and vizserve_pms_jsonb_value_is_blank(v_value) then
      v_errors := v_errors || jsonb_build_object(v_field.field_key, v_field.label || ' is required.');
      continue;
    end if;

    if vizserve_pms_jsonb_value_is_blank(v_value) then
      continue;
    end if;

    if v_field.field_type = 'number' then
      if jsonb_typeof(v_value) <> 'number' and (v_value #>> '{}') !~ '^-?\d+(\.\d+)?$' then
        v_errors := v_errors || jsonb_build_object(v_field.field_key, v_field.label || ' must be a number.');
        continue;
      end if;

    elsif v_field.field_type = 'email' then
      if (v_value #>> '{}') !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        v_errors := v_errors || jsonb_build_object(v_field.field_key, v_field.label || ' must be a valid email.');
        continue;
      end if;

    elsif v_field.field_type = 'date' then
      begin
        perform (v_value #>> '{}')::date;
      exception when others then
        v_errors := v_errors || jsonb_build_object(v_field.field_key, v_field.label || ' must be a valid date.');
        continue;
      end;

    elsif v_field.field_type = 'select' then
      if not (v_field.options ? (v_value #>> '{}')) then
        v_errors := v_errors || jsonb_build_object(v_field.field_key, 'Choose one of the listed options.');
        continue;
      end if;

    elsif v_field.field_type = 'multiselect' then
      if jsonb_typeof(v_value) <> 'array' then
        v_errors := v_errors || jsonb_build_object(v_field.field_key, 'Choose from the listed options.');
        continue;
      end if;
      if exists (
        select 1 from jsonb_array_elements_text(v_value) as choice
         where not (v_field.options ? choice)
      ) then
        v_errors := v_errors || jsonb_build_object(v_field.field_key, 'Choose from the listed options.');
        continue;
      end if;

    elsif v_field.field_type = 'file' then
      -- A required file field is satisfied by a REDEEMABLE RECEIPT for this
      -- form, not by the payload containing something file-shaped.
      if v_field.is_required and not exists (
        select 1
          from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) as item
          join vizserve_pms_pending_attachments pa
            on pa.id = vizserve_pms_try_uuid(item ->> 'id')
         where pa.form_id = v_form.id
           and coalesce(item ->> 'field_key', pa.field_key) = v_field.field_key
      ) then
        v_errors := v_errors || jsonb_build_object(v_field.field_key, v_field.label || ' is required.');
      end if;

      -- Files live in request_attachments, never in field_values.
      continue;
    end if;

    v_field_values := v_field_values || jsonb_build_object(v_field.field_key, v_value);
  end loop;

  -- --- form-level attachment requirement ------------------------------------
  if v_form.requires_attachment then
    select count(*) into v_valid_files
      from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) as item
      join vizserve_pms_pending_attachments pa
        on pa.id = vizserve_pms_try_uuid(item ->> 'id')
     where pa.form_id = v_form.id;

    if v_valid_files = 0 then
      v_errors := v_errors || jsonb_build_object('attachments', 'At least one attachment is required.');
    end if;
  end if;

  if v_errors <> '{}'::jsonb then
    insert into vizserve_pms_public_submission_log (form_id, ip, email, accepted)
    values (v_form.id, p_ip, nullif(v_email, ''), false);

    return jsonb_build_object('ok', false, 'error', 'validation_failed', 'field_errors', v_errors);
  end if;

  -- --- accept ---------------------------------------------------------------
  v_reference_no := vizserve_pms_next_reference_no(v_form.id);

  insert into vizserve_pms_requests (
    form_id, reference_no, requester_name, requester_email, requester_org,
    title, description, target_date, field_values, status,
    sla_started_at, submitted_at
  ) values (
    v_form.id, v_reference_no, v_name, v_email, coalesce(v_org, 'HFSE'),
    v_title, v_description, v_parsed_date, v_field_values, 'PENDING_REVIEW',
    now(), now()
  )
  returning id into v_request_id;

  perform vizserve_pms_redeem_attachments(v_request_id, v_form.id, coalesce(p_attachments, '[]'::jsonb));

  insert into vizserve_pms_public_submission_log (form_id, ip, email, accepted)
  values (v_form.id, p_ip, v_email, true);

  perform vizserve_pms_write_audit_log(
    'request', v_request_id, 'submitted', null, null,
    jsonb_build_object('reference_no', v_reference_no, 'form_id', v_form.id, 'ip', p_ip)
  );

  perform vizserve_pms_notify(
    md.user_id,
    'pending_approval',
    v_title || ' (' || v_reference_no || ')',
    -- The body no longer repeats the title, which the line above now carries.
    -- It answers the only question left: who sent it.
    'From ' || v_name,
    'request',
    v_request_id,
    '/requests/' || v_request_id::text
  )
  from vizserve_pms_user_managed_departments md
  join vizserve_pms_users u on u.id = md.user_id
  where md.department_id = v_form.department_id
    and u.is_active
    -- P7-77c. Team Leaders only: leads who belong to the department, any
    -- role. Who MAY approve is unchanged — this decides only who is told.
    and u.primary_department_id = v_form.department_id;

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request_id,
    'reference_no', v_reference_no
  );
end;
$$;
