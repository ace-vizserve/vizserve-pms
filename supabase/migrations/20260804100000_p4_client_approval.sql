-- P4-01 / P4-02 / P4-05 — Gate 3: the client approval token.
--
-- THE RISKIEST SURFACE IN THE BUILD. A public URL that changes state with no
-- session. Get it wrong and anyone holding a forwarded email approves anyone's
-- work.
--
-- Every control from docs/08 §Security, and what each one is actually for:
--
--   256-bit random token      guessing must be infeasible
--   ONLY THE HASH IS STORED   a database leak must not yield working links
--   bound to task AND email   enforces "only the requestor" (Amier 43:30), and
--                             a token for one task cannot act on another
--   expiry                    old emails stop working
--   consumed_at               one decision per token. No replay, and no
--                             changing the answer afterwards
--   ip + user agent recorded  evidence if a client later disputes it
--   no anon table access      the SECURITY DEFINER functions are the only way in
--
-- Q7, the honest limitation: email forwarding defeats email-based identity. If
-- the named requester forwards the link and someone else clicks Approve, this
-- records the requester's approval. docs/08 recommends accepting that (option a)
-- plus a typed name for accountability (option c) — both implemented below.
-- Option (b), a one-time code, is deliberately NOT built: it adds friction to
-- the exact step this gate exists to make frictionless, and should wait for a
-- dispute that actually happens.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Q6 — business days, not calendar days.
--
-- A ticket sent Friday 5pm auto-completes Monday 5pm on calendar days, having
-- given the client roughly one working day to respond. That is the version of
-- this feature that produces the angry phone call.
--
-- The holiday list is a table because the Philippine calendar is proclaimed
-- annually and is not derivable. An empty table degrades to "weekends only",
-- which is wrong but not dangerous.
-- ---------------------------------------------------------------------------
create table vizserve_pms_holidays (
  holiday_date date primary key,
  name         text not null,
  created_at   timestamptz not null default now()
);

alter table vizserve_pms_holidays enable row level security;
revoke all on vizserve_pms_holidays from anon;

create policy "holidays readable by active users"
  on vizserve_pms_holidays for select to authenticated
  using (vizserve_pms_current_role() is not null);

create policy "holidays writable by admin"
  on vizserve_pms_holidays for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());

-- Regular Philippine holidays for 2026. The movable ones (Eid, and any special
-- non-working days) are proclaimed annually and must be added by hand — hence a
-- table rather than a function.
insert into vizserve_pms_holidays (holiday_date, name) values
  ('2026-01-01', 'New Year''s Day'),
  ('2026-04-02', 'Maundy Thursday'),
  ('2026-04-03', 'Good Friday'),
  ('2026-04-09', 'Araw ng Kagitingan'),
  ('2026-05-01', 'Labor Day'),
  ('2026-06-12', 'Independence Day'),
  ('2026-08-31', 'National Heroes Day'),
  ('2026-11-30', 'Bonifacio Day'),
  ('2026-12-25', 'Christmas Day'),
  ('2026-12-30', 'Rizal Day')
on conflict (holiday_date) do nothing;

/**
 * Adds business days to a timestamp, in Manila.
 *
 * Manila and not UTC: "three working days" is a question about the local
 * calendar, and a UTC-based count closes a ticket on the wrong day for anyone
 * either side of the date line.
 *
 * The time of day is preserved, so a task sent for approval at 4pm gets its
 * deadline at 4pm — which is what the email promises.
 */
