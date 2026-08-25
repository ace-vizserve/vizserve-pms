-- ---------------------------------------------------------------------------
-- P7-39 — TIME_IN_CORRECTION and TIME_OUT_CORRECTION, wired through.
--
-- Three things, one file, because they are one behaviour: the shape constraint
-- that decides what a row of each type may carry, the submit function that
-- validates and files it, and the decide function that writes the corrected
-- time back into the DTR on approval. Split them and there is an orderable
-- window where a type exists but cannot be filed, or can be filed and does
-- nothing when approved.
--
-- ⚠️ P7-38 MUST BE APPLIED FIRST. This file USES the two enum values, which is
-- the thing Postgres forbids in the transaction that adds them.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment.
-- ---------------------------------------------------------------------------


-- ---------------------------------------------------------------------------
-- 1. THE SHAPE CONSTRAINT
--
-- ⚠️ THE `not valid` ON LINE ~110 IS THE MOST DANGEROUS LINE IN THIS FILE.
--
-- The live constraint is NOT VALID (p7_16:99) because LEAVE rows filed before
-- P7-12 have a null leave_type_id and cannot satisfy the LEAVE branch. Drop it
-- and re-add it VALIDATED — which is what p7_04 did, correctly, at a time when
-- no such history existed — and Postgres validates against the whole table, hits
-- those rows, and aborts the ALTER. Inside a single pasted transaction that
-- rolls the DROP back too, so the visible result is a leave_type_id violation
-- raised while shipping a time correction, which is three features away from
-- anything the person is looking at. Copying p7_04's ALTER verbatim is the trap.
--
-- NOT VALID still enforces the rule on every INSERT and UPDATE from here. It
-- only declines to re-examine history, which is the correct posture for every
-- rule this table has gained since P5-05.
--
-- TWO NEW BRANCHES, byte-identical to NO_TIME_IN, rather than one branch listing
-- four types. Sharing is not even expressible in the simple `case request_type
-- when` form — PostgreSQL has no `when a, b then` — so it would mean rewriting
-- all five existing branches into the searched form to save two. More to the
-- point it reverses p7_04:44-59, which exists precisely because one branch
-- covering several types is how OVERTIME was silently forced to carry a
-- correction_at. A branch covering four types is the same mistake with commas
-- in it, and the first time TIME_IN_CORRECTION gains a column of its own — a
-- snapshot of the schedule it was measured against, say — it has to be split
-- again, under time pressure, by somebody who did not write it.
--
-- `else false` is preserved and is what makes the next enum value fail loudly
-- rather than fall through into somebody else's rules.
--
-- `drop constraint if exists` rather than a bare drop, since this file is pasted
-- by hand and may be re-pasted. The consequence, stated so it is not a surprise:
-- if a paste dies between the drop and the add on a connection where each
-- statement autocommits, the table is briefly unconstrained. Verify afterwards
-- with the pg_constraint query at the bottom of this file.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_internal_requests
  drop constraint if exists vizserve_pms_internal_requests_shape;

alter table vizserve_pms_internal_requests
  add constraint vizserve_pms_internal_requests_shape check (
    case request_type
      when 'LEAVE' then
        start_date is not null and end_date is not null
        and end_date >= start_date
        -- A one-day request cannot start in the afternoon and end in the
        -- morning. Across two or more days every combination is legal:
        -- afternoon-to-morning is the ordinary "half a day either end" shape.
        and (
          start_half is null or end_half is null
          or start_date < end_date
          or start_half <= end_half
        )
        and work_date is null and correction_at is null and amount is null
        and overtime_minutes is null
        and leave_type_id is not null
      when 'REIMBURSEMENT' then
        amount is not null and amount > 0
        and start_date is null and end_date is null
        and work_date is null and correction_at is null
        and overtime_minutes is null
        and leave_type_id is null
        and start_half is null and end_half is null
      when 'OVERTIME' then
        work_date is not null and overtime_minutes is not null
        and start_date is null and end_date is null
        and correction_at is null and amount is null
        and leave_type_id is null
        and start_half is null and end_half is null
      when 'NO_TIME_IN' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
        and leave_type_id is null
        and start_half is null and end_half is null
      when 'NO_TIME_OUT' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
        and leave_type_id is null
        and start_half is null and end_half is null
      -- P7-39. The same payload as the pair above, and identical on purpose:
      -- same fix, different claim. A correction says the punch is wrong; a
      -- NO_TIME_* says there is no punch. See p7_38's header.
      when 'TIME_IN_CORRECTION' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
        and leave_type_id is null
        and start_half is null and end_half is null
      when 'TIME_OUT_CORRECTION' then
        work_date is not null and correction_at is not null
        and start_date is null and end_date is null and amount is null
        and overtime_minutes is null
        and leave_type_id is null
        and start_half is null and end_half is null
      else false
    end
  ) not valid;


