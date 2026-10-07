-- P16-06 — sequential client approvers at Gate 3 (7 Oct 2026).
--
-- The requester is step 1. On the public form they can "Add approver" (name +
-- email) for steps 2, 3, … — up to five more. At Gate 3 each person gets their
-- own link, in order; the next is emailed only once the one before approves.
-- The task is COMPLETED when the last one signs.
--
--   * Changes requested by anyone → back to the team, and the chain starts
--     again at step 1 (the work changed, so earlier sign-offs no longer cover
--     it). A trigger resets the step whenever the task leaves the client.
--   * The no-response window runs per step; when one lapses the task closes as
--     COMPLETED_NO_RESPONSE, as before, and the decision row says which step.
--   * The team can correct an approver's name or email until their step comes
--     up (vizserve_pms_update_request_approver — Team Leader or Manager).
--   * Feedback is still asked of the requester.
--
-- `approval_tokens.requester_email` now means "the email this link is for".
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p16_04. Never `db:push`.

create table if not exists vizserve_pms_request_approvers (
  id         uuid primary key default gen_random_uuid(),
  request_id uuid not null references vizserve_pms_requests (id) on delete cascade,
  step       integer not null check (step >= 2),
  name       text not null check (length(btrim(name)) between 1 and 200),
  email      extensions.citext not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (request_id, step)
);

alter table vizserve_pms_request_approvers enable row level security;
revoke all on vizserve_pms_request_approvers from anon;
revoke insert, update, delete on vizserve_pms_request_approvers from authenticated;
grant select on vizserve_pms_request_approvers to authenticated;
grant all on vizserve_pms_request_approvers to service_role;

-- Whoever can read the request can read who approves it. The subquery runs
-- under the caller's own policies on vizserve_pms_requests.
drop policy if exists "request approvers follow their request" on vizserve_pms_request_approvers;
create policy "request approvers follow their request"
  on vizserve_pms_request_approvers for select to authenticated
  using (exists (select 1 from vizserve_pms_requests r where r.id = request_id));

alter table vizserve_pms_tasks
  add column if not exists client_approval_step integer not null default 1;

alter table vizserve_pms_approval_tokens
  add column if not exists step integer not null default 1;

alter table vizserve_pms_client_decisions
  add column if not exists step           integer,
  add column if not exists approver_email extensions.citext;

comment on column vizserve_pms_tasks.client_approval_step is
  'P16-06. Whose turn it is at Gate 3: 1 is the requester, 2+ are vizserve_pms_request_approvers. Reset to 1 when the task leaves FOR_CLIENT_APPROVAL.';


-- ---------------------------------------------------------------------------
-- Leaving the client restarts the chain.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_tasks_reset_client_step()
returns trigger
language plpgsql
set search_path = public, extensions
as $$
begin
  if old.status = 'FOR_CLIENT_APPROVAL' and new.status <> 'FOR_CLIENT_APPROVAL' then
    new.client_approval_step := 1;
  end if;
  return new;
end;
$$;

drop trigger if exists vizserve_pms_tasks_reset_client_step on vizserve_pms_tasks;
create trigger vizserve_pms_tasks_reset_client_step
  before update of status on vizserve_pms_tasks
  for each row execute function vizserve_pms_tasks_reset_client_step();


