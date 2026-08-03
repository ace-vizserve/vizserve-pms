-- P1-09 — Attachment upload.
--
-- THE PROBLEM THIS SOLVES, and the reason it is more than an <input type=file>:
--
-- The public form has no session. Whatever it posts is attacker-controlled, so
-- the earlier shape — a submission declaring `{storage_path, filename,
-- mime_type, size_bytes}` — was trusting the client to describe a file it also
-- chose. That lets anyone attach an arbitrary object path to a request,
-- including one belonging to a different request, and lets them lie about the
-- size and type of everything.
--
-- The fix is a two-step handshake with a server-side receipt:
--
--   1. The browser uploads ONE file to a server action. That action holds the
--      real File — it measures the real bytes and sniffs the real magic number,
--      neither of which the client can forge — and writes a PENDING row.
--   2. The submission sends only the pending row's UUID. This function reads the
--      metadata back out of the database and ignores anything the payload
--      claimed about it.
--
-- A fabricated path is then not merely rejected, it is unrepresentable.

-- ---------------------------------------------------------------------------
-- The bucket. PRIVATE — client briefs and draft creative are not public URLs.
--
-- Downloads are served as short-lived signed URLs minted by a server action
-- that has already checked department scope, which is why `authenticated` needs
-- no storage policy at all and does not get one.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('request-attachments', 'request-attachments', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Upload rules. A TABLE, not a constant, for the same reason the rate limits
-- are: a client on a bad connection sending a 40 MB PSD is a Tuesday problem
-- that should be solvable without a deploy.
-- ---------------------------------------------------------------------------
create table vizserve_pms_attachment_rules (
  id                  boolean primary key default true,
  max_bytes           bigint not null default 10485760,   -- 10 MiB
  max_files_per_form  integer not null default 10,
  -- An ALLOWLIST, never a denylist. A denylist is a list of the attacks someone
  -- had already thought of.
  --
  -- image/svg+xml is DELIBERATELY ABSENT. An SVG is a script container, and one
  -- served inline from the storage origin is stored XSS against that origin. If
  -- a designer genuinely needs to send an SVG they can zip it; a client sending
  -- one unprompted is the case this is guarding against.
  allowed_mime_types  text[] not null default array[
    'image/png', 'image/jpeg', 'image/gif', 'image/webp',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain', 'text/csv',
    'application/zip'
  ],
  constraint vizserve_pms_attachment_rules_singleton check (id)
);

insert into vizserve_pms_attachment_rules (id) values (true) on conflict do nothing;

-- ---------------------------------------------------------------------------
-- The receipt table.
--
-- A row here means: the server has seen these exact bytes, measured them, and
-- put them in the bucket. It is the ONLY thing the submission function will
-- believe about a file.
-- ---------------------------------------------------------------------------
create table vizserve_pms_pending_attachments (
  id           uuid primary key default gen_random_uuid(),
  -- Scoped to the form it was uploaded against, so a receipt issued on one
  -- public form cannot be redeemed on another.
  form_id      uuid not null references vizserve_pms_forms (id) on delete cascade,
  field_key    text,
  storage_path text not null unique,
  filename     text not null,
  mime_type    text not null,
  size_bytes   bigint not null,
  -- Null for the public form, set for staff uploads in later phases.
  uploaded_by  uuid references vizserve_pms_users (id) on delete set null,
  ip           text,
  created_at   timestamptz not null default now(),

  constraint vizserve_pms_pending_attachments_size_positive check (size_bytes > 0)
);

create index vizserve_pms_pending_attachments_created_idx
  on vizserve_pms_pending_attachments (created_at);
create index vizserve_pms_pending_attachments_ip_idx
  on vizserve_pms_pending_attachments (ip, created_at desc);

alter table vizserve_pms_attachment_rules      enable row level security;
alter table vizserve_pms_pending_attachments   enable row level security;

revoke all on vizserve_pms_attachment_rules    from anon;
revoke all on vizserve_pms_pending_attachments from anon;

-- Staff may see the rules so the UI can state the limit before someone picks a
-- 40 MB file. Nobody reads the pending table directly — it is service-role only,
-- and no policy means no rows for everyone else.
create policy "attachment rules readable by active users"
  on vizserve_pms_attachment_rules for select to authenticated
  using (vizserve_pms_current_role() is not null);

create policy "attachment rules writable by admin"
  on vizserve_pms_attachment_rules for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- ---------------------------------------------------------------------------
-- Safe UUID cast.
--
-- `p_attachments` is public input, so `'not-a-uuid'::uuid` is not a hypothetical
-- — and inside a set-returning query that cast raises, which would turn a junk
-- payload into a 500 instead of a shrug. A 500 also tells whoever sent it that
-- they found an edge, which is the opposite of what a public endpoint should do.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_try_uuid(p_value text)
returns uuid
language plpgsql
immutable
as $$
begin
  return p_value::uuid;
exception when others then
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Redemption.
--
-- Called only from inside vizserve_pms_submit_request. Takes the array of
-- `{id, field_key}` the payload offered, keeps the ones that are genuine
-- receipts for THIS form, and copies the server-measured metadata across.
--
-- Returns how many it attached, so the caller can enforce "at least one" for a
-- form that requires an attachment without trusting the payload's own count.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_redeem_attachments(
  p_request_id  uuid,
  p_form_id     uuid,
  p_attachments jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_item     jsonb;
  v_pending  vizserve_pms_pending_attachments;
  v_count    integer := 0;
  v_ids      uuid[] := '{}';
begin
  if jsonb_typeof(p_attachments) <> 'array' then
    return 0;
  end if;

  for v_item in select * from jsonb_array_elements(p_attachments)
  loop
    -- A malformed or absent id is skipped, not raised. `SELECT INTO` with no
    -- matching row sets every field of v_pending to NULL, so the check below is
    -- not reading the previous iteration's file.
    select * into v_pending
      from vizserve_pms_pending_attachments
     where id = vizserve_pms_try_uuid(v_item ->> 'id')
       and form_id = p_form_id;

    if v_pending.id is null then
      continue;
    end if;

    -- Idempotence guard. Two array entries naming the same receipt would
    -- otherwise attach one file twice.
    if v_pending.id = any(v_ids) then
      continue;
    end if;
    v_ids := v_ids || v_pending.id;

    insert into vizserve_pms_request_attachments
      (request_id, field_key, storage_path, filename, mime_type, size_bytes, uploaded_by)
    values (
      p_request_id,
      -- The field the file answers is presentation, so the payload may say. The
      -- bytes, the name, the type and the size come only from the receipt.
      coalesce(nullif(v_item ->> 'field_key', ''), v_pending.field_key),
      v_pending.storage_path,
      v_pending.filename,
      v_pending.mime_type,
      v_pending.size_bytes,
      v_pending.uploaded_by
    );

    v_count := v_count + 1;
  end loop;

  -- Redeemed receipts are spent. The storage object stays where it is — the
  -- request_attachments row now owns it.
  if array_length(v_ids, 1) > 0 then
    delete from vizserve_pms_pending_attachments where id = any(v_ids);
  end if;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- Submission, revised.
--
-- Same function as 20260729100200 with the attachment half replaced. The
-- "requires an attachment" check now runs AFTER redemption and counts what was
-- actually attached, instead of counting array entries the caller supplied.
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

-- ---------------------------------------------------------------------------
-- The public form reader, extended with the upload rules.
--
-- Added here rather than exposed as a second anon-callable function: the rules
-- are display data for the picker ("up to 10 MB each"), they change with the
-- singleton row, and one public entry point is easier to keep honest than two.
-- Still returns nothing internal — no department, no SLA, no author.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Sweeping abandoned uploads.
--
-- Somebody picks a file and closes the tab. The receipt and the object both
-- outlive the intent, and a private bucket that only ever grows is a storage
-- bill nobody chose. Returns the paths so the caller can delete the objects —
-- Postgres cannot reach the storage API itself.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_expire_pending_attachments(p_older_than interval default interval '24 hours')
returns table (storage_path text)
language sql
security definer
set search_path = public, extensions
as $$
  delete from vizserve_pms_pending_attachments
   where created_at < now() - p_older_than
  returning vizserve_pms_pending_attachments.storage_path
$$;