-- ---------------------------------------------------------------------------
-- 2. SUBMISSION — exactly one line of this function changes.
--
-- The body below is copied from p7_16b, which is the authoritative version.
-- NOT p7_16 (broken twice), NOT p5_05 (predates leave types and halves), NOT
-- p7_16a (superseded by 16b). Copying from the wrong one reintroduces a bug
-- that this project has already shipped to production twice.
--
-- THE DIFF, in full: line 133 of p7_16b,
--   if p_request_type in ('NO_TIME_IN', 'NO_TIME_OUT') then
-- gains the two new types. Without it v_correction stays null for a correction,
-- the insert writes correction_at = null, and the user's error message is the
-- name of a check constraint.
--
-- ⚠️ NO DROP AND NO REGRANT, and this is not the same situation as p7_04 or
-- p7_16. Those ADDED parameters, which creates a second overload that PostgREST
-- cannot resolve — it matches RPCs by argument name — so the old signature had
-- to be dropped. Here the eleven parameters are unchanged, so `create or
-- replace` replaces the one function in place, creates no overload, and keeps
-- the EXECUTE grant that a DROP would take with it. p7_16a:60-72 states this
-- reasoning; follow 16a/16b, not 16.
--
-- (A related trap avoided by copying rather than retyping: `create or replace`
-- refuses outright if a parameter NAME changes. Nothing here renames one, which
-- is why the eleven names are reproduced character for character.)
--
-- DELIBERATELY NOT ADDED: a check that the day already has a punch. A
-- TIME_IN_CORRECTION on a day with no time_in is really a NO_TIME_IN, and
-- refusing it here is tempting. It would couple submission to the DTR, race
-- vizserve_pms_punch between the read and the write, and turn a mis-picked
-- dropdown into a hard refusal at the moment somebody is trying to report a
-- problem. The UI picks the right type; the database accepts either; the
-- distinction is for the approver and the report, not for the constraint.
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
  p_amount          numeric default null,
  p_overtime_minutes integer default null,
  p_leave_type_id   uuid default null,
  p_start_half      vizserve_pms_day_half default 'MORNING',
  p_end_half        vizserve_pms_day_half default 'AFTERNOON'
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

    if not exists (
      select 1 from vizserve_pms_leave_types lt
       where lt.id = p_leave_type_id and lt.is_active
    ) then
      raise exception 'That leave type is no longer available. Pick one from the list.'
        using errcode = 'check_violation';
    end if;

    -- P7-16. The constraint says the same thing, but a constraint violation
    -- reads as a constraint name. This is the sentence somebody can act on.
    if p_start_date = p_end_date and p_start_half > p_end_half then
      raise exception 'Leave on one day cannot start in the afternoon and end in the morning.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ⚠️ P7-39: THE ONE FUNCTIONAL CHANGE IN THIS FUNCTION. All four correction
  -- types compose an instant the same way and refuse the future the same way.
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

  insert into vizserve_pms_internal_requests (
    request_type, requester_id, department_id, reason,
    start_date, end_date, work_date, correction_at, amount, overtime_minutes,
    leave_type_id, start_half, end_half
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount, p_overtime_minutes,
    case when p_request_type = 'LEAVE' then p_leave_type_id else null end,
    -- Coerced to null for every other type, exactly as the leave type is: the
    -- constraint would refuse a stray value, but refusing a request because the
    -- client sent a field it had no business sending is a worse error message
    -- than ignoring it.
    case when p_request_type = 'LEAVE' then coalesce(p_start_half, 'MORNING') else null end,
    case when p_request_type = 'LEAVE' then coalesce(p_end_half, 'AFTERNOON') else null end
  )
  returning id into v_id;

  -- Six arguments. `v_user` is the ACTOR (fourth), `null` the before-image
  -- (fifth), the payload the after-image (sixth). Repaired in P7-16a; restated
  -- here because this file replaces the whole body.
  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object('request_type', p_request_type, 'department_id', v_department)
  );

  -- ⚠️ THE BLOCK P7-16b EXISTS FOR — reproduced verbatim, again. Rewriting a
  -- function body is how it was lost twice: the type must be 'pending_approval'
  -- (nothing else is in the enum), the recipient `md.user_id`, and the title
  -- "<type> request from <name>". Nothing about the two new types changes it.
  --
  -- Everyone who leads the requester's department hears about it. Not one
  -- nominated approver: a queue with a single named owner stalls the moment
  -- that person is on leave, which for a leave-request module is not a corner
  -- case.
  --
  -- The notification says "leave request from X" and NOT which kind. The type
  -- is on the request for the lead who opens it; it does not belong in a title
  -- that may surface on a lock screen. Same instinct as P7-10.
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