-- ---------------------------------------------------------------------------
-- Correct an approver before their step comes up.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_update_request_approver(p_id uuid, p_name text, p_email text)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row           vizserve_pms_request_approvers;
  v_department_id uuid;
  v_task          vizserve_pms_tasks;
  v_name          text := btrim(coalesce(p_name, ''));
  v_email         text := lower(btrim(coalesce(p_email, '')));
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_row from vizserve_pms_request_approvers where id = p_id for update;
  if v_row.id is null then
    raise exception 'That approver no longer exists.' using errcode = 'no_data_found';
  end if;

  select f.department_id into v_department_id
    from vizserve_pms_requests r join vizserve_pms_forms f on f.id = r.form_id
   where r.id = v_row.request_id;

  if not vizserve_pms_can_approve(v_department_id) then
    raise exception 'Only this department''s Team Leader or the Manager can change approvers.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where request_id = v_row.request_id;
  if v_task.id is not null and (
       v_task.status in ('COMPLETED', 'COMPLETED_NO_RESPONSE', 'CANCELLED')
       or (v_task.status = 'FOR_CLIENT_APPROVAL' and v_task.client_approval_step >= v_row.step)
     ) then
    raise exception 'That approver has already been sent the work.' using errcode = 'invalid_parameter_value';
  end if;

  if v_name = '' then
    raise exception 'Give the approver a name.' using errcode = 'check_violation';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Give the approver a valid email.' using errcode = 'check_violation';
  end if;

  update vizserve_pms_request_approvers
     set name = v_name, email = v_email, updated_at = now()
   where id = p_id;

  perform vizserve_pms_write_audit_log(
    'request', v_row.request_id, 'approver_changed', auth.uid(),
    jsonb_build_object('step', v_row.step, 'name', v_row.name, 'email', v_row.email::text),
    jsonb_build_object('step', v_row.step, 'name', v_name, 'email', v_email)
  );
end;
$$;

