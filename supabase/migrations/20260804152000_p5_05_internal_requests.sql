-- P5-05 / P5-07 / P5-08 / P5-09 — Internal approvals.
--
-- THE POINT OF THIS FILE IS HOW LITTLE OF IT THERE IS.
--
-- The four internal types are new request types and new forms — not new
-- approval logic (docs/09). Everything about "who may decide", "a reason is
-- mandatory on the negative path", "write an audit row", "record who decided
-- what and when" already exists in vizserve_pms_record_decision, and this file
-- calls it exactly the way Gate 1 does. Nothing in the P2-00 engine section was
-- edited to make this work, which was the stated acceptance test for that
-- abstraction.
--
-- If a future internal type finds itself re-implementing approve/reject here,
-- the Phase 2 abstraction has failed and THAT is the bug — not this file.
--
-- LEAVE BALANCES ARE OUT OF SCOPE and must stay out. Amier, 22:40: HR counts
-- manually for now, "ang mahalaga lang, may record". Accrual, carry-over,
-- pro-rating and holiday entitlement are a project of their own and this is the
-- single easiest place in the build for scope to explode.

create type vizserve_pms_internal_request_type as enum (
  'LEAVE',
  'NO_TIME_IN',
  'NO_TIME_OUT',
  'REIMBURSEMENT'
);

-- No RETURNED. Gate 1 has it because a client can be asked for more detail and
-- resubmit; an internal request is approved or it is not, and P5-08 specifies
-- exactly those two outcomes. The engine still supports 'returned' — this
-- consumer simply never asks for it.
create type vizserve_pms_internal_request_status as enum (
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED'
);

create table vizserve_pms_internal_requests (
  id            uuid primary key default gen_random_uuid(),
  request_type  vizserve_pms_internal_request_type not null,
  requester_id  uuid not null references vizserve_pms_users (id) on delete restrict,

  -- P5-07 routing, snapshotted at submission. Same reasoning as
  -- vizserve_pms_approvals.department_id: someone may move team next month, and
  -- the decision was made under the arrangement that existed at the time.
  department_id uuid not null references vizserve_pms_departments (id) on delete restrict,

  status        vizserve_pms_internal_request_status not null default 'PENDING_REVIEW',

  -- Why the person is asking. Always required — an approver deciding blind is
  -- the rubber stamp this module exists to replace.
  reason        text not null,

  -- LEAVE
  start_date    date,
  end_date      date,

  -- NO_TIME_IN / NO_TIME_OUT. work_date is the day being corrected;
  -- correction_at is the instant to write into the DTR, composed server-side
  -- from the date and a wall-clock time in Manila so a client can never hand us
  -- an instant in the wrong zone.
  work_date     date,
  correction_at timestamptz,

  -- REIMBURSEMENT
  amount        numeric(12, 2),

  decision_reason text,
  reviewed_by     uuid references vizserve_pms_users (id) on delete set null,
  reviewed_at     timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Rules live in the database, not just the UI — the front end will be
  -- bypassed. Each type carries exactly the fields it needs and none of the
  -- others, so a leave request cannot arrive carrying an amount.
  constraint vizserve_pms_internal_requests_shape check (
    case request_type
      when 'LEAVE' then
        start_date is not null and end_date is not null
        and end_date >= start_date
        and work_date is null and correction_at is null and amount is null
      when 'REIMBURSEMENT' then
        amount is not null and amount > 0
        and start_date is null and end_date is null
        and work_date is null and correction_at is null
      else -- NO_TIME_IN / NO_TIME_OUT
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
    end
  ),

  constraint vizserve_pms_internal_requests_reason_present
    check (length(btrim(reason)) > 0),

  -- A rejection without a reason is the thing the engine already forbids for
  -- the approval row; this keeps the copy on the request itself honest too.
  constraint vizserve_pms_internal_requests_decision_reason
    check (status <> 'REJECTED' or (decision_reason is not null and length(btrim(decision_reason)) > 0))
);

create index vizserve_pms_internal_requests_requester_idx
  on vizserve_pms_internal_requests (requester_id, created_at desc);
create index vizserve_pms_internal_requests_queue_idx
  on vizserve_pms_internal_requests (department_id, status, created_at desc);

create trigger vizserve_pms_internal_requests_updated_at
  before update on vizserve_pms_internal_requests
  for each row execute function vizserve_pms_set_updated_at();

