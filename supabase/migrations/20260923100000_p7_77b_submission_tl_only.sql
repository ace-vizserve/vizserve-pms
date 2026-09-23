-- P7-77b — at submission, ONLY Team Leaders are told. Not managers, admins or
-- owners — no email AND no inbox row.
--
-- P7-77 kept the inbox row for everyone at `role >= 'team_leader'` and only
-- muted their email. Ace, 23 Sep 2026: "just TL, not TL and higher". So the
-- recipient filter itself becomes `= 'team_leader'` and the mute is removed.
--
-- ⚠️ A department whose only approver is a manager or admin now gets no notice
-- of a new request. They still see it in /requests.
--
-- Reproduced whole from 20260923090100_p7_77_gate1_recipients.sql with only the
-- marked block changed. Signature unchanged, so `anon`'s execute grant — the
-- public form — survives `create or replace`.
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
    -- P7-77b. `=`, not `>=`: Team Leaders only. Who MAY approve is unchanged
    -- and still `>=` — this decides only who is told.
    and u.role = 'team_leader';

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request_id,
    'reference_no', v_reference_no
  );
end;
$$;
