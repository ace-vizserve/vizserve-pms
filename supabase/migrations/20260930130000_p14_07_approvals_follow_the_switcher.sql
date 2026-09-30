-- P14-07 — APPROVALS WORK WITH THE ROLE SWITCHER (30 Sep 2026).
--
-- A person may hold Team Leader AND Manager (Joel: Manager, and Team Leader of
-- VizAssists and VizBooks). The switcher is how they do both jobs. Two things
-- in p14_04 broke that:
--
--   1. WHO A REQUEST WAITS ON read the ACTIVE role. A VizBytes request filed
--      while Amier was acting as Business Manager skipped his Team Leader step;
--      while Joel acted as Team Leader the company had no Manager at all. The
--      pools now read the roles people HOLD, so routing and notifications never
--      depend on what somebody happens to be switched to.
--
--   2. "ONE PERSON CANNOT SIGN TWO STEPS" blocked Joel at the Manager step
--      after he had signed the Team Leader step. Removed.
--
-- AUTHORITY still needs the ACTIVE role: Joel approves the Team Leader step
-- while acting as Team Leader and the final step while acting as Manager. A
-- refusal tells him which role to switch to.
--
-- ⚠️ APPLY BY HAND in the SQL editor, after p14_05. Never `db:push`.


-- ===========================================================================
-- 1. THE POOLS READ HELD ROLES.
-- ===========================================================================
create or replace function vizserve_pms_team_leaders_of(
  p_department_id uuid,
  p_exclude       uuid default null
)
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select md.user_id
    from vizserve_pms_user_managed_departments md
   where md.department_id = p_department_id
     and md.user_id is distinct from p_exclude
     and exists (
       select 1 from vizserve_pms_user_roles r
        where r.user_id = md.user_id and r.role = 'team_leader'
     )
     and vizserve_pms_account_is_live(md.user_id)
$$;

create or replace function vizserve_pms_managers(p_exclude uuid default null)
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select r.user_id
    from vizserve_pms_user_roles r
   where r.role = 'manager'
     and r.user_id is distinct from p_exclude
     and vizserve_pms_account_is_live(r.user_id)
$$;

-- The manager's own requests auto-approve whichever role they are acting as.
create or replace function vizserve_pms_skips_approval(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from vizserve_pms_user_roles r
     where r.user_id = p_user_id and r.role = 'manager'
  )
$$;


-- ===========================================================================
-- 2. AUTHORITY: in the pool (held) AND acting as that role (active).
-- ===========================================================================
create or replace function vizserve_pms_may_decide_internal_stage(
  p_entity_type text,
  p_entity_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_internal_requests r
     where p_entity_type = 'internal_request'
       and r.id = p_entity_id
       and r.status = 'PENDING_REVIEW'
       and (
         (r.approval_stage = 2
          and vizserve_pms_current_role() = 'team_leader'
          and auth.uid() in (select vizserve_pms_team_leaders_of(r.department_id, r.requester_id)))
         or
         (r.approval_stage = 3
          and vizserve_pms_current_role() = 'manager'
          and auth.uid() in (select vizserve_pms_managers(r.requester_id)))
       )
  );
$$;


-- ===========================================================================
-- 3. DECIDING — p14_04's body, with the two-signature rule removed and the
-- refusals naming the role to switch to.
-- ===========================================================================
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
  v_actor     uuid := auth.uid();
  v_reason    text := nullif(btrim(coalesce(p_reason, '')), '');
  v_rejected  boolean := (p_decision = 'rejected');
  v_row       vizserve_pms_internal_request_relievers;
  v_next      smallint;
  v_owed      integer;
  v_person    record;
  v_name      text;
  v_label     text;