-- The FK the DTR migration deliberately left off, now that its target exists.
alter table vizserve_pms_dtr_entries
  add constraint vizserve_pms_dtr_entries_correction_request_fkey
  foreign key (correction_request_id)
  references vizserve_pms_internal_requests (id) on delete set null;

-- Settings row for the type added in the previous migration. Safe here: that
-- ALTER TYPE committed before this file began.
insert into vizserve_pms_notification_type_settings (type, send_email, description) values
  ('internal_decision', false,
   'Your internal request was approved or rejected. Inbox only — the requester is staff with an inbox, and docs/12 reserves email for people who have no other channel.')
on conflict (type) do nothing;

-- ---------------------------------------------------------------------------
-- P5-06 / P5-07 — submit.
--
-- SECURITY DEFINER rather than an INSERT policy, for one reason: the routing
-- department must come from the requester's actual record, never from the
-- client. An INSERT policy could check that department_id is *a* department the
-- user could claim, but this way the question never reaches the client at all.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_submit_internal_request(
  p_request_type    vizserve_pms_internal_request_type,
  p_reason          text,
  p_start_date      date default null,
  p_end_date        date default null,
  p_work_date       date default null,
  -- Wall-clock time on p_work_date, e.g. '08:00'. Combined with the date in
  -- Manila below; the client never sends an instant.
  p_correction_time time default null,
  p_amount          numeric default null
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

  -- Without a department there is nobody to route to. Failing here with a
  -- sentence beats writing an unroutable row that sits in no queue at all.
  if v_department is null then
    raise exception 'You have no department set, so there is nobody to approve this. Ask an admin to set your department.'
      using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'Say why you are requesting this.' using errcode = 'check_violation';
  end if;

  if p_request_type in ('NO_TIME_IN', 'NO_TIME_OUT') then
    if p_work_date is null or p_correction_time is null then
      raise exception 'A correction needs the date and the time it should have been.'
        using errcode = 'check_violation';
    end if;

    -- Composed in app time, then stored as an instant. The DTR stores
    -- timestamptz, and "08:00 on the 3rd" is only meaningful with a zone.
    v_correction := (p_work_date::text || ' ' || p_correction_time::text)::timestamp
                    at time zone 'Asia/Manila';

    if v_correction > now() then
      raise exception 'You cannot correct a time that has not happened yet.'
        using errcode = 'check_violation';
    end if;
  end if;

  insert into vizserve_pms_internal_requests (
    request_type, requester_id, department_id, reason,
    start_date, end_date, work_date, correction_at, amount
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount
  )
  returning id into v_id;

  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object('request_type', p_request_type, 'department_id', v_department)
  );

  -- Everyone who leads the requester's department hears about it. Not one
  -- nominated approver: a queue with a single named owner stalls the moment
  -- that person is on leave, which for a leave-request module is not a corner
  -- case.
  for v_approver in
    select md.user_id
      from vizserve_pms_user_managed_departments md
      join vizserve_pms_users u on u.id = md.user_id
     where md.department_id = v_department
       and u.is_active
       and u.id <> v_user
  loop
    perform vizserve_pms_notify(
      v_approver.user_id,
      'pending_approval',
      replace(p_request_type::text, '_', ' ') || ' request from ' || v_name,
      v_reason,
      'internal_request',
      v_id,
      '/approvals/' || v_id::text
    );
  end loop;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- P5-08 / P5-09 — decide, and correct the DTR when that is what was approved.
--
-- The decision half is four lines because the engine already does it. The
-- interesting half is P5-09: an approved No Time-In is only worth submitting if
-- it ACTUALLY FIXES THE RECORD. An approval that leaves the DTR untouched means
-- somebody still has to edit it by hand, which is the manual step this module
-- was built to delete.
-- ---------------------------------------------------------------------------
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
  v_req      vizserve_pms_internal_requests;
  v_before   jsonb;
  v_status   vizserve_pms_internal_request_status;
  v_entry_id uuid;
  v_existing vizserve_pms_dtr_entries;