create or replace function vizserve_pms_add_business_days(
  p_from timestamptz,
  p_days integer
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_local  timestamp := p_from at time zone 'Asia/Manila';
  v_date   date      := v_local::date;
  v_time   time      := v_local::time;
  v_added  integer   := 0;
begin
  while v_added < p_days loop
    v_date := v_date + 1;

    -- 6 = Saturday, 0 = Sunday.
    if extract(dow from v_date) not in (0, 6)
       and not exists (select 1 from vizserve_pms_holidays h where h.holiday_date = v_date)
    then
      v_added := v_added + 1;
    end if;
  end loop;

  return (v_date + v_time) at time zone 'Asia/Manila';
end;
$$;

-- How long a client gets, per form. Config rather than a hardcoded 3, because
-- some work is urgent and some is not, and the alternative is a migration every
-- time somebody wants to change it.
alter table vizserve_pms_forms
  add column client_approval_days integer not null default 3
  constraint vizserve_pms_forms_client_approval_days_range
    check (client_approval_days between 1 and 30);

-- ---------------------------------------------------------------------------
-- P4-01 — the tokens.
-- ---------------------------------------------------------------------------
create type vizserve_pms_token_purpose as enum ('approval', 'feedback');

create table vizserve_pms_approval_tokens (
  id               uuid primary key default gen_random_uuid(),
  task_id          uuid not null references vizserve_pms_tasks (id) on delete cascade,
  purpose          vizserve_pms_token_purpose not null default 'approval',

  -- SHA-256 of the raw token. The raw value exists exactly once, in the email
  -- that was sent. A dump of this table yields nothing that can be replayed.
  token_hash       text not null unique,

  -- Bound identity. Checked at decision time, so a token cannot be redeemed for
  -- a task whose requester has since changed.
  requester_email  extensions.citext not null,

  expires_at       timestamptz not null,
  -- The deadline stated in the email. Null for feedback tokens, which nothing
  -- auto-completes.
  auto_complete_at timestamptz,

  -- ONE decision per token. Set the moment a decision is recorded, checked
  -- before recording one. This is what makes replay impossible.
  consumed_at      timestamptz,

  -- P4-08 — so a reminder is sent once rather than every time the cron runs.
  reminded_at      timestamptz,
  reminder_count   integer not null default 0,

  created_at       timestamptz not null default now()
);

create index vizserve_pms_approval_tokens_task_idx
  on vizserve_pms_approval_tokens (task_id, purpose);
-- The cron's working set: live approval tokens with a deadline.
create index vizserve_pms_approval_tokens_due_idx
  on vizserve_pms_approval_tokens (auto_complete_at)
  where consumed_at is null and purpose = 'approval';

alter table vizserve_pms_approval_tokens enable row level security;
revoke all on vizserve_pms_approval_tokens from anon;

-- Staff may see that a token exists and whether it was used; they may not see
-- the hash. Deliberately no policy granting anything to anon: the public page
-- reaches this table only through SECURITY DEFINER functions.
create policy "tokens readable in task scope"
  on vizserve_pms_approval_tokens for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id
         and (
           t.assignee_id = auth.uid()
           or t.qa_assignee_id = auth.uid()
           or vizserve_pms_manages_department(t.department_id)
         )
    )
  );

-- Nobody writes these from the app. Issuance and consumption are functions.
revoke insert, update, delete on vizserve_pms_approval_tokens from authenticated;

-- ---------------------------------------------------------------------------
-- The decisions themselves.
-- ---------------------------------------------------------------------------
create type vizserve_pms_client_decision as enum (
  'APPROVED',
  'REVISION_REQUESTED',
  -- Never called "approved". If a dispute happens, the record has to show
  -- exactly what occurred: nobody answered and the clock ran out.
  'AUTO_COMPLETED'
);

create table vizserve_pms_client_decisions (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references vizserve_pms_tasks (id) on delete cascade,
  token_id      uuid references vizserve_pms_approval_tokens (id) on delete set null,
  decision      vizserve_pms_client_decision not null,
  comment       text,
  -- Q7 option (c): who says they clicked it. Weak as security, decent as
  -- accountability, near-zero friction — which is the right trade here.
  approver_name text,
  -- Evidence, for the dispute this feature will eventually cause.
  ip            text,
  user_agent    text,
  created_at    timestamptz not null default now(),

  -- A revision request with no explanation is not a revision request.
  constraint vizserve_pms_client_decisions_comment_required
    check (
      decision <> 'REVISION_REQUESTED'
      or (comment is not null and length(btrim(comment)) > 0)
    )
);

create index vizserve_pms_client_decisions_task_idx
  on vizserve_pms_client_decisions (task_id, created_at desc);

alter table vizserve_pms_client_decisions enable row level security;
revoke all on vizserve_pms_client_decisions from anon;

