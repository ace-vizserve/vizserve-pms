-- P1-10 (fix) — reference prefixes must be unique across forms.
--
-- FOUND BY THE P1-09 TEST SUITE, which needed two fixture forms and gave them
-- the same prefix without thinking about it.
--
-- The bug: `vizserve_pms_requests.reference_no` is globally unique, and
-- `vizserve_pms_next_reference_no` counts per (form, year). Two forms sharing a
-- prefix therefore both generate `TSA-2026-0001`, and the second submission dies
-- on the unique constraint — as a raw 23505 from inside a SECURITY DEFINER
-- function, so a member of the public gets a 500 instead of the structured
-- field errors the whole submission path is built to return.
--
-- Worth noticing how it hid. It needs two forms, the same prefix, and a
-- successful submission to each — and until this week nothing had two forms.
-- It would have surfaced the first week the tool was in real use, to a client.
--
-- Two things wrong, so two fixes:
--
--   1. HERE: make the collision impossible. A prefix is a form's identity in a
--      client-facing reference number; two forms sharing COL is already
--      confusing to a human reading their email, so uniqueness is what was
--      always meant.
--   2. In the form builder: report a taken prefix as a field error at save time,
--      not as a 500 at submission time. `updateFormSettings` previously mapped
--      every 23505 to "that URL slug is taken", which would have been a
--      confusing lie here.
--
-- Case-insensitive, because the zod schema uppercases but the column never
-- promised to — and `col` and `COL` produce the same reference number.

create unique index vizserve_pms_forms_reference_prefix_key
  on vizserve_pms_forms (upper(reference_prefix));

-- ---------------------------------------------------------------------------
-- Belt and braces: turn the remaining collision into a structured error.
--
-- The index above makes this unreachable through the app. It stays because a
-- reference number is what a client quotes back at you, and a 500 on a public
-- form is the worst place in the system to discover a new way of colliding —
-- a bad migration, a direct INSERT, a restored backup.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_next_reference_no(p_form_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_prefix text;
  v_year   integer := extract(year from (now() at time zone 'Asia/Manila'))::integer;
  v_next   integer;
  v_ref    text;
begin
  select reference_prefix into v_prefix
    from vizserve_pms_forms
   where id = p_form_id;

  if v_prefix is null then
    raise exception 'Unknown form %', p_form_id using errcode = 'foreign_key_violation';
  end if;

  -- Up to 20 attempts. Each one burns a counter value, which leaves a gap —
  -- and gapless numbering is the reason this is a counter table rather than a
  -- sequence. That is the right trade: a gap is a curiosity, a 500 on a public
  -- form is a lost client request.
  for _ in 1..20 loop
    insert into vizserve_pms_reference_counters (form_id, year, last_value)
    values (p_form_id, v_year, 1)
    on conflict (form_id, year)
      do update set last_value = vizserve_pms_reference_counters.last_value + 1
    returning last_value into v_next;

    v_ref := v_prefix || '-' || v_year::text || '-' || lpad(v_next::text, 4, '0');

    if not exists (select 1 from vizserve_pms_requests where reference_no = v_ref) then
      return v_ref;
    end if;
  end loop;

  raise exception 'Could not allocate a reference number for form % — check for a duplicate reference_prefix.', p_form_id
    using errcode = 'unique_violation';
end;
$$;

-- ---------------------------------------------------------------------------
-- P2-07 (fix) — one approval, one audit row per thing that happened.
--
-- ALSO FOUND BY A TEST: querying "the audit row for this approval" returned two.
-- The engine writes one when it records the decision (that is its job, and every
-- future entity type depends on it), and the Gate 1 transaction was writing a
-- second, also labelled `approved`, carrying the before/after.
--
-- Two rows with the same action for one event is a trail that has to be
-- interpreted rather than read. Split by what actually happened instead:
--
--   request / approved       the decision            (engine, unchanged)
--   request / edited         ONLY if the TL changed the date, title or
--                            description — with before/after, which is what
--                            P2-03 actually asks for
--   task    / created        the task, and who it went to
--
-- An approval that changed nothing now writes no `edited` row at all, which is
-- the point: a trail where every approval logs an edit is a trail in which a
-- real edit is invisible.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_approve_request(
  p_request_id           uuid,
  p_assignee_id          uuid,
  p_qa_assignee_id       uuid,
  p_approved_target_date date default null,
  p_title                text default null,
  p_description          text default null
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
begin
  select r.* into v_request
    from vizserve_pms_requests r
   where r.id = p_request_id
   for update;

  if v_request.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  -- Only a request actually awaiting review can be approved. Without this, two
  -- Team Leaders clicking Approve seconds apart both succeed, and the second
  -- silently reassigns the first one's task.
  if v_request.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_request.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  select f.department_id into v_department_id
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  -- The engine call. It re-checks scope itself, so this function does not, and
  -- there is exactly one place where "may this person decide" is answered.
  perform vizserve_pms_record_decision(
    'request', p_request_id, v_department_id, 'approved', null
  );

  if p_assignee_id is null then
    raise exception 'Choose who will do the work.' using errcode = 'check_violation';
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

  -- Null means "no change"; empty means the TL cleared it, and an empty title is
  -- not an edit anybody meant to make.
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

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, field_values, created_by
  ) values (
    p_request_id, v_department_id, v_title, v_description, 'OPEN',
    p_assignee_id, p_qa_assignee_id, v_due, v_request.field_values, auth.uid()
  )
  returning id into v_task_id;

  -- P2-03 — recorded only when something genuinely changed. This is the
  -- negotiation evidence: without it, "the TL moved the date" is unprovable.
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
      'due_date', v_due
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

  -- The QA reviewer is told at assignment, not when the task reaches FOR_QA.
  -- Knowing you are on the hook is what lets you plan around it; being told the
  -- moment it lands is what makes it a fire drill.
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

  return jsonb_build_object(
    'ok', true,
    'task_id', v_task_id,
    'reference_no', v_reference,
    'approved_target_date', v_due
  );
end;
$$;

-- Same duplication on the negative paths: the engine already logs the decision
-- and the reason, so the second row said nothing new.
create or replace function vizserve_pms_decide_request(
  p_request_id uuid,
  p_decision   vizserve_pms_approval_decision,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request       vizserve_pms_requests;
  v_department_id uuid;
  v_status        vizserve_pms_request_status;
begin
  if p_decision = 'approved' then
    raise exception 'Use vizserve_pms_approve_request to approve.'
      using errcode = 'invalid_parameter_value';
  end if;

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

  perform vizserve_pms_record_decision(
    'request', p_request_id, v_department_id, p_decision, p_reason
  );

  v_status := case p_decision when 'returned' then 'RETURNED' else 'REJECTED' end;

  update vizserve_pms_requests
     set status          = v_status,
         decision_reason = btrim(p_reason),
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_request_id;

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'reference_no', v_request.reference_no,
    'requester_email', v_request.requester_email,
    'requester_name', v_request.requester_name,
    'title', v_request.title
  );
end;
$$;

grant execute on function vizserve_pms_approve_request(uuid, uuid, uuid, date, text, text) to authenticated;
grant execute on function vizserve_pms_decide_request(uuid, vizserve_pms_approval_decision, text) to authenticated;
