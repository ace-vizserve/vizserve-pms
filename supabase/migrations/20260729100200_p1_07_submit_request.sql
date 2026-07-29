-- P1-07 / P1-08 / P1-11 / P1-15 — Public submission.
--
-- THE one rule this phase exists to enforce (Amier, 48:25):
--   "pagpasok pa lang ng request, dapat kumpleto na"
--
-- Client-side validation is a suggestion. This function is the enforcement, and
-- the P1 exit criterion is a `curl` that bypasses the browser being rejected.
--
-- SECURITY DEFINER, callable by `anon`, because clients never authenticate.
-- `anon` gets NO table access anywhere — this function is the only way in.

-- P1-15 — abuse controls. A public URL with no auth is a public URL with no
-- auth (R1). Backed by Postgres rather than Redis/Upstash deliberately: it adds
-- no vendor, no key to rotate and no second thing to be down, and submission
-- volume here is measured in tens per day, not thousands per second.
create table vizserve_pms_public_submission_log (
  id         uuid primary key default gen_random_uuid(),
  form_id    uuid references vizserve_pms_forms (id) on delete set null,
  ip         text,
  email      extensions.citext,
  accepted   boolean not null default true,
  created_at timestamptz not null default now()
);

create index vizserve_pms_public_submission_log_ip_idx
  on vizserve_pms_public_submission_log (ip, created_at desc);
create index vizserve_pms_public_submission_log_email_idx
  on vizserve_pms_public_submission_log (email, created_at desc);

-- Tunable without a deploy.
create table vizserve_pms_public_submission_limits (
  id                 boolean primary key default true,
  per_ip_per_hour    integer not null default 10,
  per_email_per_hour integer not null default 5,
  constraint vizserve_pms_public_submission_limits_singleton check (id)
);

insert into vizserve_pms_public_submission_limits (id) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Value presence. A required field is not satisfied by "", " ", [], or null —
-- all four are things a form actually submits.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_jsonb_value_is_blank(v jsonb)
returns boolean
language sql
immutable
as $$
  select
    v is null
    or jsonb_typeof(v) = 'null'
    or (jsonb_typeof(v) = 'string' and length(btrim(v #>> '{}')) = 0)
    or (jsonb_typeof(v) = 'array' and jsonb_array_length(v) = 0)
$$;

-- ---------------------------------------------------------------------------
-- The submission entry point.
--
-- Returns a structured result rather than raising, so the caller can render
-- field-level errors. Raising would collapse eight useful messages into one
-- opaque 500 and force the client to guess.
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
  v_attachment    jsonb;
  v_attach_count  integer := 0;
begin
  -- Only a form that is BOTH public and active is reachable. A draft form is
  -- not a soft-launch.
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

    -- Type checks. Not exhaustive validation — enough that a value cannot be
    -- stored in a shape the task board and the Phase 4 approval page cannot
    -- render.
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
    end if;

    v_field_values := v_field_values || jsonb_build_object(v_field.field_key, v_value);
  end loop;

  -- --- attachments ----------------------------------------------------------
  if jsonb_typeof(p_attachments) = 'array' then
    v_attach_count := jsonb_array_length(p_attachments);
  end if;

  if v_form.requires_attachment and v_attach_count = 0 then
    v_errors := v_errors || jsonb_build_object('attachments', 'At least one attachment is required.');
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

  for v_attachment in select * from jsonb_array_elements(p_attachments)
  loop
    insert into vizserve_pms_request_attachments
      (request_id, field_key, storage_path, filename, mime_type, size_bytes)
    values (
      v_request_id,
      nullif(v_attachment ->> 'field_key', ''),
      v_attachment ->> 'storage_path',
      v_attachment ->> 'filename',
      coalesce(v_attachment ->> 'mime_type', 'application/octet-stream'),
      coalesce((v_attachment ->> 'size_bytes')::bigint, 0)
    );
  end loop;

  insert into vizserve_pms_public_submission_log (form_id, ip, email, accepted)
  values (v_form.id, p_ip, v_email, true);

  perform vizserve_pms_write_audit_log(
    'request', v_request_id, 'submitted', null, null,
    jsonb_build_object('reference_no', v_reference_no, 'form_id', v_form.id, 'ip', p_ip)
  );

  -- P1-12 — the request lands in exactly one department's queue. Notify the
  -- people who lead that department; there may be more than one.
  perform vizserve_pms_notify(
    md.user_id,
    'pending_approval',
    'New request: ' || v_reference_no,
    v_title || ' — from ' || v_name,
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

revoke all on function vizserve_pms_submit_request(text, jsonb, jsonb, text) from public;
grant execute on function vizserve_pms_submit_request(text, jsonb, jsonb, text) to anon, authenticated;

-- Public read of a form's shape, so the renderer can draw it without any table
-- access. Returns only what a form needs to render — never the department, the
-- SLA, or who created it.
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