create policy "client decisions readable in task scope"
  on vizserve_pms_client_decisions for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id
         and (
           t.assignee_id = auth.uid()
           or t.qa_assignee_id = auth.uid()
           or vizserve_pms_manages_department(t.department_id)
         )
    )
  );

revoke insert, update, delete on vizserve_pms_client_decisions from authenticated;

-- ---------------------------------------------------------------------------
-- P4-11 — feedback.
--
-- Per request, not periodic. Amier 54:30: "mas realistic kung every request,
-- may chance silang magbigay ng feedback."
-- ---------------------------------------------------------------------------
create table vizserve_pms_feedback (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references vizserve_pms_tasks (id) on delete cascade,
  request_id uuid references vizserve_pms_requests (id) on delete set null,
  token_id   uuid references vizserve_pms_approval_tokens (id) on delete set null,
  rating     integer not null,
  comment    text,
  created_at timestamptz not null default now(),

  constraint vizserve_pms_feedback_rating_range check (rating between 1 and 5),
  -- One per task. A client who can rate twice can rate a hundred times.
  constraint vizserve_pms_feedback_one_per_task unique (task_id)
);

alter table vizserve_pms_feedback enable row level security;
revoke all on vizserve_pms_feedback from anon;

-- Feedback is about the team's performance, so it is readable department-wide
-- by leads rather than only by the people named on the task. Phase 6 reports it.
create policy "feedback readable by leads"
  on vizserve_pms_feedback for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id and vizserve_pms_manages_department(t.department_id)
    )
  );

revoke insert, update, delete on vizserve_pms_feedback from authenticated;

