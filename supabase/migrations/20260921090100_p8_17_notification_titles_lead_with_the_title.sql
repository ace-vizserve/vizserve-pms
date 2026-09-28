-- P8-17 — a notification title names the job, not the filing code.
--
-- Both titles below led with `reference_no`, which meant a Team Leader's email
-- subject read "Approval needed — New request: COL-2026-0142" and their inbox
-- row said the same. A reference number is the handle you quote when chasing
-- something; it is not what the thing IS, and a queue of them is unreadable at
-- a glance.
--
-- Now: the title, with the reference in parentheses after it. Same information,
-- in the order a person needs it. This matches the client-facing subject lines,
-- which were changed at the same time in `lib/email/client-emails.ts`.
--
-- ⚠️ BOTH FUNCTIONS ARE REPRODUCED WHOLE, copied verbatim from the migrations
-- that last defined them, with only the lines named above changed:
--
--   vizserve_pms_submit_request        20260803100000_p1_09_attachments.sql
--   vizserve_pms_auto_complete_approvals  20260804100000_p4_client_approval.sql
--
-- `create or replace function` cannot patch one statement, and the alternative
-- -- editing those files in place -- would rewrite history that has already run
-- against the live project.
--
-- `vizserve_pms_auto_complete_approvals` also gains `t.title` in its cursor,
-- which it did not previously select.
--
-- Grants are NOT restated. `create or replace` preserves them, and the
-- signatures are unchanged -- but note that a change of signature would drop
-- them, and `anon` executing `vizserve_pms_submit_request` is what makes the
-- public form work at all.
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
    and u.role >= 'team_leader';

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request_id,
    'reference_no', v_reference_no
  );
end;
$$;

-- ---------------------------------------------------------------------------

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

    perform vizserve_pms_notify(
      person, 'client_decision',
      'Closed with no response: ' || v_row.title || ' (' || coalesce(v_row.reference_no, '') || ')',
      'The approval window passed without a reply.', 'task', v_row.id,
      '/tasks/' || v_row.id::text
    )
    from unnest(array[v_row.assignee_id, v_row.qa_assignee_id]) as person
    where person is not null;

    task_id := v_row.id;
    reference_no := v_row.reference_no;
    requester_email := v_row.requester_email;
    return next;
  end loop;
end;
$$;
