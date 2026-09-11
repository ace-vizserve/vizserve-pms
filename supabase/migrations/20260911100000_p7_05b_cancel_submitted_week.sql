-- ---------------------------------------------------------------------------
-- P7-05b — cancelling a submitted week to revise it.
--
-- Until now a submitted week could only come back to its owner by the lead
-- sending it back, so somebody who spotted a wrong Tuesday a minute after
-- pressing submit had to ask their lead to write a reason for a mistake the lead
-- had not even looked at.
--
-- ⚠️ CANCELLING DELETES THE ROW, AND THAT IS THE MODEL, NOT A SHORTCUT. P7-05
-- has no DRAFT status: the absence of a row IS the draft state. A cancelled
-- submission is exactly a week that has not been submitted, so it is exactly
-- no row — the lock (`vizserve_pms_timesheet_week_locked`) lifts, the lead's
-- queue drops it, and P11-07's personal-work visibility goes back to private,
-- all without any reader learning a new status. The audit entry keeps the
-- before-image, so the trail still shows it was submitted and taken back.
--
-- ONLY WHILE SUBMITTED. An APPROVED week is somebody's signed decision, and
-- the way to reopen it is still the lead sending it back. A RETURNED week is
-- already editable, so there is nothing to cancel.
--
-- Both this and `vizserve_pms_decide_timesheet_week` lock the row `for update`,
-- so a cancel racing a decision resolves one way or the other: the decision
-- lands first and the cancel is refused, or the cancel lands first and the
-- decision finds the week gone.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_withdraw_timesheet_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user     uuid := auth.uid();
  v_week     date;
  v_row      vizserve_pms_timesheet_weeks;
  v_name     text;
  v_approver record;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- Normalised the same way the submit function does it.
  v_week := date_trunc('week', p_week_start)::date;

  -- The caller's own week and nobody else's: there is no user parameter.
  select * into v_row
    from vizserve_pms_timesheet_weeks
   where user_id = v_user and week_start = v_week
   for update;

  if v_row.id is null then
    raise exception 'That week has not been submitted.' using errcode = 'no_data_found';
  end if;

  if v_row.status = 'APPROVED' then
    raise exception 'That week has been approved. Ask your lead to send it back if it needs changing.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_row.status = 'RETURNED' then
    raise exception 'That week is already back with you to edit.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Written first, while the row still exists to describe.
  perform vizserve_pms_write_audit_log(
    'timesheet_week', v_row.id, 'withdrawn', v_user, to_jsonb(v_row),
    jsonb_build_object('week_start', v_week, 'minutes', v_row.submitted_minutes)
  );

  delete from vizserve_pms_timesheet_weeks where id = v_row.id;

  select u.full_name into v_name from vizserve_pms_users u where u.id = v_user;

  -- Every lead the submission notified, told it no longer needs them. The
  -- department is the one snapshotted on the row, which is the one the
  -- submission went to. `internal_decision` rather than a new type, for the
  -- reason P11-13 gives: a new type with no settings row is silently mail-less.
  for v_approver in
    select md.user_id
      from vizserve_pms_user_managed_departments md
      join vizserve_pms_users u on u.id = md.user_id
     where md.department_id = v_row.department_id
       and u.is_active
       and u.id <> v_user
  loop
    perform vizserve_pms_notify(
      v_approver.user_id,
      'internal_decision',
      coalesce(v_name, 'A colleague') || ' cancelled their timesheet submission',
      'Week of ' || to_char(v_week, 'DD Mon YYYY') || ' no longer needs your approval. They will resubmit it.',
      'timesheet_week',
      v_row.id,
      '/timesheet/team?week=' || v_week::text
    );
  end loop;

  return jsonb_build_object('ok', true);
end;
$$;

comment on function vizserve_pms_withdraw_timesheet_week(date) is
  'P7-05b. The owner cancels their own SUBMITTED week so they can revise it. '
  'Deletes the row — no row is the draft state — after writing the audit '
  'before-image, and tells the department leads. Refuses APPROVED and RETURNED.';

grant execute on function vizserve_pms_withdraw_timesheet_week(date) to authenticated;