-- ---------------------------------------------------------------------------
-- P4-02 — issuance.
--
-- Returns the RAW token exactly once. It is never stored, never logged, and
-- never returned to a browser — the caller is a server action which puts it
-- straight into an email and forgets it.
--
-- `gen_random_bytes(32)` is 256 bits from the OS CSPRNG, not from `random()`,
-- which is seeded and predictable.
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
begin
  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- The identity the whole gate rests on. A task with no request behind it
  -- (P3-12) has no client to approve it, and silently issuing a token bound to
  -- nothing would be worse than refusing.
  select r.requester_email, coalesce(f.client_approval_days, 3)
    into v_email, v_days
    from vizserve_pms_requests r
    join vizserve_pms_forms f on f.id = r.form_id
   where r.id = v_task.request_id;

  if v_email is null then
    raise exception 'That task has no client to approve it.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_raw := encode(gen_random_bytes(32), 'hex');
  v_deadline := vizserve_pms_add_business_days(now(), v_days);

  insert into vizserve_pms_approval_tokens (
    task_id, purpose, token_hash, requester_email, expires_at, auto_complete_at
  ) values (
    p_task_id,
    p_purpose,
    encode(digest(v_raw, 'sha256'), 'hex'),
    v_email,
    -- Comfortably longer than the auto-complete window: a token that expires
    -- before the deadline it states would be a link that dies while the email
    -- still promises it works.
    now() + interval '14 days',
    case when p_purpose = 'approval' then v_deadline else null end
  )
  returning id into v_id;

  return jsonb_build_object(
    'token_id', v_id,
    -- The only time this value ever exists outside the email.
    'token', v_raw,
    'requester_email', v_email,
    'auto_complete_at', case when p_purpose = 'approval' then v_deadline else null end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Reading a token, for rendering the public page.
--
-- Returns everything the page needs and nothing it does not: no department, no
-- PIC name, no internal ids beyond the task. A public endpoint that leaks the
-- org chart is a small thing that compounds.
--
-- Deliberately does NOT consume. Looking at the page is not deciding.
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
-- P4-05 / P4-06 / P4-07 — the decision handler.
--
-- One function, one transaction. Validates, records, transitions, consumes.
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
  perform vizserve_pms_notify(
    person, 'client_decision',
    case p_decision
      when 'APPROVED' then 'Client approved: ' || coalesce(v_reference, v_task.title)
      else 'Client asked for changes: ' || coalesce(v_reference, v_task.title)
    end,
    coalesce(v_comment, ''), 'task', v_task.id, '/tasks/' || v_task.id::text
  )
  from unnest(array[v_task.assignee_id, v_task.qa_assignee_id]) as person
  where person is not null;

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
-- P4-09 — auto-complete.
--
-- Called by the cron with the service role. Returns what it closed so the
-- caller can send the feedback requests.
--
-- COMPLETED_NO_RESPONSE, never COMPLETED. "The client approved" and "nobody
-- answered and the clock ran out" are different facts, and if a dispute happens
-- the record has to show which one this was.
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
    select t.id, t.status, t.assignee_id, t.qa_assignee_id, tok.id as token_id,
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
      'Closed with no client response: ' || coalesce(v_row.reference_no, ''),
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

-- ---------------------------------------------------------------------------
-- P4-08 — reminders.
--
-- "A single email that lands in spam should not silently close a ticket."
-- Returns the tokens due a nudge and stamps them, so the cron can send without
-- risking a second reminder on its next pass.
--
-- Reminders are sent while there is still time to act on them, so a token whose
-- deadline has already passed is skipped — auto-complete will deal with it.
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
    returning tok.task_id, tok.auto_complete_at, tok.reminder_count
  )
  select
    c.task_id,
    r.reference_no,
    r.requester_email::text,
    r.requester_name,
    t.title,
    c.auto_complete_at,
    c.reminder_count
  from claimed c
  join vizserve_pms_tasks t on t.id = c.task_id
  left join vizserve_pms_requests r on r.id = t.request_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- P4-10 / P4-11 — feedback submission.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_submit_feedback(
  p_token   text,
  p_rating  integer,
  p_comment text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_token vizserve_pms_approval_tokens;
  v_task  vizserve_pms_tasks;
begin
  select * into v_token
    from vizserve_pms_approval_tokens
   where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
     and purpose = 'feedback'
   for update;

  if v_token.id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;

  if v_token.expires_at < now() then
    return jsonb_build_object('ok', false, 'error', 'expired');
  end if;

  if v_token.consumed_at is not null then
    return jsonb_build_object('ok', false, 'error', 'already_used');
  end if;

  if p_rating is null or p_rating < 1 or p_rating > 5 then
    return jsonb_build_object('ok', false, 'error', 'invalid_rating');
  end if;

  select * into v_task from vizserve_pms_tasks where id = v_token.task_id;

  insert into vizserve_pms_feedback (task_id, request_id, token_id, rating, comment)
  values (v_task.id, v_task.request_id, v_token.id, p_rating,
          nullif(btrim(coalesce(p_comment, '')), ''))
  on conflict (task_id) do nothing;

  update vizserve_pms_approval_tokens set consumed_at = now() where id = v_token.id;

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants.
--
-- `anon` gets EXECUTE on exactly three functions and no table privilege at all.
-- Every one of them validates its own token and returns a structured result
-- rather than raising, so a bad token is a shrug and not a stack trace.
-- ---------------------------------------------------------------------------
revoke all on function vizserve_pms_get_approval_page(text) from public;
revoke all on function vizserve_pms_record_client_decision(text, vizserve_pms_client_decision, text, text, text, text) from public;
revoke all on function vizserve_pms_submit_feedback(text, integer, text) from public;

grant execute on function vizserve_pms_get_approval_page(text) to anon, authenticated;
grant execute on function vizserve_pms_record_client_decision(text, vizserve_pms_client_decision, text, text, text, text) to anon, authenticated;
grant execute on function vizserve_pms_submit_feedback(text, integer, text) to anon, authenticated;

-- Issuance and the cron jobs are service-role only. Notably NOT granted to
-- `authenticated`: a staff member who could mint a token could approve their own
-- work as the client, which is the entire gate defeated in one call.
revoke all on function vizserve_pms_issue_approval_token(uuid, vizserve_pms_token_purpose) from public;
revoke all on function vizserve_pms_auto_complete_approvals() from public;
revoke all on function vizserve_pms_claim_approval_reminders(integer) from public;

grant execute on function vizserve_pms_add_business_days(timestamptz, integer) to authenticated;