revoke all on function vizserve_pms_update_request_approver(uuid, text, text) from public, anon;
grant execute on function vizserve_pms_update_request_approver(uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------------
-- Submitting collects the approvers. Same function as p16_04 otherwise.
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
  v_approvers     jsonb := coalesce(p_payload -> 'approvers', '[]'::jsonb);
  v_approver      jsonb;
  v_step          integer := 1;
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

  -- --- P16-06: who approves after the requester, in order --------------------
  if jsonb_typeof(v_approvers) <> 'array' then
    v_approvers := '[]'::jsonb;
  end if;
  if jsonb_array_length(v_approvers) > 5 then
    v_errors := v_errors || jsonb_build_object('approvers', 'Add up to five approvers.');
  else
    for v_approver in select * from jsonb_array_elements(v_approvers) loop
      if btrim(coalesce(v_approver ->> 'name', '')) = '' then
        v_errors := v_errors || jsonb_build_object('approvers', 'Give each approver a name.');
      elsif btrim(coalesce(v_approver ->> 'email', '')) !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
        v_errors := v_errors || jsonb_build_object('approvers', 'Give each approver a valid email.');
      end if;
    end loop;
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

  -- P16-06. The requester is step 1; these are 2, 3, … in the order given.
  -- Only on a form that goes through approval — nothing else reaches Gate 3.
  if v_form.requires_approval then
    for v_approver in select * from jsonb_array_elements(v_approvers) loop
      v_step := v_step + 1;
      insert into vizserve_pms_request_approvers (request_id, step, name, email)
      values (v_request_id, v_step, btrim(v_approver ->> 'name'), lower(btrim(v_approver ->> 'email')));
    end loop;
  end if;

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

-- ---------------------------------------------------------------------------
-- A token goes to the current step's person. Same function as p4 otherwise.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_issue_approval_token(
  p_task_id uuid,
  p_purpose vizserve_pms_token_purpose default 'approval'
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task     vizserve_pms_tasks;
  v_email    extensions.citext;
  v_days     integer := 3;
  v_raw      text;
  v_deadline timestamptz;
  v_id       uuid;
  v_step     integer := 1;
  v_name     text;
  v_steps    integer := 1;
begin
  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- The identity the whole gate rests on. A task with no request behind it
  -- (P3-12) has no client to approve it, and silently issuing a token bound to
  -- nothing would be worse than refusing.
  select r.requester_email, r.requester_name, coalesce(f.client_approval_days, 3)
    into v_email, v_name, v_days
    from vizserve_pms_requests r
    join vizserve_pms_forms f on f.id = r.form_id
   where r.id = v_task.request_id;

  -- P16-06. An approval goes to whoever's step it is; feedback always to the
  -- requester. A step whose row has gone falls back to the requester rather
  -- than to nobody.
  select 1 + count(*) into v_steps from vizserve_pms_request_approvers where request_id = v_task.request_id;
  if p_purpose = 'approval' and v_task.client_approval_step > 1 then
    select a.step, a.email, a.name into v_step, v_email, v_name
      from vizserve_pms_request_approvers a
     where a.request_id = v_task.request_id and a.step = v_task.client_approval_step;
    if v_step is null or v_step = 1 then
      v_step := 1;
      select r.requester_email, r.requester_name into v_email, v_name
        from vizserve_pms_requests r where r.id = v_task.request_id;
    end if;
  end if;

  if v_email is null then
    raise exception 'That task has no client to approve it.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_deadline := vizserve_pms_add_business_days(now(), v_days);

  insert into vizserve_pms_approval_tokens (
    task_id, purpose, token_hash, requester_email, expires_at, auto_complete_at, step
  ) values (
    p_task_id,
    p_purpose,
    encode(digest(v_raw, 'sha256'), 'hex'),
    v_email,
    -- Comfortably longer than the auto-complete window: a token that expires
    -- before the deadline it states would be a link that dies while the email
    -- still promises it works.
    now() + interval '14 days',
    case when p_purpose = 'approval' then v_deadline else null end,
    case when p_purpose = 'approval' then v_step else 1 end
  )
  returning id into v_id;

  return jsonb_build_object(
    'token_id', v_id,
    -- The only time this value ever exists outside the email.
    'token', v_raw,
    'requester_email', v_email,
    'approver_name', v_name,
    'step', case when p_purpose = 'approval' then v_step else 1 end,
    'steps', v_steps,
    'auto_complete_at', case when p_purpose = 'approval' then v_deadline else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- The approval page knows who it is for. Same function as p4 otherwise.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_get_approval_page(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token   vizserve_pms_approval_tokens;
  v_task    vizserve_pms_tasks;
  v_request vizserve_pms_requests;
begin
  select * into v_token
    from vizserve_pms_approval_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');

  -- One shape of answer for every kind of failure. Distinguishing "no such
  -- token" from "expired" tells an enumerator which guesses were close.
  if v_token.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_token.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  select * into v_task from vizserve_pms_tasks where id = v_token.task_id;
  select * into v_request from vizserve_pms_requests where id = v_task.request_id;

  return jsonb_build_object(
    'ok', true,
    'purpose', v_token.purpose,
    -- A consumed token still renders, showing what was decided. A dead link is
    -- what makes a client ring up to ask whether their click worked.
    'consumed', v_token.consumed_at is not null,
    'task_id', v_task.id,
    'status', v_task.status,
    'reference_no', v_request.reference_no,
    'title', v_task.title,
    'requester_name', v_request.requester_name,
    -- P16-06. Who this link is for, and where they sit in the chain.
    'approver_name', coalesce(
      (select a.name from vizserve_pms_request_approvers a
        where a.request_id = v_request.id and a.step = v_token.step),
      v_request.requester_name
    ),
    'step', v_token.step,
    'steps', 1 + (select count(*) from vizserve_pms_request_approvers a where a.request_id = v_request.id),
    'submitted_at', v_request.submitted_at,
    'agreed_date', coalesce(v_request.approved_target_date, v_request.target_date),
    'resolution', v_task.resolution,
    'output_link', v_task.output_link,
    'auto_complete_at', v_token.auto_complete_at,
    -- Approving against what they asked for, not re-opening the brief
    -- (Amier 44:30).
    'field_values', v_request.field_values,
    'fields', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('field_key', ff.field_key, 'label', ff.label)
          order by ff.sort_order
        )
        from vizserve_pms_form_fields ff where ff.form_id = v_request.form_id
      ),
      '[]'::jsonb
    ),
    'attachments', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('id', ta.id, 'filename', ta.filename, 'size_bytes', ta.size_bytes)
          order by ta.created_at
        )
        from vizserve_pms_task_attachments ta
        where ta.task_id = v_task.id and ta.kind = 'output'
      ),
      '[]'::jsonb
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Deciding hands on to the next step, or finishes. Same as p14_10 otherwise.
-- ---------------------------------------------------------------------------
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
  v_next      vizserve_pms_request_approvers;
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

  -- P16-06. Approved, and someone else signs after this step: record it, hand
  -- the work on, and stop. The task stays with the client.
  if p_decision = 'APPROVED' then
    select a.* into v_next
      from vizserve_pms_request_approvers a
     where a.request_id = v_task.request_id and a.step = v_token.step + 1;

    if v_next.id is not null then
      insert into vizserve_pms_client_decisions
        (task_id, token_id, decision, comment, approver_name, ip, user_agent, step, approver_email)
      values
        (v_task.id, v_token.id, p_decision, v_comment,
         nullif(btrim(coalesce(p_approver_name, '')), ''), p_ip, p_user_agent,
         v_token.step, v_token.requester_email);

      update vizserve_pms_approval_tokens set consumed_at = now() where id = v_token.id;
      update vizserve_pms_tasks set client_approval_step = v_next.step where id = v_task.id;

      perform vizserve_pms_write_audit_log(
        'task', v_task.id, 'client_step_approved', null,
        jsonb_build_object('step', v_token.step),
        jsonb_build_object('step', v_next.step, 'approver_name', nullif(btrim(coalesce(p_approver_name, '')), ''), 'ip', p_ip)
      );

      return jsonb_build_object(
        'ok', true,
        'decision', p_decision,
        'status', v_task.status,
        'task_id', v_task.id,
        'next_step', v_next.step,
        'next_name', v_next.name
      );
    end if;
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
    (task_id, token_id, decision, comment, approver_name, ip, user_agent, step, approver_email)
  values
    (v_task.id, v_token.id, p_decision, v_comment,
     nullif(btrim(coalesce(p_approver_name, '')), ''), p_ip, p_user_agent,
     v_token.step, v_token.requester_email);

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