-- A no-op on a healthy database — `create or replace` keeps the existing grant.
-- Restated for the same reason p7_16b restates it: if an earlier paste ever died
-- between a DROP and its regrant, the function is present and unexecutable, and
-- `permission denied for function` reads nothing like any other failure here.
grant execute on function vizserve_pms_submit_internal_request(
  vizserve_pms_internal_request_type, text, date, date, date, time, numeric, integer, uuid,
  vizserve_pms_day_half, vizserve_pms_day_half
) to authenticated;


-- ---------------------------------------------------------------------------
-- 3. DECIDE — the DTR write-back, widened ONCE rather than in seven places.
--
-- Body copied from p5_05:248-390. No migration has touched it since: p7_04:246,
-- p7_12:366, p7_16:280 and p7_33:413 each state they leave it alone, because
-- `v_req` is the table rowtype and therefore picks up new columns for free. A
-- new request TYPE is the one change that does not come for free.
--
-- ⚠️ THE SILENT FAILURE THIS SHAPE EXISTS TO PREVENT. Seven expressions named
-- NO_TIME_IN or NO_TIME_OUT: the outer guard, two ordering checks, two INSERT
-- values and two ON CONFLICT branches. Widen the outer guard and miss one of the
-- four `case` sites and the failure is invisible in every direction — the `case`
-- has no `else`, so it yields null, the upsert writes the existing time straight
-- back, and the approval still sets corrected_by, corrected_at,
-- correction_request_id, still writes a 'corrected' audit row, and still returns
-- a non-null dtr_entry_id. Every signal the app can see says it worked and the
-- DTR is unchanged. That is worse than the two P7-16 crashes, which at least
-- raised.
--
-- So the type test happens twice, into two booleans, and the seven sites read a
-- name instead. A boolean cannot be half-right, and the next correction type is
-- a one-line change rather than a seven-site sweep. The diff is larger than a
-- mechanical find-and-replace, which is the argument FOR it: a mechanical sweep
-- of a function that has been broken twice by small rewrites is exactly the
-- pattern that made P7-16a an incomplete repair.
--
-- Signature unchanged, so again: create or replace, no drop, no regrant.
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
  v_req       vizserve_pms_internal_requests;
  v_before    jsonb;
  v_status    vizserve_pms_internal_request_status;
  v_entry_id  uuid;
  v_existing  vizserve_pms_dtr_entries;
  -- P7-39. Assigned once, read seven times. See the header.
  v_fixes_in  boolean;
  v_fixes_out boolean;
