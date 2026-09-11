-- ---------------------------------------------------------------------------
-- P8-05b — a short week is WARNED about, not refused.
--
-- P8-05 refused any submission whose logged minutes fell below the scheduled
-- week. In practice that locked people out of handing in a week they had a
-- legitimate reason to be short on — an emergency, leave nobody had approved
-- yet — with no way through but to invent hours or wait on somebody else.
--
-- The decision now sits with the person submitting. `/timesheet` asks them to
-- confirm a short week before it is sent, and tells them their team leader will
-- see it is short. The lead still sees exactly what was logged
-- (`submitted_minutes`) and can send the week back.
--
-- Everything else is P8-05's function unchanged: the empty-week refusal, the
-- already-submitted / already-approved refusals, the lock, the audit row and
-- the notifications. The break columns and `vizserve_pms_minutes_text` stay —
-- the screens still compute the scheduled week from them.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, AFTER
-- 20260903090000_p8_05_break_and_week_minimum.sql. `create or replace` with an
-- unchanged signature, so the existing grants carry over.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_submit_timesheet_week(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user       uuid := auth.uid();
  v_department uuid;
  v_name       text;
  v_week       date;
  v_this_week  date;
  v_total      integer;
  v_existing   vizserve_pms_timesheet_weeks;
  v_id         uuid;
  v_approver   record;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  -- Normalised, never trusted.
  v_week := date_trunc('week', p_week_start)::date;

  -- Manila FIRST, then truncate — see P8-05 for the Sunday-night bug the other
  -- order produces.
  v_this_week := date_trunc('week', (now() at time zone 'Asia/Manila')::date)::date;

  if v_week > v_this_week then
    raise exception 'That week has not happened yet.' using errcode = 'check_violation';
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

  -- Lock the week's rows before totalling them, so `submitted_minutes` records
  -- a figure another tab cannot change underneath it.
  perform 1
    from vizserve_pms_timesheet_entries e
   where e.user_id = v_user
     and e.work_date between v_week and v_week + 6
   for update;

  select coalesce(sum(e.minutes), 0) into v_total
    from vizserve_pms_timesheet_entries e
   where e.user_id = v_user
     and e.work_date between v_week and v_week + 6;

  -- An approved empty week is a signed statement that somebody did nothing for
  -- five days. It is almost always a misclick on the wrong week.
  if v_total = 0 then
    raise exception 'There is nothing logged in that week to submit.'
      using errcode = 'check_violation';
  end if;

  select * into v_existing
    from vizserve_pms_timesheet_weeks
   where user_id = v_user and week_start = v_week
   for update;

  if v_existing.id is not null then
    if v_existing.status = 'SUBMITTED' then
      raise exception 'That week is already with your lead.'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_existing.status = 'APPROVED' then
      raise exception 'That week has been approved. Ask your lead to send it back if it needs changing.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- RETURNED: fixed and going back. The previous decision is cleared rather
    -- than kept, because a week showing both "sent back for X" and "submitted"
    -- reads as though X is still outstanding.
    update vizserve_pms_timesheet_weeks
       set status            = 'SUBMITTED',
           submitted_minutes = v_total,
           submitted_at      = now(),
           decision_reason   = null,
           reviewed_by       = null,
           reviewed_at       = null
     where id = v_existing.id;

    v_id := v_existing.id;
  else
    insert into vizserve_pms_timesheet_weeks (
      user_id, week_start, department_id, status, submitted_minutes
    ) values (
      v_user, v_week, v_department, 'SUBMITTED', v_total
    )
    returning id into v_id;
  end if;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', v_id, 'submitted', v_user, null,
    jsonb_build_object('week_start', v_week, 'minutes', v_total)
  );

  -- Everyone who leads the department: a queue with one named owner stalls the
  -- week that person is away.
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
      'Timesheet from ' || v_name,
      'Week of ' || to_char(v_week, 'DD Mon YYYY'),
      'timesheet_week',
      v_id,
      '/timesheet/team?week=' || v_week::text
    );
  end loop;

  return jsonb_build_object('ok', true, 'id', v_id, 'minutes', v_total);
end;
$$;

comment on function vizserve_pms_submit_timesheet_week(date) is
  'P7-05, with P8-05b. Hands a week to the department lead, refusing an empty '
  'week, a future week, and one already submitted or approved. A week short of '
  'its schedule is NOT refused — /timesheet confirms it with the person first, '
  'and the lead sees the logged total.';