begin
  if p_decision = 'returned' then
    raise exception 'Internal requests are approved or rejected, not returned.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_req from vizserve_pms_internal_requests where id = p_id for update;

  if v_req.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_req.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_req.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  if v_req.requester_id = v_actor then
    raise exception 'You cannot decide your own request.'
      using errcode = 'insufficient_privilege';
  end if;

  -- =========================================================================
  -- STAGE 3 — the manager. Authorised here; decided by the body at the bottom.
  -- =========================================================================
  if v_req.approval_stage = 3 then
    if not vizserve_pms_may_decide_internal_stage('internal_request', p_id) then
      raise exception '%',
        case when v_actor in (select vizserve_pms_managers(v_req.requester_id))
             then 'Switch to your Manager role in the top bar to approve this.'
             else 'This is waiting on the manager.'
        end
        using errcode = 'insufficient_privilege';
    end if;

    -- P14-07. No "two gates, two people" rule: somebody holding Team Leader and
    -- Manager signs the Team Leader step as Team Leader, switches, and signs
    -- the final step as Manager. That is what the role switcher is for.

  -- =========================================================================
  -- STAGES 1 AND 2 — advance or reject, and return from inside.
  -- =========================================================================
  elsif v_req.approval_stage in (1, 2) then
    v_before := to_jsonb(v_req);
    select u.full_name into v_name from vizserve_pms_users u where u.id = v_req.requester_id;

    if v_req.approval_stage = 1 then
      select * into v_row
        from vizserve_pms_internal_request_relievers
       where request_id = p_id and reliever_id = v_actor
       for update;

      if v_row.id is null then
        raise exception 'This is waiting on the relievers named on it.'
          using errcode = 'insufficient_privilege';
      end if;

      if v_row.decision is not null then
        raise exception 'You have already answered this.'
          using errcode = 'invalid_parameter_value';
      end if;

      if v_rejected and v_reason is null then
        raise exception 'Say why you cannot take this on — a refusal with no reason is unactionable.'
          using errcode = 'check_violation';
      end if;

      update vizserve_pms_internal_request_relievers
         set decision = p_decision, decided_at = now(), reason = v_reason
       where id = v_row.id;

      perform vizserve_pms_write_audit_log(
        'internal_request', p_id, 'reliever_' || p_decision::text, v_actor, null,
        jsonb_build_object('reliever_id', v_actor, 'decision', p_decision, 'reason', v_reason)
      );

      if not v_rejected then
        select count(*) into v_owed
          from vizserve_pms_internal_request_relievers
         where request_id = p_id and decision is null;

        if v_owed > 0 then
          return jsonb_build_object(
            'ok', true, 'status', v_req.status::text,
            'approval_stage', 1, 'stage_complete', false, 'dtr_entry_id', null
          );
        end if;
      end if;

      -- P14-04. The manager's own leave: the hand-over was the only thing
      -- anybody had to agree to, so it is approved now.
      if not v_rejected and vizserve_pms_skips_approval(v_req.requester_id) then
        perform vizserve_pms_auto_approve_internal(p_id);
        return jsonb_build_object(
          'ok', true, 'status', 'APPROVED',
          'approval_stage', 1, 'stage_complete', true, 'dtr_entry_id', null
        );
      end if;

      -- P14-04. A Team Leader's own leave skips their peers.
      v_next := vizserve_pms_first_lead_stage(v_req.department_id, v_req.requester_id);

    else
      if not vizserve_pms_may_decide_internal_stage('internal_request', p_id) then
        raise exception '%',
          case when v_actor in (select vizserve_pms_team_leaders_of(v_req.department_id, v_req.requester_id))
               then 'Switch to your Team Leader role in the top bar to approve this.'
               else 'This is waiting on a team leader of that department.'
          end
          using errcode = 'insufficient_privilege';
      end if;

      perform vizserve_pms_record_decision(
        'internal_request', p_id, v_req.department_id, p_decision, p_reason
      );

      v_next := 3;
    end if;

    if v_rejected then
      update vizserve_pms_internal_requests
         set status = 'REJECTED', decision_reason = v_reason,
             reviewed_by = v_actor, reviewed_at = now()
       where id = p_id;

      perform vizserve_pms_write_audit_log(
        'internal_request', p_id, 'rejected', v_actor, v_before,
        jsonb_build_object('status', 'REJECTED', 'reason', v_reason,
                           'rejected_at_stage', v_req.approval_stage)
      );

      perform vizserve_pms_notify(
        v_req.requester_id, 'internal_decision',
        replace(v_req.request_type::text, '_', ' ') || ' request rejected',
        coalesce(v_reason, ''), 'internal_request', p_id,
        '/approvals/' || p_id::text
      );

      return jsonb_build_object(
        'ok', true, 'status', 'REJECTED',
        'approval_stage', v_req.approval_stage, 'stage_complete', true,
        'dtr_entry_id', null
      );
    end if;

    update vizserve_pms_internal_requests
       set approval_stage = v_next
     where id = p_id;

    perform vizserve_pms_write_audit_log(
      'internal_request', p_id, 'stage_advanced', v_actor, v_before,
      jsonb_build_object('from_stage', v_req.approval_stage, 'to_stage', v_next)
    );

    v_label := initcap(replace(lower(v_req.request_type::text), '_', ' '));

    -- Whoever it waits on now — Team Leaders at 2, the Manager at 3.
    for v_person in
      select a as user_id from vizserve_pms_internal_stage_approvers(p_id) a
    loop
      perform vizserve_pms_notify(
        v_person.user_id, 'pending_approval',
        case when v_next = 2
             then v_label || ' request from ' || coalesce(v_name, 'a colleague')
             else v_label || ' for final approval: ' || coalesce(v_name, 'a colleague')
        end,
        case when v_req.approval_stage = 1
             then 'The relievers have accepted the hand-over.'
             else 'Approved by their team leader.'
        end,
        'internal_request', p_id, '/approvals/' || p_id::text
      );
    end loop;

    return jsonb_build_object(
      'ok', true, 'status', v_req.status::text,
      'approval_stage', v_next, 'stage_complete', true, 'dtr_entry_id', null
    );
  end if;

  -- =========================================================================
  -- THE FINAL DECISION — stage 3, and any legacy stage-0 row.
  -- =========================================================================

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

  -- P5-09 / P7-39 — the DTR write-back, shared with the auto-approval path.
  if v_status = 'APPROVED' then
    v_entry_id := vizserve_pms_apply_dtr_correction(p_id, auth.uid());
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


