-- P16-04 — a client form's request fields are defaults, not fixtures (7 Oct 2026).
--
-- Name and email stay on every client form: they are who the request is from
-- and where Gate 3 is sent. Title, description and the date are now the form's
-- to keep or remove (asks_*, default true, so every form reads as before), and
-- still to rename (P15-04's labels).
--
--   * no title asked  → the request is titled "<form name> — <reference>"
--   * no description  → stored empty
--   * the date is the client's IDEAL FINISH DATE: optional, and never the due
--     date — Gate 1 sets that from the urgency (P16-05)
--
-- No grant: privileges on vizserve_pms_forms are table-level.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p16_01. Never `db:push`.

alter table vizserve_pms_forms
  add column if not exists asks_title       boolean not null default true,
  add column if not exists asks_description boolean not null default true,
  add column if not exists asks_target_date boolean not null default true;

comment on column vizserve_pms_forms.asks_target_date is
  'P16-04. Whether the public form asks for the ideal finish date. Optional for the client either way.';


-- Same function as p16_01, plus `request_fields`.
create or replace function vizserve_pms_get_public_form(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select jsonb_build_object(
    'id', f.id,
    'name', f.name,
    'slug', f.slug,
    'description', f.description,
    'requires_attachment', f.requires_attachment,
    'requires_approval', f.requires_approval,
    'request_fields', jsonb_build_object(
      'title', f.asks_title,
      'description', f.asks_description,
      'target_date', f.asks_target_date
    ),
    'request_labels', jsonb_build_object(
      'title', f.title_label,
      'description', f.description_label,
      'target_date', f.target_date_label
    ),
    'attachment_rules', (
      select jsonb_build_object(
        'max_bytes', r.max_bytes,
        'max_files', r.max_files_per_form,
        'allowed_mime_types', to_jsonb(r.allowed_mime_types)
      )
      from vizserve_pms_attachment_rules r where r.id
    ),
    'fields', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', ff.id,
            'label', ff.label,
            'field_key', ff.field_key,
            'field_type', ff.field_type,
            'help_text', ff.help_text,
            'options', ff.options,
            'is_required', ff.is_required
          ) order by ff.sort_order, ff.created_at
        )
        from vizserve_pms_form_fields ff
        where ff.form_id = f.id and ff.is_active
      ),
      '[]'::jsonb
    )
  )
  from vizserve_pms_forms f
  where f.slug = p_slug and f.is_public and f.is_active
$$;

revoke all on function vizserve_pms_get_public_form(text) from public;
grant execute on function vizserve_pms_get_public_form(text) to anon, authenticated;


-- Same function as p16_01; the request fields above changed.
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

  -- P16-04. Title and description are required only while the form asks
  -- for them; the date (the ideal finish date) is never required.
  if v_form.asks_title and v_title = '' then
    v_errors := v_errors || jsonb_build_object('title', 'A short title is required.');
  end if;

  if v_form.asks_description and v_description = '' then
    v_errors := v_errors || jsonb_build_object('description', 'A description is required.');
  end if;

  if not v_form.asks_title then v_title := ''; end if;
  if not v_form.asks_description then v_description := ''; end if;
  if not v_form.asks_target_date then v_target_date := null; end if;

  if v_target_date is not null then
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

  -- A form that does not ask for a title names the request after itself.
  if v_title = '' then
    v_title := v_form.name || ' — ' || v_reference_no;
  end if;

  insert into vizserve_pms_requests (
    form_id, reference_no, requester_name, requester_email, requester_org,
    title, description, target_date, field_values, status,
    sla_started_at, submitted_at
  ) values (
    v_form.id, v_reference_no, v_name, v_email, coalesce(v_org, 'HFSE'),
    v_title, v_description, v_parsed_date, v_field_values,
    case when v_form.requires_approval then 'PENDING_REVIEW' else 'SUBMITTED' end::vizserve_pms_request_status,
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

  -- A form that skips approval tells nobody: there is nothing to decide.
  if v_form.requires_approval then
    perform vizserve_pms_emit(
      'client.submitted',
      jsonb_build_object('dept_team_leaders', coalesce((select jsonb_agg(t) from vizserve_pms_team_leaders_of(v_form.department_id) t), '[]'::jsonb)),
      v_title || ' (' || v_reference_no || ')',
      'From ' || v_name,
      'request', v_request_id, '/requests/' || v_request_id::text
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'request_id', v_request_id,
    'reference_no', v_reference_no,
    'requires_approval', v_form.requires_approval
  );
end;
$$;