begin
  if p_decision = 'returned' then
    raise exception 'Internal requests are approved or rejected, not returned.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  -- Same guard as Gate 1: two approvers clicking seconds apart must not both
  -- succeed, or the second silently overwrites the first one's decision.
  if v_req.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  -- Nobody approves their own leave. The engine checks departmental scope, but
  -- a team leader IS in the department they lead, so scope alone would let them
  -- self-approve.
  if v_req.requester_id = auth.uid() then
    raise exception 'You cannot decide your own request.'
      using errcode = 'insufficient_privilege';
  end if;

  -- THE ENGINE CALL. Scope, the mandatory reason on reject, the approval row
  -- and its audit entry are all handled in there. Untouched since Phase 2.
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

  -- ----------------------------------------------------------- P5-09
  if v_status = 'APPROVED' and v_req.request_type in ('NO_TIME_IN', 'NO_TIME_OUT') then
    select * into v_existing
      from vizserve_pms_dtr_entries
     where user_id = v_req.requester_id and work_date = v_req.work_date;

    -- Checked before writing so the caller gets a sentence instead of a
    -- constraint name from vizserve_pms_dtr_entries_out_after_in.
    if v_req.request_type = 'NO_TIME_IN'
       and v_existing.time_out is not null
       and v_req.correction_at > v_existing.time_out then
      raise exception 'That time-in is after the recorded time-out on %. Correct the time-out first.', v_req.work_date
        using errcode = 'check_violation';
    end if;

    if v_req.request_type = 'NO_TIME_OUT'
       and v_existing.time_in is not null
       and v_req.correction_at < v_existing.time_in then
      raise exception 'That time-out is before the recorded time-in on %. Correct the time-in first.', v_req.work_date
        using errcode = 'check_violation';
    end if;

    -- Assigned, NOT coalesced. This is the one path allowed to overwrite an
    -- earliest-in, and that is the entire reason the correction forms exist —
    -- P5-02 makes the punch itself unoverwritable on purpose, so the only way
    -- back is through an approval somebody else signed off.
    insert into vizserve_pms_dtr_entries (
      user_id, work_date, time_in, time_out,
      corrected_by, corrected_at, correction_request_id
    ) values (
      v_req.requester_id,
      v_req.work_date,
      case when v_req.request_type = 'NO_TIME_IN' then v_req.correction_at end,
      case when v_req.request_type = 'NO_TIME_OUT' then v_req.correction_at end,
      auth.uid(), now(), p_id
    )
    on conflict (user_id, work_date) do update
       set time_in = case
             when v_req.request_type = 'NO_TIME_IN' then v_req.correction_at
             else vizserve_pms_dtr_entries.time_in
           end,
           time_out = case
             when v_req.request_type = 'NO_TIME_OUT' then v_req.correction_at
             else vizserve_pms_dtr_entries.time_out
           end,
           corrected_by = auth.uid(),
           corrected_at = now(),
           correction_request_id = p_id
    returning id into v_entry_id;

    perform vizserve_pms_write_audit_log(
      'dtr_entry', v_entry_id, 'corrected', auth.uid(),
      case when v_existing.id is null then null else to_jsonb(v_existing) end,
      jsonb_build_object(
        'request_type', v_req.request_type,
        'work_date', v_req.work_date,
        'correction_at', v_req.correction_at,
        'internal_request_id', p_id
      )
    );
  end if;

  perform vizserve_pms_write_audit_log(
    'internal_request', p_id, lower(v_status::text), auth.uid(), v_before,
    jsonb_build_object('status', v_status, 'reason', p_reason, 'dtr_entry_id', v_entry_id)
  );

  perform vizserve_pms_notify(
    v_req.requester_id,
    'internal_decision',
    replace(v_req.request_type::text, '_', ' ') || ' request ' || lower(v_status::text),
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''), ''),
    'internal_request',
    p_id,
    '/approvals/' || p_id::text
  );

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'dtr_entry_id', v_entry_id
  );
end;
$$;

alter table vizserve_pms_internal_requests enable row level security;
revoke all on vizserve_pms_internal_requests from anon;

-- Your own requests, plus everything for the department you lead. Same shape as
-- every other queue in the app.
create policy "internal requests readable by requester and department leads"
  on vizserve_pms_internal_requests for select to authenticated
  using (
    requester_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
  );

-- No INSERT or UPDATE policy: rows arrive through the two functions above, so a
-- status cannot be set directly and a decision cannot be forged without the
-- matching vizserve_pms_approvals row.

grant select on vizserve_pms_internal_requests to authenticated;
grant execute on function vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric
) to authenticated;
grant execute on function vizserve_pms_decide_internal_request(
  uuid, vizserve_pms_approval_decision, text
) to authenticated;