begin
  if p_decision = 'returned' then
    raise exception 'Internal requests are approved or rejected, not returned.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  v_fixes_in  := v_req.request_type in ('NO_TIME_IN',  'TIME_IN_CORRECTION');
  v_fixes_out := v_req.request_type in ('NO_TIME_OUT', 'TIME_OUT_CORRECTION');

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

  -- ----------------------------------------------------------- P5-09 / P7-39
  if v_status = 'APPROVED' and (v_fixes_in or v_fixes_out) then
    select * into v_existing
      from vizserve_pms_dtr_entries
     where user_id = v_req.requester_id and work_date = v_req.work_date;

    -- Checked before writing so the caller gets a sentence instead of a
    -- constraint name from vizserve_pms_dtr_entries_out_after_in.
    if v_fixes_in
       and v_existing.time_out is not null
       and v_req.correction_at > v_existing.time_out then
      raise exception 'That time-in is after the recorded time-out on %. Correct the time-out first.', v_req.work_date
        using errcode = 'check_violation';
    end if;

    if v_fixes_out
       and v_existing.time_in is not null
       and v_req.correction_at < v_existing.time_in then
      raise exception 'That time-out is before the recorded time-in on %. Correct the time-in first.', v_req.work_date
        using errcode = 'check_violation';
    end if;

    -- Assigned, NOT coalesced, and NOT greatest(). This is the one path allowed
    -- to overwrite an earliest-in, and that is the entire reason the correction
    -- forms exist — P5-02 makes the punch itself unoverwritable on purpose, so
    -- the only way back is through an approval somebody else signed off.
    --
    -- P7-39 leans on this harder than P5-09 did: a TIME_OUT_CORRECTION routinely
    -- moves a time-out EARLIER, which is precisely the write vizserve_pms_punch
    -- refuses with greatest(). Reintroduce either function's protective idiom
    -- here and approving such a correction silently does nothing.
    insert into vizserve_pms_dtr_entries (
      user_id, work_date, time_in, time_out,
      corrected_by, corrected_at, correction_request_id
    ) values (
      v_req.requester_id,
      v_req.work_date,
      case when v_fixes_in then v_req.correction_at end,
      case when v_fixes_out then v_req.correction_at end,
      auth.uid(), now(), p_id
    )
    on conflict (user_id, work_date) do update
       set time_in = case
             when v_fixes_in then v_req.correction_at
             else vizserve_pms_dtr_entries.time_in
           end,
           time_out = case
             when v_fixes_out then v_req.correction_at
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

grant execute on function vizserve_pms_decide_internal_request(
  uuid, vizserve_pms_approval_decision, text
) to authenticated;

-- No RLS change anywhere in this file. The select policy on
-- vizserve_pms_internal_requests is on the ROW — requester, or a lead of the
-- snapshotted department — and knows nothing about request_type, so the two new
-- types are scoped correctly the moment they exist. vizserve_pms_dtr_entries
-- keeps having no INSERT or UPDATE policy, which is what makes the function
-- above the only way a punch can ever be overwritten.

-- ---------------------------------------------------------------------------
-- ⚠️ AFTER APPLYING, RUN THESE, AND THEN ACTUALLY CALL THE RPCs.
--
--   select count(*) from pg_proc where proname = 'vizserve_pms_submit_internal_request';
--   -- must be 1. Two means an overload survived and PostgREST will 300.
--
--   select p.proname, has_function_privilege('authenticated', p.oid, 'execute')
--     from pg_proc p
--    where p.proname in ('vizserve_pms_submit_internal_request',
--                        'vizserve_pms_decide_internal_request');
--   -- must be t, t.
--
--   select convalidated from pg_constraint
--    where conname = 'vizserve_pms_internal_requests_shape';
--   -- must be f. `t` means the not valid was dropped and history was validated.
--
-- Then file and approve one TIME_OUT_CORRECTION that moves a time-out EARLIER.
-- plpgsql resolves the calls inside a body at FIRST EXECUTION, so `create or
-- replace` cheerfully accepts a body calling a signature that has never existed
-- — p7_16a:38-54 is the whole lesson. Reading this file proves nothing about it.
-- ---------------------------------------------------------------------------
