-- P14-10 — PER-STAGE NOTIFICATION RULES, PHASE 2: EVERY PROCESS EMITS (30 Sep 2026).
--
-- Every function that notified anybody now calls vizserve_pms_emit with the
-- stage's event and the people the process names; the rules (P14-09) decide
-- who is told and how. A loop over recipients became ONE emit, so a role or
-- named-person rule fires once per event, not once per recipient.
--
-- Recipients are unchanged from today with one deliberate exception: "the
-- department's Team Leaders" is now vizserve_pms_team_leaders_of — people who
-- HOLD Team Leader and are assigned the department (P14-07) — for client
-- requests too, where it used to be "leads whose home department it is".
--
-- Each body is the live definition (named above it) with only its notify
-- calls replaced. vizserve_pms_notify stays for anything not yet moved.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p14_09. Never `db:push`.


-- ===========================================================================
-- Client submits
-- ===========================================================================
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

  perform vizserve_pms_emit(
    'client.submitted',
    jsonb_build_object('dept_team_leaders', coalesce((select jsonb_agg(t) from vizserve_pms_team_leaders_of(v_form.department_id) t), '[]'::jsonb)),
    v_title || ' (' || v_reference_no || ')',
    'From ' || v_name,
    'request', v_request_id, '/requests/' || v_request_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request_id,
    'reference_no', v_reference_no
  );
end;
$$;