-- ---------------------------------------------------------------------------
-- Auto-complete records which step went quiet. Same as p14_10 otherwise.
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
           tok.step, tok.requester_email as step_email,
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

    insert into vizserve_pms_client_decisions (task_id, token_id, decision, step, approver_email)
    values (v_row.id, v_row.token_id, 'AUTO_COMPLETED', v_row.step, v_row.step_email);

    -- Consumed, so the link stops working the moment the window closes.
    update vizserve_pms_approval_tokens set consumed_at = now() where id = v_row.token_id;

    perform vizserve_pms_write_audit_log(
      'task', v_row.id, 'auto_completed', null,
      jsonb_build_object('status', 'FOR_CLIENT_APPROVAL'),
      jsonb_build_object('status', 'COMPLETED_NO_RESPONSE', 'reason', 'no client response', 'step', v_row.step)
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

-- ---------------------------------------------------------------------------
-- Reminders go to the person whose step it is. Same as p4 otherwise.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_claim_approval_reminders(p_max integer default 50)
returns table (
  task_id          uuid,
  reference_no     text,
  requester_email  text,
  requester_name   text,
  title            text,
  auto_complete_at timestamptz,
  reminder_number  integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  return query
  with due as (
    select tok.id
      from vizserve_pms_approval_tokens tok
      join vizserve_pms_tasks t on t.id = tok.task_id
     where tok.purpose = 'approval'
       and tok.consumed_at is null
       and tok.auto_complete_at > now()
       and t.status = 'FOR_CLIENT_APPROVAL'
       and tok.reminder_count < 2
       -- One a day at most, however often the cron runs.
       and (tok.reminded_at is null or tok.reminded_at < now() - interval '20 hours')
       -- The first reminder waits a day; nobody needs chasing an hour after
       -- being asked.
       and tok.created_at < now() - interval '20 hours'
     order by tok.auto_complete_at
     limit p_max
     for update of tok skip locked
  ),
  claimed as (
    update vizserve_pms_approval_tokens tok
       set reminded_at = now(), reminder_count = tok.reminder_count + 1
      from due
     where tok.id = due.id
    returning tok.task_id, tok.auto_complete_at, tok.reminder_count, tok.requester_email, tok.step
  )
  select
    c.task_id,
    r.reference_no,
    c.requester_email::text,
    coalesce(
      (select a.name from vizserve_pms_request_approvers a where a.request_id = r.id and a.step = c.step),
      r.requester_name
    ),
    t.title,
    c.auto_complete_at,
    c.reminder_count
  from claimed c
  join vizserve_pms_tasks t on t.id = c.task_id
  left join vizserve_pms_requests r on r.id = t.request_id;
end;
$$;