-- ===========================================================================
-- 4. TIMESHEETS — p14_04's body, plus "acting as Manager".
-- ===========================================================================
create or replace function vizserve_pms_decide_timesheet_week(
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
  v_week   vizserve_pms_timesheet_weeks;
  v_status vizserve_pms_timesheet_week_status;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if p_decision = 'rejected' then
    raise exception 'A week of work is approved or sent back to be fixed, not rejected.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The manager approves timesheets: somebody who holds the role AND is acting
  -- as it.
  if auth.uid() is null or auth.uid() not in (select vizserve_pms_managers()) then
    raise exception 'Timesheets are approved by the manager.'
      using errcode = 'insufficient_privilege';
  end if;

  if vizserve_pms_current_role() is distinct from 'manager' then
    raise exception 'Switch to your Manager role in the top bar to approve timesheets.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_week
    from vizserve_pms_timesheet_weeks
   where id = p_id
   for update;

  if v_week.id is null then
    raise exception 'That timesheet no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_week.status <> 'SUBMITTED' then
    raise exception 'That timesheet has already been decided.'
      using errcode = 'invalid_parameter_value';
  end if;

  if v_week.user_id = auth.uid() then
    raise exception 'You cannot approve your own timesheet.'
      using errcode = 'insufficient_privilege';
  end if;

  perform vizserve_pms_record_decision(
    'timesheet_week', p_id, v_week.department_id, p_decision, p_reason
  );

  v_status := case when p_decision = 'approved' then 'APPROVED' else 'RETURNED' end;

  update vizserve_pms_timesheet_weeks
     set status          = v_status,
         decision_reason = v_reason,
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_id;

  perform vizserve_pms_write_audit_log(
    'timesheet_week', p_id, lower(v_status::text), auth.uid(),
    to_jsonb(v_week), jsonb_build_object('status', v_status, 'reason', v_reason)
  );

  perform vizserve_pms_notify(
    v_week.user_id,
    'internal_decision',
    case when p_decision = 'approved'
         then 'Timesheet approved'
         else 'Timesheet sent back' end,
    coalesce(v_reason, 'Week of ' || to_char(v_week.week_start, 'DD Mon YYYY')),
    'timesheet_week',
    p_id,
    '/timesheet?week=' || v_week.week_start::text
  );

  return jsonb_build_object('ok', true, 'status', v_status);
end;
$$;