-- ===========================================================================
-- Gate 1 approves
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
    'task.assigned',
    jsonb_build_object('assignee', jsonb_build_array(p_assignee_id)),
    'Assigned to you: ' || v_reference,
    v_title,
    'task', v_task_id, '/tasks/' || v_task_id::text
  );

  if p_qa_assignee_id is not null and p_qa_assignee_id <> p_assignee_id then
    perform vizserve_pms_emit(
      'task.qa_assigned',
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


-- ===========================================================================
-- Client decides
-- ===========================================================================
create or replace function vizserve_pms_record_client_decision(
  p_token         text,
  p_decision      vizserve_pms_client_decision,
  p_comment       text default null,
  p_approver_name text default null,
  p_ip            text default null,
  p_user_agent    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token     vizserve_pms_approval_tokens;
  v_task      vizserve_pms_tasks;
  v_reference text;
  v_comment   text := nullif(btrim(coalesce(p_comment, '')), '');
  v_new       vizserve_pms_task_status;
begin
  if p_decision = 'AUTO_COMPLETED' then
    raise exception 'Auto-completion is not a client decision.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Locked for the duration, so two clicks a millisecond apart cannot both pass
  -- the consumed check.
  select * into v_token
    from vizserve_pms_approval_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;

  if v_token.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_token.purpose <> 'approval' then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_token.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  -- Replay. The answer cannot be changed after the fact.
  if v_token.consumed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  select * into v_task from vizserve_pms_tasks where id = v_token.task_id for update;

  -- The token is bound to a task, so cross-task reuse is impossible by
  -- construction. This catches the other case: a task that has moved on since
  -- the email went out — auto-completed, or pulled back by a TL override.
  if v_task.status <> 'FOR_CLIENT_APPROVAL' then
    return jsonb_build_object('ok', false, 'error', 'no_longer_open');
  end if;

  if p_decision = 'REVISION_REQUESTED' and v_comment is null then
    return jsonb_build_object('ok', false, 'error', 'comment_required');
  end if;

  v_new := case p_decision when 'APPROVED' then 'COMPLETED' else 'ONGOING' end;

  update vizserve_pms_tasks set status = v_new where id = v_task.id;

  -- actor_id is NULL: the client is a real actor with no user row, and
  -- attributing their decision to whoever happened to be signed in would be a
  -- lie in the one record a dispute turns on.
  insert into vizserve_pms_task_status_history
    (task_id, from_status, to_status, actor_id, comment)
  values
    (v_task.id, v_task.status, v_new, null,
     coalesce(v_comment, 'Client approved.'));

  insert into vizserve_pms_client_decisions
    (task_id, token_id, decision, comment, approver_name, ip, user_agent)
  values
    (v_task.id, v_token.id, p_decision, v_comment,
     nullif(btrim(coalesce(p_approver_name, '')), ''), p_ip, p_user_agent);

  update vizserve_pms_approval_tokens set consumed_at = now() where id = v_token.id;

  select r.reference_no into v_reference
    from vizserve_pms_requests r where r.id = v_task.request_id;

  perform vizserve_pms_write_audit_log(
    'task', v_task.id, lower(p_decision::text), null,
    jsonb_build_object('status', v_task.status),
    jsonb_build_object(
      'status', v_new,
      'decision', p_decision,
      'comment', v_comment,
      'approver_name', nullif(btrim(coalesce(p_approver_name, '')), ''),
      'ip', p_ip
    )
  );

  -- Everyone who worked on it is told. A rejection means work resumes, and an
  -- approval closes the loop — both are worth an email (docs/12 §3).
  perform vizserve_pms_emit(
    case p_decision when 'APPROVED' then 'client.approved' else 'client.changes_requested' end,
    jsonb_build_object(
      'pic', jsonb_build_array(v_task.assignee_id),
      'qa', jsonb_build_array(v_task.qa_assignee_id),
      'assignees', coalesce((select jsonb_agg(a.user_id) from vizserve_pms_task_assignees a
                              where a.task_id = v_task.id), '[]'::jsonb),
      'dept_team_leaders', coalesce((select jsonb_agg(t) from vizserve_pms_team_leaders_of(v_task.department_id) t), '[]'::jsonb)
    ),
    case p_decision
      when 'APPROVED' then 'Client approved: ' || coalesce(v_reference, v_task.title)
      else 'Client asked for changes: ' || coalesce(v_reference, v_task.title)
    end,
    coalesce(v_comment, ''), 'task', v_task.id, '/tasks/' || v_task.id::text
  );

  -- task_id comes back so the caller can issue the feedback token. Safe to
  -- expose: the client already holds a token bound to this task, so it tells
  -- them nothing they could not already act on.
  return jsonb_build_object(
    'ok', true,
    'decision', p_decision,
    'status', v_new,
    'task_id', v_task.id
  );
end;
$$;


-- ===========================================================================
-- Client never answers
-- ===========================================================================
create or replace function vizserve_pms_auto_complete_approvals()
returns table (task_id uuid, reference_no text, requester_email text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row record;
begin
  for v_row in
    select t.id, t.title, t.status, t.assignee_id, t.qa_assignee_id, tok.id as token_id,
           r.reference_no, r.requester_email
      from vizserve_pms_approval_tokens tok
      join vizserve_pms_tasks t on t.id = tok.task_id
      left join vizserve_pms_requests r on r.id = t.request_id
     where tok.purpose = 'approval'
       and tok.consumed_at is null
       and tok.auto_complete_at is not null
       and tok.auto_complete_at <= now()
       and t.status = 'FOR_CLIENT_APPROVAL'
     for update of tok, t
  loop
    update vizserve_pms_tasks
       set status = 'COMPLETED_NO_RESPONSE'
     where id = v_row.id;

    insert into vizserve_pms_task_status_history
      (task_id, from_status, to_status, actor_id, comment)
    values
      (v_row.id, 'FOR_CLIENT_APPROVAL', 'COMPLETED_NO_RESPONSE', null,
       'No response from the client within the stated window.');

    insert into vizserve_pms_client_decisions (task_id, token_id, decision)
    values (v_row.id, v_row.token_id, 'AUTO_COMPLETED');

    -- Consumed, so the link stops working the moment the window closes.
    update vizserve_pms_approval_tokens set consumed_at = now() where id = v_row.token_id;

    perform vizserve_pms_write_audit_log(
      'task', v_row.id, 'auto_completed', null,
      jsonb_build_object('status', 'FOR_CLIENT_APPROVAL'),
      jsonb_build_object('status', 'COMPLETED_NO_RESPONSE', 'reason', 'no client response')
    );

    perform vizserve_pms_emit(
      'client.no_response',
      jsonb_build_object('pic', jsonb_build_array(v_row.assignee_id),
                         'qa',  jsonb_build_array(v_row.qa_assignee_id)),
      'Closed with no response: ' || v_row.title || ' (' || coalesce(v_row.reference_no, '') || ')',
      'The approval window passed without a reply.', 'task', v_row.id,
      '/tasks/' || v_row.id::text
    );

    task_id := v_row.id;
    reference_no := v_row.reference_no;
    requester_email := v_row.requester_email;
    return next;
  end loop;
end;
$$;


-- ===========================================================================
-- Task created
-- ===========================================================================
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
  v_shared  boolean;
  v_dept    uuid := p_department_id;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- The caller's own department, from their own row. Not a parameter, and that
  -- is the whole guard: a member cannot ASK to create somewhere else.
  select u.primary_department_id into v_mine
    from vizserve_pms_users u
   where u.id = v_actor and u.is_active;

  /*
   * P13-01, CHANGE 0 — THE LIST DECIDES, IF THE LIST IS A SHARED ONE.
   *
   * ⚠️ THIS OVERRIDES A PARAMETER THE CALLER SENT, which is the kind of thing
   * that deserves suspicion. It cannot widen anything: the only value it can
   * write is the id of a department that is ALREADY shared, and change 1 below
   * admits every active user into exactly those. A caller who passes a
   * collaboration list is asking for a collaboration task; this is what stops
   * that arriving as "That list belongs to another department." after the form
   * has been filled in. Every other department leaves `v_dept` alone.
   *
   * ⚠️ FIRST, BEFORE THE SCOPE CHECK, so the check below judges the department
   * the task will ACTUALLY be filed under and not the one that was proposed.
   */
  if p_list_id is not null then
    select l.department_id into v_dept
      from vizserve_pms_lists l
     where l.id = p_list_id
       and vizserve_pms_is_shared_department(l.department_id);

    v_dept := coalesce(v_dept, p_department_id);
  end if;

  -- Read once and reused three times below, because it is two table lookups
  -- otherwise and this runs on every task anybody creates.
  v_shared := vizserve_pms_may_collaborate(v_dept);

  -- P7-14. A lead may file into any department they lead; anyone else may file
  -- into their own and nowhere else. P13-01 adds: and anybody active may file
  -- into a collaboration space.
  if not (
    coalesce(vizserve_pms_manages_department(v_dept), false)
    or (v_mine is not null and v_dept = v_mine)
    or v_shared
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
  --
  -- ⚠️ P13-01 — AND A COLLABORATION SPACE IS THE EXCEPTION THAT PROVES IT. The
  -- reason above is "their own TL cannot see it"; in a shared space every TL can
  -- see it, because §3a admits everybody. So the department test relaxes to an
  -- activity test, and only there.
  if p_assignee_id is not null and not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_assignee_id
       and u.is_active
       and (v_shared or u.primary_department_id = v_dept)
  ) then
    raise exception 'That assignee is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id and l.department_id = v_dept
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, list_id, created_by, priority
  ) values (
    null, v_dept, v_title, coalesce(btrim(p_description), ''), 'OPEN',
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

  if p_assignee_id is not null and p_assignee_id <> v_actor then
    perform vizserve_pms_emit(
      'task.assigned',
      jsonb_build_object('assignee', jsonb_build_array(p_assignee_id)),
      'Assigned to you: ' || v_title,
      coalesce(btrim(p_description), ''), 'task', v_task_id, '/tasks/' || v_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end;
$$;


-- ===========================================================================
-- Person added to a task
-- ===========================================================================
create or replace function vizserve_pms_add_task_assignee(p_task_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor  uuid := auth.uid();
  v_task   vizserve_pms_tasks;
  v_shared boolean;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  v_shared := coalesce(vizserve_pms_may_collaborate(v_task.department_id), false);

  -- P11-06 — the department may put people on its own work. P13-01 — and
  -- everybody may put people on shared work.
  if not (
    coalesce(vizserve_pms_is_on_task(p_task_id, v_actor), false)
    or coalesce(vizserve_pms_manages_department(v_task.department_id), false)
    or coalesce(
         exists (
           select 1 from vizserve_pms_users u
            where u.id = v_actor
              and u.is_active
              and u.primary_department_id = v_task.department_id
         ),
         false
       )
    or v_shared
  ) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  -- ⚠️ P13-01 relaxes the DEPARTMENT half and keeps the ACTIVITY half. Same
  -- reasoning as `vizserve_pms_create_task`: the rule exists so nobody ends up
  -- holding work their own lead cannot see, and in a shared space every lead
  -- can see it.
  if not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_user_id
       and u.is_active
       and (v_shared or u.primary_department_id = v_task.department_id)
  ) then
    raise exception 'That person is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  values (p_task_id, p_user_id, v_actor)
  on conflict (task_id, user_id) do nothing;

  if p_user_id <> v_actor then
    perform vizserve_pms_emit(
      'task.assigned',
      jsonb_build_object('assignee', jsonb_build_array(p_user_id)),
      'Added to: ' || v_task.title,
      coalesce(v_task.description, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true);
end;
$$;


-- ===========================================================================
-- Task status moves
-- ===========================================================================
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
      'task.ready_for_qa',
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
      'task.qa_returned',
      jsonb_build_object('pic', jsonb_build_array(v_task.assignee_id)),
      'QA sent back: ' || coalesce(v_reference, v_task.title),
      coalesce(v_comment, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'status', p_to_status);
end;
$$;


-- ===========================================================================
-- Comments and mentions
-- ===========================================================================
create or replace function vizserve_pms_notify_task_comment()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  v_task      vizserve_pms_tasks;
  v_author    text;
  v_recipient uuid;
  v_mentioned uuid[];
  /*
   * ⚠️ NOT `old.body` INLINE, AND NOT A STYLE CHOICE. `OLD` is an UNASSIGNED
   * record in an INSERT trigger, and plpgsql raises `record "old" is not
   * assigned yet` on any field reference to it — including one inside a `case`
   * branch that is not taken, because the expression is still planned. Reading
   * it behind a `tg_op` guard, into a variable that defaults to empty, is what
   * lets one function serve both events.
   */
  v_old_body  text := '';
begin
  if tg_op = 'UPDATE' then v_old_body := old.body; end if;

  select * into v_task from vizserve_pms_tasks where id = new.task_id;
  if v_task.id is null then return new; end if;

  select full_name into v_author from vizserve_pms_users where id = new.author_id;

  /*
   * Who the body names, intersected with who may be named.
   *
   * ⚠️ THE INTERSECTION IS THE SECURITY CHECK, and it is here rather than in
   * the server action because the front end will be bypassed. The picker only
   * offers names the author may address, but a body is just text: a
   * hand-written `data-mention-id` would otherwise post the task title and 200
   * characters of the comment to anybody at all. An id that is not a candidate
   * is dropped silently — the mention still renders as a name in the comment,
   * it simply notifies nobody.
   *
   * ⚠️ `new.author_id`, NOT `auth.uid()`, AND THAT IS THE POINT OF THE ACTOR
   * PARAMETER. The reach is the AUTHOR'S, so a member cannot widen their own by
   * hand-editing a body, and a comment written by the service role — with no
   * session and therefore no `auth.uid()` — is still judged against the person
   * whose name is on it rather than against nobody.
   *
   * On UPDATE, minus whoever the old body already named.
   */
  select coalesce(array_agg(m.id), '{}')
    into v_mentioned
    from (
      select named.id from vizserve_pms_mentioned_ids(new.body) as named(id)
      intersect
      select c.id from vizserve_pms_task_mention_candidates(new.task_id, new.author_id) c
      except
      select new.author_id
      except
      select already.id from vizserve_pms_mentioned_ids(v_old_body) as already(id)
    ) m;

  if cardinality(v_mentioned) > 0 then
    perform vizserve_pms_emit(
      'task.mentioned',
      jsonb_build_object('mentioned', to_jsonb(v_mentioned)),
      coalesce(v_author, 'Somebody') || ' mentioned you on ' || v_task.title,
      left(new.body, 200),
      'task', new.task_id, '/tasks/' || new.task_id::text,
      array[new.author_id]
    );
  end if;

  -- An edited comment is not a new comment. Everything below is P7-08's, and it
  -- runs on INSERT only.
  if tg_op <> 'INSERT' then return new; end if;

  -- The PIC and the QA reviewer, never the author, never twice, and never
  -- somebody who was just told by name. A lead who is neither is not notified:
  -- they have the department view, and a comment on every task in the
  -- department is how an inbox becomes wallpaper.
  perform vizserve_pms_emit(
    'task.commented',
    jsonb_build_object('pic_and_qa', jsonb_build_array(v_task.assignee_id, v_task.qa_assignee_id)),
    coalesce(v_author, 'Somebody') || ' commented on ' || v_task.title,
    left(new.body, 200),
    'task', new.task_id, '/tasks/' || new.task_id::text,
    array[new.author_id] || v_mentioned
  );

  return new;
end;
$fn$;


-- ===========================================================================
-- Internal request submitted
-- ===========================================================================
create or replace function vizserve_pms_submit_internal_request(
  p_request_type    vizserve_pms_internal_request_type,
  p_reason          text,
  p_start_date      date default null,
  p_end_date        date default null,
  p_work_date       date default null,
  p_correction_time time default null,
  p_amount          numeric default null,
  p_overtime_minutes integer default null,
  p_leave_type_id   uuid default null,
  p_start_half      vizserve_pms_day_half default 'MORNING',
  p_end_half        vizserve_pms_day_half default 'AFTERNOON',
  p_relievers       jsonb default null,
  p_turnover_confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user       uuid := auth.uid();
  v_department uuid;
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_correction timestamptz;
  v_id         uuid;
  v_approver   record;
  v_name       text;
  v_requires_reliever boolean := false;
  v_relievers  jsonb;
  v_count      integer;
  v_stage      smallint := 0;
  v_entry      record;
  v_task       record;
  v_reliever   uuid;
  v_row_id     uuid;
  v_tasks      integer;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select u.primary_department_id, u.full_name into v_department, v_name
    from vizserve_pms_users u
   where u.id = v_user and u.is_active;

  if v_name is null then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  if v_department is null then
    raise exception 'You have no department set, so there is nobody to approve this. Ask an admin to set your department.'
      using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'Say why you are requesting this.' using errcode = 'check_violation';
  end if;

  if p_request_type = 'LEAVE' then
    if p_leave_type_id is null then
      raise exception 'Choose what kind of leave this is.' using errcode = 'check_violation';
    end if;

    select lt.requires_reliever into v_requires_reliever
      from vizserve_pms_leave_types lt
     where lt.id = p_leave_type_id and lt.is_active;

    if v_requires_reliever is null then
      raise exception 'That leave type is no longer available. Pick one from the list.'
        using errcode = 'check_violation';
    end if;

    if p_start_date = p_end_date and p_start_half > p_end_half then
      raise exception 'Leave on one day cannot start in the afternoon and end in the morning.'
        using errcode = 'check_violation';
    end if;
  end if;

  if p_request_type in (
    'NO_TIME_IN', 'NO_TIME_OUT', 'TIME_IN_CORRECTION', 'TIME_OUT_CORRECTION'
  ) then
    if p_work_date is null or p_correction_time is null then
      raise exception 'A correction needs the date and the time it should have been.'
        using errcode = 'check_violation';
    end if;

    v_correction := (p_work_date::text || ' ' || p_correction_time::text)::timestamp
                    at time zone 'Asia/Manila';

    if v_correction > now() then
      raise exception 'You cannot correct a time that has not happened yet.'
        using errcode = 'check_violation';
    end if;
  end if;

  if p_request_type = 'OVERTIME' then
    if p_work_date is null or p_overtime_minutes is null then
      raise exception 'Overtime needs the day and how long it ran.'
        using errcode = 'check_violation';
    end if;

    if p_work_date > (now() at time zone 'Asia/Manila')::date then
      raise exception 'Pick the day the overtime was or is being worked, not a future one.'
        using errcode = 'check_violation';
    end if;
  end if;

  v_relievers := case
    when p_request_type = 'LEAVE' and coalesce(v_requires_reliever, false)
    then coalesce(p_relievers, '[]'::jsonb)
    else '[]'::jsonb
  end;

  if jsonb_typeof(v_relievers) <> 'array' then
    raise exception 'The reliever list is malformed.' using errcode = 'check_violation';
  end if;

  select count(*) into v_count from jsonb_array_elements(v_relievers);

  if coalesce(v_requires_reliever, false) then
    if v_count = 0 then
      raise exception 'This kind of leave needs a reliever. Add at least one.'
        using errcode = 'check_violation';
    end if;

    if v_count > 3 then
      raise exception 'Name at most three relievers.' using errcode = 'check_violation';
    end if;

    if not coalesce(p_turnover_confirmed, false) then
      raise exception 'Confirm the turn-over before submitting.' using errcode = 'check_violation';
    end if;
  end if;

  if v_count <> (
    select count(distinct e.value ->> 'reliever_id') from jsonb_array_elements(v_relievers) e
  ) then
    raise exception 'That person is already listed as a reliever.' using errcode = 'check_violation';
  end if;

  if (
    select count(*) from jsonb_array_elements(v_relievers) e,
         jsonb_array_elements_text(e.value -> 'task_ids') t
  ) <> (
    select count(distinct t.value) from jsonb_array_elements(v_relievers) e,
         jsonb_array_elements_text(e.value -> 'task_ids') t
  ) then
    raise exception 'Each task can only go to one reliever.' using errcode = 'check_violation';
  end if;

  -- P14-04. THE ONE EXPRESSION THAT DECIDES THE ROUTE, computed once and used
  -- for the row and its audit entry alike.
  --   relievers named -> 1, the relievers first
  --   otherwise       -> 2 (Team Leader) or 3 (Manager), see first_lead_stage
  v_stage := case
    when coalesce(v_requires_reliever, false) then 1
    else vizserve_pms_first_lead_stage(v_department, v_user)
  end;

  insert into vizserve_pms_internal_requests (
    request_type, requester_id, department_id, reason,
    start_date, end_date, work_date, correction_at, amount, overtime_minutes,
    leave_type_id, start_half, end_half,
    approval_stage, turnover_confirmed_at
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount, p_overtime_minutes,
    case when p_request_type = 'LEAVE' then p_leave_type_id else null end,
    case when p_request_type = 'LEAVE' then coalesce(p_start_half, 'MORNING') else null end,
    case when p_request_type = 'LEAVE' then coalesce(p_end_half, 'AFTERNOON') else null end,
    v_stage,
    case when v_count > 0 then now() else null end
  )
  returning id into v_id;

  for v_entry in select value as payload from jsonb_array_elements(v_relievers) loop
    v_reliever := nullif(v_entry.payload ->> 'reliever_id', '')::uuid;

    if v_reliever is null then
      raise exception 'Choose a reliever, or remove the empty row.' using errcode = 'check_violation';
    end if;

    if v_reliever = v_user then
      raise exception 'You cannot be your own reliever.' using errcode = 'check_violation';
    end if;

    if not exists (
      select 1 from vizserve_pms_users u
       where u.id = v_reliever and u.is_active
    ) then
      raise exception 'That person is not an active account.' using errcode = 'check_violation';
    end if;

    insert into vizserve_pms_internal_request_relievers (request_id, reliever_id)
    values (v_id, v_reliever)
    returning id into v_row_id;

    v_tasks := 0;

    for v_task in
      select value::uuid as task_id from jsonb_array_elements_text(v_entry.payload -> 'task_ids')
    loop
      if not vizserve_pms_is_on_task(v_task.task_id, v_user) then
        raise exception 'You are not on one of the tasks you tried to hand over.'
          using errcode = 'check_violation';
      end if;

      if exists (
        select 1 from vizserve_pms_tasks t
         where t.id = v_task.task_id
           and t.status in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
      ) then
        raise exception 'One of those tasks is already finished — it needs no reliever.'
          using errcode = 'check_violation';
      end if;

      insert into vizserve_pms_internal_request_reliever_tasks (reliever_row_id, task_id)
      values (v_row_id, v_task.task_id);

      v_tasks := v_tasks + 1;
    end loop;

    if v_tasks = 0 then
      raise exception 'Give every reliever at least one task.' using errcode = 'check_violation';
    end if;
  end loop;

  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object(
      'request_type', p_request_type,
      'department_id', v_department,
      'approval_stage', v_stage,
      'relievers', v_relievers
    )
  );

  -- P14-04. The manager's own request, with no hand-over to agree first, is
  -- approved now and nobody is asked.
  if v_count = 0 and vizserve_pms_skips_approval(v_user) then
    perform vizserve_pms_auto_approve_internal(v_id);
    return jsonb_build_object('ok', true, 'id', v_id, 'auto_approved', true);
  end if;

  if v_count > 0 then
    -- Stage 1. The leads are not told yet: the relievers answer first.
    perform vizserve_pms_emit(
      'leave.reliever_asked',
      jsonb_build_object('relievers',
        coalesce((select jsonb_agg(r.reliever_id) from vizserve_pms_internal_request_relievers r
                   where r.request_id = v_id), '[]'::jsonb)),
      v_name || ' asked you to cover their work',
      v_reason,
      'internal_request', v_id, '/approvals/' || v_id::text,
      array[v_user]
    );
  else
    -- ⚠️ P7-16b's block: type 'pending_approval', title "<type> request from
    -- <name>". P14-04 changes only the RECIPIENTS — whoever the request is
    -- waiting on at the stage it landed on (Team Leaders, or the Manager).
    perform vizserve_pms_emit(
      (case when p_request_type = 'LEAVE' then 'leave' else 'internal' end) || case when v_stage = 3 then '.manager_step' else '.team_leader_step' end,
      jsonb_build_object('approvers', coalesce((select jsonb_agg(a) from vizserve_pms_internal_stage_approvers(v_id) a), '[]'::jsonb)),
      replace(p_request_type::text, '_', ' ') || ' request from ' || v_name,
      v_reason,
      'internal_request', v_id, '/approvals/' || v_id::text,
      array[v_user]
    );
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;


-- ===========================================================================
-- Internal request decided
-- ===========================================================================
create or replace function vizserve_pms_decide_internal_request(
  p_id       uuid,
  p_decision vizserve_pms_approval_decision,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req       vizserve_pms_internal_requests;
  v_before    jsonb;
  v_status    vizserve_pms_internal_request_status;
  v_entry_id  uuid;
  v_actor     uuid := auth.uid();
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rejected  boolean := (p_decision = 'rejected');
  v_row       vizserve_pms_internal_request_relievers;
  v_next      smallint;
  v_owed      integer;
  v_person    record;
  v_name      text;
  v_label     text;
begin
  if p_decision = 'returned' then
    raise exception 'Internal requests are approved or rejected, not returned.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_req.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  if v_req.requester_id = v_actor then
    raise exception 'You cannot decide your own request.'
      using errcode = 'insufficient_privilege';
  end if;

  -- =========================================================================
  -- STAGE 3 — the manager. Authorised here; decided by the body at the bottom.
  -- =========================================================================
  if v_req.approval_stage = 3 then
    if not vizserve_pms_may_decide_internal_stage('internal_request', p_id) then
      raise exception '%',
        case when v_actor in (select vizserve_pms_managers(v_req.requester_id))
             then 'Switch to your Manager role in the top bar to approve this.'
             else 'This is waiting on the manager.'
        end
        using errcode = 'insufficient_privilege';
    end if;

    -- P14-07. No "two gates, two people" rule: somebody holding Team Leader and
    -- Manager signs the Team Leader step as Team Leader, switches, and signs
    -- the final step as Manager. That is what the role switcher is for.

  -- =========================================================================
  -- STAGES 1 AND 2 — advance or reject, and return from inside.
  -- =========================================================================
  elsif v_req.approval_stage in (1, 2) then
    v_before := to_jsonb(v_req);
    select u.full_name into v_name from vizserve_pms_users u where u.id = v_req.requester_id;

    if v_req.approval_stage = 1 then
      select * into v_row
        from vizserve_pms_internal_request_relievers
       where request_id = p_id and reliever_id = v_actor
       for update;

      if v_row.id is null then
        raise exception 'This is waiting on the relievers named on it.'
          using errcode = 'insufficient_privilege';
      end if;

      if v_row.decision is not null then
        raise exception 'You have already answered this.'
          using errcode = 'invalid_parameter_value';
      end if;

      if v_rejected and v_reason is null then
        raise exception 'Say why you cannot take this on — a refusal with no reason is unactionable.'
          using errcode = 'check_violation';
      end if;

      update vizserve_pms_internal_request_relievers
         set decision = p_decision, decided_at = now(), reason = v_reason
       where id = v_row.id;

      perform vizserve_pms_write_audit_log(
        'internal_request', p_id, 'reliever_' || p_decision::text, v_actor, null,
        jsonb_build_object('reliever_id', v_actor, 'decision', p_decision, 'reason', v_reason)
      );

      if not v_rejected then
        select count(*) into v_owed
          from vizserve_pms_internal_request_relievers
         where request_id = p_id and decision is null;

        if v_owed > 0 then
          return jsonb_build_object(
            'ok', true, 'status', v_req.status::text,
            'approval_stage', 1, 'stage_complete', false, 'dtr_entry_id', null
          );
        end if;
      end if;

      -- P14-04. The manager's own leave: the hand-over was the only thing
      -- anybody had to agree to, so it is approved now.
      if not v_rejected and vizserve_pms_skips_approval(v_req.requester_id) then
        perform vizserve_pms_auto_approve_internal(p_id);
        return jsonb_build_object(
          'ok', true, 'status', 'APPROVED',
          'approval_stage', 1, 'stage_complete', true, 'dtr_entry_id', null
        );
      end if;

      -- P14-04. A Team Leader's own leave skips their peers.
      v_next := vizserve_pms_first_lead_stage(v_req.department_id, v_req.requester_id);

    else
      if not vizserve_pms_may_decide_internal_stage('internal_request', p_id) then
        raise exception '%',
          case when v_actor in (select vizserve_pms_team_leaders_of(v_req.department_id, v_req.requester_id))
               then 'Switch to your Team Leader role in the top bar to approve this.'
               else 'This is waiting on a team leader of that department.'
          end
          using errcode = 'insufficient_privilege';
      end if;

      perform vizserve_pms_record_decision(
        'internal_request', p_id, v_req.department_id, p_decision, p_reason
      );

      v_next := 3;
    end if;

    if v_rejected then
      update vizserve_pms_internal_requests
         set status = 'REJECTED', decision_reason = v_reason,
             reviewed_by = v_actor, reviewed_at = now()
       where id = p_id;

      perform vizserve_pms_write_audit_log(
        'internal_request', p_id, 'rejected', v_actor, v_before,
        jsonb_build_object('status', 'REJECTED', 'reason', v_reason,
                           'rejected_at_stage', v_req.approval_stage)
      );

      perform vizserve_pms_emit(
        (case when v_req.request_type = 'LEAVE' then 'leave' else 'internal' end) || '.rejected',
        jsonb_build_object('requester', jsonb_build_array(v_req.requester_id)),
        replace(v_req.request_type::text, '_', ' ') || ' request rejected',
        coalesce(v_reason, ''), 'internal_request', p_id, '/approvals/' || p_id::text,
        array[v_actor]
      );

      return jsonb_build_object(
        'ok', true, 'status', 'REJECTED',
        'approval_stage', v_req.approval_stage, 'stage_complete', true,
        'dtr_entry_id', null
      );
    end if;

    update vizserve_pms_internal_requests
       set approval_stage = v_next
     where id = p_id;

    perform vizserve_pms_write_audit_log(
      'internal_request', p_id, 'stage_advanced', v_actor, v_before,
      jsonb_build_object('from_stage', v_req.approval_stage, 'to_stage', v_next)
    );

    v_label := initcap(replace(lower(v_req.request_type::text), '_', ' '));

    -- Whoever it waits on now — Team Leaders at 2, the Manager at 3.
    perform vizserve_pms_emit(
      (case when v_req.request_type = 'LEAVE' then 'leave' else 'internal' end) || case when v_next = 2 then '.team_leader_step' else '.manager_step' end,
      jsonb_build_object('approvers', coalesce((select jsonb_agg(a) from vizserve_pms_internal_stage_approvers(p_id) a), '[]'::jsonb)),
      case when v_next = 2
           then v_label || ' request from ' || coalesce(v_name, 'a colleague')
           else v_label || ' for final approval: ' || coalesce(v_name, 'a colleague')
      end,
      case when v_req.approval_stage = 1
           then 'The relievers have accepted the hand-over.'
           else 'Approved by their team leader.'
      end,
      'internal_request', p_id, '/approvals/' || p_id::text,
      array[v_actor]
    );

    return jsonb_build_object(
      'ok', true, 'status', v_req.status::text,
      'approval_stage', v_next, 'stage_complete', true, 'dtr_entry_id', null
    );
  end if;

  -- =========================================================================
  -- THE FINAL DECISION — stage 3, and any legacy stage-0 row.
  -- =========================================================================

  perform vizserve_pms_record_decision(
    'internal_request', p_id, v_req.department_id, p_decision, p_reason
  );

  v_before := to_jsonb(v_req);
  v_status := case p_decision when 'approved' then 'APPROVED' else 'REJECTED' end;

  update vizserve_pms_internal_requests
     set status          = v_status,
         decision_reason = nullif(btrim(coalesce(p_reason, '')), ''),
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_id;

  -- P5-09 / P7-39 — the DTR write-back, shared with the auto-approval path.
  if v_status = 'APPROVED' then
    v_entry_id := vizserve_pms_apply_dtr_correction(p_id, auth.uid());
  end if;

  perform vizserve_pms_write_audit_log(
    'internal_request', p_id, lower(v_status::text), auth.uid(), v_before,
    jsonb_build_object('status', v_status, 'reason', p_reason, 'dtr_entry_id', v_entry_id)
  );

  perform vizserve_pms_emit(
    (case when v_req.request_type = 'LEAVE' then 'leave' else 'internal' end) || case when v_status = 'APPROVED' then '.approved' else '.rejected' end,
    jsonb_build_object('requester', jsonb_build_array(v_req.requester_id)),
    replace(v_req.request_type::text, '_', ' ') || ' request ' || lower(v_status::text),
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), ''),
    'internal_request', p_id, '/approvals/' || p_id::text,
    array[v_actor]
  );

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'dtr_entry_id', v_entry_id
  );
end;
$$;


-- ===========================================================================
-- Internal request withdrawn
-- ===========================================================================
create or replace function vizserve_pms_withdraw_internal_request(
  p_id   uuid,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user     uuid := auth.uid();
  v_req      vizserve_pms_internal_requests;
  v_before   jsonb;
  v_approver record;
  v_name     text;
  v_note     text := nullif(btrim(coalesce(p_note, '')), '');
  v_signed   boolean;
  v_today    date := (now() at time zone 'Asia/Manila')::date;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_req.requester_id <> v_user then
    raise exception 'Only the person who filed a request can withdraw it.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_req.status not in ('PENDING_REVIEW', 'APPROVED') then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  v_signed := v_req.status = 'APPROVED'
    or exists (
      select 1 from vizserve_pms_approvals a
       where a.entity_type = 'internal_request' and a.entity_id = p_id
    )
    or exists (
      select 1 from vizserve_pms_internal_request_relievers r
       where r.request_id = p_id and r.decision is not null
    );

  if v_signed then
    if v_req.request_type <> 'LEAVE' then
      raise exception 'Somebody has already answered this, so it cannot be withdrawn. Ask them to reject it instead.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_req.start_date is null or v_req.start_date <= v_today then
      raise exception 'This leave has already started, so it cannot be withdrawn. Ask a team leader to correct the record instead.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_note is null then
      raise exception 'Say why you are withdrawing this. Somebody has already approved it, and they will be told.'
        using errcode = 'check_violation';
    end if;
  end if;

  v_before := to_jsonb(v_req);

  update vizserve_pms_internal_requests
     set status = 'WITHDRAWN',
         withdrawn_note = v_note
   where id = p_id;

  perform vizserve_pms_write_audit_log(
    'internal_request', p_id, 'withdrawn', v_user, v_before,
    jsonb_build_object(
      'status', 'WITHDRAWN',
      'approval_stage', v_req.approval_stage,
      'withdrawn_note', v_note,
      'withdrawn_from', v_req.status::text,
      'was_signed', v_signed
    )
  );

  select u.full_name into v_name from vizserve_pms_users u where u.id = v_user;

  if v_signed then
    perform vizserve_pms_emit(
      (case when v_req.request_type = 'LEAVE' then 'leave' else 'internal' end) || '.withdrawn',
      jsonb_build_object('affected', coalesce((select jsonb_agg(x.user_id) from (
               select r.reliever_id as user_id from vizserve_pms_internal_request_relievers r
                where r.request_id = p_id and r.decision is not null
               union
               select a.approver_id from vizserve_pms_approvals a
                where a.entity_type = 'internal_request' and a.entity_id = p_id
             ) x), '[]'::jsonb)),
      coalesce(v_name, 'A colleague') || ' withdrew leave you had signed',
      '<p>Nothing further is needed from you.</p>' || v_note,
      'internal_request', p_id, '/approvals/' || p_id::text,
      array[v_user]
    );
  elsif v_req.approval_stage = 1 then
    perform vizserve_pms_emit(
      (case when v_req.request_type = 'LEAVE' then 'leave' else 'internal' end) || '.withdrawn',
      jsonb_build_object('affected', coalesce((select jsonb_agg(r.reliever_id) from vizserve_pms_internal_request_relievers r
              where r.request_id = p_id), '[]'::jsonb)),
      coalesce(v_name, 'A colleague') || ' withdrew their leave request',
      '<p>You no longer need to cover their work.</p>' || coalesce(v_note, ''),
      'internal_request', p_id, '/approvals/' || p_id::text,
      array[v_user]
    );
  else
    -- P14-04. Whoever it was waiting on at its stage.
    perform vizserve_pms_emit(
      (case when v_req.request_type = 'LEAVE' then 'leave' else 'internal' end) || '.withdrawn',
      jsonb_build_object('affected', coalesce((select jsonb_agg(a) from vizserve_pms_internal_stage_approvers(p_id) a), '[]'::jsonb)),
      coalesce(v_name, 'A colleague') || ' withdrew a request',
      '<p>It no longer needs your approval.</p>' || coalesce(v_note, ''),
      'internal_request', p_id, '/approvals/' || p_id::text,
      array[v_user]
    );
  end if;

  return jsonb_build_object('ok', true, 'status', 'WITHDRAWN');
end;
$$;


-- ===========================================================================
-- Manager's own request auto-approved
-- ===========================================================================
create or replace function vizserve_pms_auto_approve_internal(p_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_req   vizserve_pms_internal_requests;
  v_entry uuid;
begin
  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  update vizserve_pms_internal_requests
     set status          = 'APPROVED',
         decision_reason = 'Auto-approved: filed by the manager.',
         reviewed_by     = null,
         reviewed_at     = now()
   where id = p_id;

  v_entry := vizserve_pms_apply_dtr_correction(p_id, v_req.requester_id);

  -- P14-10. The end of the flow, for whoever the rules say (not the requester,
  -- who has just submitted it).
  perform vizserve_pms_emit(
    (case when v_req.request_type = 'LEAVE' then 'leave' else 'internal' end) || '.approved',
    jsonb_build_object('requester', jsonb_build_array(v_req.requester_id)),
    replace(v_req.request_type::text, '_', ' ') || ' request approved',
    'Auto-approved: filed by the manager.',
    'internal_request', p_id, '/approvals/' || p_id::text,
    array[v_req.requester_id]
  );

  perform vizserve_pms_write_audit_log(
    'internal_request', p_id, 'auto_approved', v_req.requester_id, to_jsonb(v_req),
    jsonb_build_object(
      'status', 'APPROVED',
      'reason', 'Filed by the manager — nobody sits above them in the approval chain',
      'dtr_entry_id', v_entry
    )
  );

  return v_entry;
end;
$$;


-- ===========================================================================
-- Timesheet submitted
-- ===========================================================================
create or replace function vizserve_pms_submit_timesheet_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user       uuid := auth.uid();
  v_department uuid;
  v_name       text;
  v_week       date;
  v_this_week  date;
  v_total      integer;
  v_existing   vizserve_pms_timesheet_weeks;
  v_id         uuid;
  v_approver   record;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  v_week := date_trunc('week', p_week_start)::date;
  v_this_week := date_trunc('week', (now() at time zone 'Asia/Manila')::date)::date;

  if v_week > v_this_week then
    raise exception 'That week has not happened yet.' using errcode = 'check_violation';
  end if;

  select u.primary_department_id, u.full_name into v_department, v_name
    from vizserve_pms_users u
   where u.id = v_user and u.is_active;

  if v_name is null then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  if v_department is null then
    raise exception 'You have no department set, so there is nobody to approve this. Ask an admin to set your department.'
      using errcode = 'check_violation';
  end if;

  perform 1
    from vizserve_pms_timesheet_entries e
   where e.user_id = v_user
     and e.work_date between v_week and v_week + 6
   for update;

  select coalesce(sum(e.minutes), 0) into v_total
    from vizserve_pms_timesheet_entries e
   where e.user_id = v_user
     and e.work_date between v_week and v_week + 6;

  if v_total = 0 then
    raise exception 'There is nothing logged in that week to submit.'
      using errcode = 'check_violation';
  end if;

  select * into v_existing
    from vizserve_pms_timesheet_weeks
   where user_id = v_user and week_start = v_week
   for update;

  if v_existing.id is not null then
    if v_existing.status = 'SUBMITTED' then
      raise exception 'That week is already with the manager.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_existing.status = 'APPROVED' then
      raise exception 'That week has been approved. Ask the manager to send it back if it needs changing.'
        using errcode = 'invalid_parameter_value';
    end if;

    update vizserve_pms_timesheet_weeks
       set status            = 'SUBMITTED',
           submitted_minutes = v_total,
           submitted_at      = now(),
           decision_reason   = null,
           reviewed_by       = null,
           reviewed_at       = null
     where id = v_existing.id;

    v_id := v_existing.id;
  else
    insert into vizserve_pms_timesheet_weeks (
      user_id, week_start, department_id, status, submitted_minutes
    ) values (
      v_user, v_week, v_department, 'SUBMITTED', v_total
    )
    returning id into v_id;
  end if;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', v_id, 'submitted', v_user, null,
    jsonb_build_object('week_start', v_week, 'minutes', v_total)
  );

  -- P14-04. The manager's own week is approved on submission.
  if vizserve_pms_skips_approval(v_user) then
    update vizserve_pms_timesheet_weeks
       set status = 'APPROVED', reviewed_by = null, reviewed_at = now()
     where id = v_id;

    perform vizserve_pms_write_audit_log(
      'timesheet_week', v_id, 'auto_approved', v_user, null,
      jsonb_build_object('status', 'APPROVED', 'reason', 'Filed by the manager')
    );

    perform vizserve_pms_emit(
      'timesheet.approved',
      jsonb_build_object('owner', jsonb_build_array(v_user)),
      'Timesheet approved',
      'Week of ' || to_char(v_week, 'DD Mon YYYY') || ' — auto-approved: filed by the manager.',
      'timesheet_week', v_id, '/timesheet?week=' || v_week::text,
      array[v_user]
    );

    return jsonb_build_object('ok', true, 'id', v_id, 'minutes', v_total, 'auto_approved', true);
  end if;

  -- P14-04. The manager, not the department's leads.
  perform vizserve_pms_emit(
    'timesheet.submitted',
    jsonb_build_object('approvers', coalesce((select jsonb_agg(m) from vizserve_pms_managers(v_user) m), '[]'::jsonb)),
    'Timesheet from ' || v_name,
    'Week of ' || to_char(v_week, 'DD Mon YYYY'),
    'timesheet_week', v_id, '/timesheet/team?week=' || v_week::text,
    array[v_user]
  );

  return jsonb_build_object('ok', true, 'id', v_id, 'minutes', v_total);
end;
$$;


-- ===========================================================================
-- Timesheet decided
-- ===========================================================================
create or replace function vizserve_pms_decide_timesheet_week(
  p_id       uuid,
  p_decision vizserve_pms_approval_decision,
  p_reason   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_week   vizserve_pms_timesheet_weeks;
  v_status vizserve_pms_timesheet_week_status;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_decision = 'rejected' then
    raise exception 'A week of work is approved or sent back to be fixed, not rejected.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The manager approves timesheets: somebody who holds the role AND is acting
  -- as it.
  if auth.uid() is null or auth.uid() not in (select vizserve_pms_managers()) then
    raise exception 'Timesheets are approved by the manager.'
      using errcode = 'insufficient_privilege';
  end if;

  if vizserve_pms_current_role() is distinct from 'manager' then
    raise exception 'Switch to your Manager role in the top bar to approve timesheets.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_week
    from vizserve_pms_timesheet_weeks
   where id = p_id
   for update;

  if v_week.id is null then
    raise exception 'That timesheet no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_week.status <> 'SUBMITTED' then
    raise exception 'That timesheet has already been decided.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_week.user_id = auth.uid() then
    raise exception 'You cannot approve your own timesheet.'
      using errcode = 'insufficient_privilege';
  end if;

  perform vizserve_pms_record_decision(
    'timesheet_week', p_id, v_week.department_id, p_decision, p_reason
  );

  v_status := case when p_decision = 'approved' then 'APPROVED' else 'RETURNED' end;

  update vizserve_pms_timesheet_weeks
     set status          = v_status,
         decision_reason = v_reason,
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_id;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', p_id, lower(v_status::text), auth.uid(),
    to_jsonb(v_week), jsonb_build_object('status', v_status, 'reason', v_reason)
  );

  perform vizserve_pms_emit(
    case when p_decision = 'approved' then 'timesheet.approved' else 'timesheet.returned' end,
    jsonb_build_object('owner', jsonb_build_array(v_week.user_id)),
    case when p_decision = 'approved'
         then 'Timesheet approved'
         else 'Timesheet sent back' end,
    coalesce(v_reason, 'Week of ' || to_char(v_week.week_start, 'DD Mon YYYY')),
    'timesheet_week', p_id, '/timesheet?week=' || v_week.week_start::text,
    array[auth.uid()]
  );

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;


-- ===========================================================================
-- Timesheet withdrawn
-- ===========================================================================
create or replace function vizserve_pms_withdraw_timesheet_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user     uuid := auth.uid();
  v_week     date;
  v_row      vizserve_pms_timesheet_weeks;
  v_name     text;
  v_approver record;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  v_week := date_trunc('week', p_week_start)::date;

  select * into v_row
    from vizserve_pms_timesheet_weeks
   where user_id = v_user and week_start = v_week
   for update;

  if v_row.id is null then
    raise exception 'That week has not been submitted.' using errcode = 'no_data_found';
  end if;

  -- P14-04. The manager's weeks approve themselves, so nobody could ever send
  -- one back; the manager takes their own back instead.
  if v_row.status = 'APPROVED' and not vizserve_pms_skips_approval(v_user) then
    raise exception 'That week has been approved. Ask the manager to send it back if it needs changing.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_row.status = 'RETURNED' then
    raise exception 'That week is already back with you to edit.'
      using errcode = 'invalid_parameter_value';
  end if;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', v_row.id, 'withdrawn', v_user, to_jsonb(v_row),
    jsonb_build_object('week_start', v_week, 'minutes', v_row.submitted_minutes)
  );

  delete from vizserve_pms_timesheet_weeks where id = v_row.id;

  select u.full_name into v_name from vizserve_pms_users u where u.id = v_user;

  -- P14-04. The manager the submission notified.
  perform vizserve_pms_emit(
    'timesheet.withdrawn',
    jsonb_build_object('approvers', coalesce((select jsonb_agg(m) from vizserve_pms_managers(v_user) m), '[]'::jsonb)),
    coalesce(v_name, 'A colleague') || ' cancelled their timesheet submission',
    'Week of ' || to_char(v_week, 'DD Mon YYYY') || ' no longer needs your approval. They will resubmit it.',
    'timesheet_week', v_row.id, '/timesheet/team?week=' || v_week::text,
    array[v_user]
  );

  return jsonb_build_object('ok', true);
end;
$$;
