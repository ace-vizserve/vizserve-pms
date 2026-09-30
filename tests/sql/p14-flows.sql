-- P14 — APPROVAL ROUTING, ROLE SWITCHER AND NOTIFICATION FLOWS, TESTED ON THE
-- LIVE DATABASE WITHOUT LEAVING A TRACE.
--
-- Paste into the Supabase SQL editor and run. It acts as real people (by
-- setting the JWT claims auth.uid() reads), runs each flow through the real
-- functions, checks every result — and then RAISES AN ERROR ON PURPOSE. The
-- error message is the report, and raising it rolls back EVERYTHING the test
-- did: no request, approval, notification or audit row survives, so nothing is
-- emailed either (the outbox only ever sees committed rows).
--
-- Read the result as: the red error box lists every check, ✅ or ❌.
-- If it fails for any OTHER reason (a real bug), the message says what broke —
-- and it is still rolled back.
--
-- People (as configured 30 Sep 2026):
--   Kurt Arciga        member, VizBytes
--   Amier Ordonez      Team Leader of VizBytes (+ Business Manager), acting as TL
--   Joel Castro        Manager + Team Leader of VizAssists, acting as Manager
--   Alicia Layo        member, VizAssists
--   Nina Cacananta     CEO
--   Raiza Mondina      member, VizBytes (QA on the client task, and the reliever)

do $$
declare
  v_kurt   uuid;
  v_amier  uuid;
  v_joel   uuid;
  v_alicia uuid;
  v_nina   uuid;
  v_out    text[] := '{}';
  v_req    uuid;
  v_week   uuid;
  v_dept   uuid;
  v_stage  smallint;
  v_status text;
  v_count  integer;
  v_flag   boolean;
  v_yday   date := (now() at time zone 'Asia/Manila')::date - 1;
  v_raiza  uuid;
  v_res    jsonb;
  v_slug   text;
  v_form   uuid;
  v_list   uuid;
  v_request uuid;
  v_task   uuid;
  v_leave_type uuid;
  v_handover uuid;
  v_leave  uuid;
  v_token  text;
  v_before_kurt  integer;
  v_before_raiza integer;
  v_before_amier integer;
begin
  select id into v_kurt   from vizserve_pms_users where full_name = 'Kurt Arciga';
  select id into v_amier  from vizserve_pms_users where full_name = 'Amier Ordonez';
  select id into v_joel   from vizserve_pms_users where full_name = 'Joel Castro';
  select id into v_alicia from vizserve_pms_users where full_name = 'Alicia Layo';
  select id into v_nina   from vizserve_pms_users where full_name = 'Nina Cacananta';
  select id into v_raiza  from vizserve_pms_users where full_name = 'Raiza Mondina';

  if v_kurt is null or v_amier is null or v_joel is null or v_alicia is null or v_nina is null or v_raiza is null then
    raise exception 'Could not find one of the test people by name — check the names at the top of this script.';
  end if;

  -- Known starting roles for the run (all rolled back at the end).
  update vizserve_pms_users set role = 'team_leader' where id = v_amier;
  update vizserve_pms_users set role = 'manager' where id = v_joel;

  -- =========================================================================
  -- 1. OVERTIME: member → Team Leader → Manager
  -- =========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
  v_req := (vizserve_pms_submit_internal_request(
              p_request_type => 'OVERTIME', p_reason => 'P14 flow test',
              p_work_date => v_yday, p_overtime_minutes => 60) ->> 'id')::uuid;

  select approval_stage, status into v_stage, v_status from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Kurt''s overtime starts at the Team Leader step (stage %s)',
                           case when v_stage = 2 then '✅' else '❌' end, v_stage);

  select count(*) into v_count from vizserve_pms_notifications where entity_id = v_req and user_id = v_amier;
  v_out := v_out || format('%s Amier (Team Leader) is notified', case when v_count > 0 then '✅' else '❌' end);

  select count(*) into v_count from vizserve_pms_notifications where entity_id = v_req and user_id = v_joel;
  v_out := v_out || format('%s Joel (Manager) is NOT notified yet', case when v_count = 0 then '✅' else '❌' end);

  -- Manager tries the Team Leader step
  perform set_config('request.jwt.claims', json_build_object('sub', v_joel, 'role', 'authenticated')::text, true);
  begin
    perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
    v_out := v_out || text '❌ Joel (Manager) was allowed to approve the Team Leader step';
  exception when others then
    v_out := v_out || format('✅ Joel (Manager) refused at the Team Leader step — "%s"', sqlerrm);
  end;

  -- Team Leader approves
  perform set_config('request.jwt.claims', json_build_object('sub', v_amier, 'role', 'authenticated')::text, true);
  perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
  select approval_stage into v_stage from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Amier approves → moves to the Manager step (stage %s)',
                           case when v_stage = 3 then '✅' else '❌' end, v_stage);

  select count(*) into v_count from vizserve_pms_notifications where entity_id = v_req and user_id = v_joel;
  v_out := v_out || format('%s Joel (Manager) is now notified', case when v_count > 0 then '✅' else '❌' end);

  -- Team Leader and CEO try the Manager step
  begin
    perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
    v_out := v_out || text '❌ Amier (Team Leader) was allowed to approve the Manager step';
  exception when others then
    v_out := v_out || text '✅ Amier (Team Leader) refused at the Manager step';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_nina, 'role', 'authenticated')::text, true);
  begin
    perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
    v_out := v_out || text '❌ Nina (CEO) was allowed to approve';
  exception when others then
    v_out := v_out || text '✅ Nina (CEO) refused — CEO approves nothing';
  end;

  -- Manager approves
  perform set_config('request.jwt.claims', json_build_object('sub', v_joel, 'role', 'authenticated')::text, true);
  perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
  select status into v_status from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Joel approves → %s', case when v_status = 'APPROVED' then '✅' else '❌' end, v_status);

  select count(*) into v_count from vizserve_pms_notifications
   where entity_id = v_req and user_id = v_kurt and in_app;
  v_out := v_out || format('%s Kurt is told it was approved', case when v_count > 0 then '✅' else '❌' end);

  select bool_and(in_app and not send_email) into v_flag from vizserve_pms_notifications
   where entity_id = v_req and user_id = v_nina;
  v_out := v_out || format('%s Nina (CEO) is told in the app, not by email', case when v_flag then '✅' else '❌' end);

  -- =========================================================================
  -- 2. SPECIAL CASES
  -- =========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_amier, 'role', 'authenticated')::text, true);
  v_req := (vizserve_pms_submit_internal_request(
              p_request_type => 'OVERTIME', p_reason => 'P14 flow test',
              p_work_date => v_yday, p_overtime_minutes => 60) ->> 'id')::uuid;
  select approval_stage into v_stage from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Amier''s own overtime skips straight to the Manager (stage %s)',
                           case when v_stage = 3 then '✅' else '❌' end, v_stage);

  perform set_config('request.jwt.claims', json_build_object('sub', v_joel, 'role', 'authenticated')::text, true);
  v_req := (vizserve_pms_submit_internal_request(
              p_request_type => 'OVERTIME', p_reason => 'P14 flow test',
              p_work_date => v_yday, p_overtime_minutes => 60) ->> 'id')::uuid;
  select status into v_status from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Joel''s own overtime auto-approves (%s)',
                           case when v_status = 'APPROVED' then '✅' else '❌' end, v_status);

  perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
  v_req := (vizserve_pms_submit_internal_request(
              p_request_type => 'OVERTIME', p_reason => 'P14 flow test',
              p_work_date => v_yday, p_overtime_minutes => 60) ->> 'id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', v_amier, 'role', 'authenticated')::text, true);
  perform vizserve_pms_decide_internal_request(v_req, 'rejected', 'Not needed — test');
  select status into v_status from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s A Team Leader rejection ends it (%s)',
                           case when v_status = 'REJECTED' then '✅' else '❌' end, v_status);

  -- =========================================================================
  -- 3. TIMESHEETS → the Manager
  -- =========================================================================
  select primary_department_id into v_dept from vizserve_pms_users where id = v_kurt;
  insert into vizserve_pms_timesheet_weeks (user_id, week_start, department_id, status, submitted_minutes)
  values (v_kurt, date '2020-01-06', v_dept, 'SUBMITTED', 2400)
  returning id into v_week;

  perform set_config('request.jwt.claims', json_build_object('sub', v_amier, 'role', 'authenticated')::text, true);
  begin
    perform vizserve_pms_decide_timesheet_week(v_week, 'approved', null);
    v_out := v_out || text '❌ Amier (Team Leader) was allowed to approve a timesheet';
  exception when others then
    v_out := v_out || text '✅ Amier (Team Leader) refused on timesheets';
  end;

  perform set_config('request.jwt.claims', json_build_object('sub', v_joel, 'role', 'authenticated')::text, true);
  perform vizserve_pms_decide_timesheet_week(v_week, 'approved', null);
  select status into v_status from vizserve_pms_timesheet_weeks where id = v_week;
  v_out := v_out || format('%s Joel (Manager) approves the timesheet (%s)',
                           case when v_status = 'APPROVED' then '✅' else '❌' end, v_status);

  -- =========================================================================
  -- 4. ONE PERSON, TWO ROLES: Joel as Team Leader of VizAssists, then Manager
  -- =========================================================================
  update vizserve_pms_users set role = 'team_leader' where id = v_joel;

  perform set_config('request.jwt.claims', json_build_object('sub', v_alicia, 'role', 'authenticated')::text, true);
  v_req := (vizserve_pms_submit_internal_request(
              p_request_type => 'OVERTIME', p_reason => 'P14 flow test',
              p_work_date => v_yday, p_overtime_minutes => 60) ->> 'id')::uuid;
  select approval_stage into v_stage from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Alicia''s overtime starts at the Team Leader step (stage %s)',
                           case when v_stage = 2 then '✅' else '❌' end, v_stage);

  perform set_config('request.jwt.claims', json_build_object('sub', v_joel, 'role', 'authenticated')::text, true);
  perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
  select approval_stage into v_stage from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Joel, acting as Team Leader, approves step 1 (now stage %s)',
                           case when v_stage = 3 then '✅' else '❌' end, v_stage);

  select coalesce(max(pending), 0) into v_count from vizserve_pms_pending_by_role() where role = 'manager';
  v_out := v_out || format('%s The top-bar notice counts %s item(s) waiting for Joel as Manager',
                           case when v_count >= 1 then '✅' else '❌' end, v_count);

  begin
    perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
    v_out := v_out || text '❌ Joel approved the Manager step while acting as Team Leader';
  exception when others then
    v_out := v_out || format('%s Joel is told to switch — "%s"',
                             case when sqlerrm ilike '%switch to your manager role%' then '✅' else '❌' end, sqlerrm);
  end;

  perform vizserve_pms_switch_role('manager');
  perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
  select status into v_status from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Joel switches to Manager and approves → %s',
                           case when v_status = 'APPROVED' then '✅' else '❌' end, v_status);

  -- =========================================================================
  -- 5. THE SWITCHER REFUSES A ROLE YOU DO NOT HOLD
  -- =========================================================================
  perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
  begin
    perform vizserve_pms_switch_role('manager');
    v_out := v_out || text '❌ Kurt switched to a role he does not hold';
  exception when others then
    v_out := v_out || text '✅ Kurt cannot switch to a role he does not hold';
  end;

  -- =========================================================================
  -- 6. CLIENT REQUEST: submit → Gate 1 → PIC / QA → QA sends back
  -- =========================================================================
  select primary_department_id into v_dept from vizserve_pms_users where id = v_kurt;

  -- A throwaway public client form for VizBytes, created here and rolled back
  -- with everything else — so the test never depends on which forms exist.
  select l.id into v_list from vizserve_pms_lists l where l.department_id = v_dept limit 1;
  v_slug := 'p14-flow-test-' || substr(md5(random()::text), 1, 8);
  insert into vizserve_pms_forms
    (name, slug, reference_prefix, department_id, purpose, is_public, is_active, default_list_id)
  values
    ('P14 flow test form', v_slug, 'PQ' || upper(substr(md5(random()::text), 1, 5)),
     v_dept, 'CLIENT_REQUEST', true, true, v_list)
  returning id into v_form;

  if v_form is null or v_list is null then
    v_out := v_out || text '⚠️ Skipped client request: VizBytes has no list for the task to go under';
  else
    -- The client: no session at all.
    perform set_config('request.jwt.claims', '', true);
    v_res := vizserve_pms_submit_request(
      v_slug,
      jsonb_build_object(
        'requester_name', 'P14 Test Client',
        'requester_email', 'p14.test@example.com',
        'title', 'P14 flow test request',
        'description', 'Rolled back.',
        'target_date', (current_date + 30)::text,
        'field_values', '{}'::jsonb
      ),
      '[]'::jsonb,
      '10.99.14.1'
    );
    v_request := (v_res ->> 'request_id')::uuid;
    v_out := v_out || format('%s Client request submitted (%s)',
                             case when v_request is not null then '✅' else '❌' end, coalesce(v_res::text, 'null'));

    if v_request is not null then
      select count(*) into v_count from vizserve_pms_notifications where entity_id = v_request and user_id = v_amier;
      v_out := v_out || format('%s Amier (Team Leader) is told about the new client request',
                               case when v_count > 0 then '✅' else '❌' end);

      -- Gate 1: Amier approves, Kurt is PIC, Raiza is QA.
      perform set_config('request.jwt.claims', json_build_object('sub', v_amier, 'role', 'authenticated')::text, true);
      v_res := vizserve_pms_approve_request(v_request, v_kurt, v_raiza, null, null, null, v_list, null);
      v_task := (v_res ->> 'task_id')::uuid;
      v_out := v_out || format('%s Gate 1 approved → task created', case when v_task is not null then '✅' else '❌' end);

      select count(*) into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_kurt;
      v_out := v_out || format('%s Kurt is told he is the PIC', case when v_count > 0 then '✅' else '❌' end);
      select count(*) into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_raiza;
      v_out := v_out || format('%s Raiza is told she is QA', case when v_count > 0 then '✅' else '❌' end);

      -- PIC works it and hands it to QA.
      perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
      perform vizserve_pms_transition_task(v_task, 'ONGOING', null);
      update vizserve_pms_tasks set resolution = 'Done for the P14 test.' where id = v_task;
      select count(*) into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_raiza;
      perform vizserve_pms_transition_task(v_task, 'FOR_QA', null);
      select count(*) - v_count into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_raiza;
      v_out := v_out || format('%s Kurt sends it to QA → Raiza is told it is ready', case when v_count > 0 then '✅' else '❌' end);

      -- QA picks it up and sends it back.
      perform set_config('request.jwt.claims', json_build_object('sub', v_raiza, 'role', 'authenticated')::text, true);
      perform vizserve_pms_transition_task(v_task, 'QA_IN_PROGRESS', null);
      select count(*) into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_kurt;
      perform vizserve_pms_transition_task(v_task, 'ONGOING', 'Please fix the heading — P14 test.');
      select count(*) - v_count into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_kurt;
      v_out := v_out || format('%s Raiza sends it back → Kurt is told', case when v_count > 0 then '✅' else '❌' end);

      select status::text into v_status from vizserve_pms_tasks where id = v_task;
      v_out := v_out || format('%s The task is back with the PIC (%s)',
                               case when v_status = 'ONGOING' then '✅' else '❌' end, v_status);

      -- ---------------------------------------------------------------------
      -- GATE 3 — the client's own decision, through a real one-time token.
      -- ---------------------------------------------------------------------
      -- Round 1: fixed, back through QA, sent to the client, who asks for changes.
      perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
      perform vizserve_pms_transition_task(v_task, 'FOR_QA', null);
      perform set_config('request.jwt.claims', json_build_object('sub', v_raiza, 'role', 'authenticated')::text, true);
      perform vizserve_pms_transition_task(v_task, 'QA_IN_PROGRESS', null);
      perform vizserve_pms_transition_task(v_task, 'FOR_CLIENT_APPROVAL', null);
      select status::text into v_status from vizserve_pms_tasks where id = v_task;
      v_out := v_out || format('%s QA passes it → sent to the client (%s)',
                               case when v_status = 'FOR_CLIENT_APPROVAL' then '✅' else '❌' end, v_status);

      v_token := vizserve_pms_issue_approval_token(v_task, 'approval') ->> 'token';
      perform set_config('request.jwt.claims', '', true); -- the client has no session
      select count(*) into v_before_kurt from vizserve_pms_notifications where entity_id = v_task and user_id = v_kurt;
      select count(*) into v_before_raiza from vizserve_pms_notifications where entity_id = v_task and user_id = v_raiza;

      v_res := vizserve_pms_record_client_decision(v_token, 'REVISION_REQUESTED', 'Please change the colour — P14 test.', 'P14 Test Client');
      select status::text into v_status from vizserve_pms_tasks where id = v_task;
      v_out := v_out || format('%s Client asks for changes → back to the PIC (%s)',
                               case when (v_res ->> 'ok')::boolean and v_status = 'ONGOING' then '✅' else '❌' end,
                               coalesce(v_status, v_res::text));

      select count(*) - v_before_kurt into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_kurt;
      v_out := v_out || format('%s Kurt (PIC) is told the client wants changes', case when v_count > 0 then '✅' else '❌' end);
      select count(*) - v_before_raiza into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_raiza;
      v_out := v_out || format('%s Raiza (QA) is NOT told about the changes', case when v_count = 0 then '✅' else '❌' end);

      v_res := vizserve_pms_record_client_decision(v_token, 'APPROVED', null, 'P14 Test Client');
      v_out := v_out || format('%s The same link cannot be used twice (%s)',
                               case when v_res ->> 'error' = 'already_used' then '✅' else '❌' end, v_res ->> 'error');

      -- Round 2: through QA again, sent to the client, who approves.
      perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
      perform vizserve_pms_transition_task(v_task, 'FOR_QA', null);
      perform set_config('request.jwt.claims', json_build_object('sub', v_raiza, 'role', 'authenticated')::text, true);
      perform vizserve_pms_transition_task(v_task, 'QA_IN_PROGRESS', null);
      perform vizserve_pms_transition_task(v_task, 'FOR_CLIENT_APPROVAL', null);

      v_token := vizserve_pms_issue_approval_token(v_task, 'approval') ->> 'token';
      perform set_config('request.jwt.claims', '', true);
      select count(*) into v_before_kurt from vizserve_pms_notifications where entity_id = v_task and user_id = v_kurt;
      select count(*) into v_before_raiza from vizserve_pms_notifications where entity_id = v_task and user_id = v_raiza;
      select count(*) into v_before_amier from vizserve_pms_notifications where entity_id = v_task and user_id = v_amier;

      v_res := vizserve_pms_record_client_decision(v_token, 'APPROVED', null, 'P14 Test Client');
      select status::text into v_status from vizserve_pms_tasks where id = v_task;
      v_out := v_out || format('%s Client approves → task COMPLETED (%s)',
                               case when (v_res ->> 'ok')::boolean and v_status = 'COMPLETED' then '✅' else '❌' end,
                               coalesce(v_status, v_res::text));

      select count(*) - v_before_kurt into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_kurt;
      v_out := v_out || format('%s Kurt (PIC) is told the client approved', case when v_count > 0 then '✅' else '❌' end);
      select count(*) - v_before_raiza into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_raiza;
      v_out := v_out || format('%s Raiza (QA) is told', case when v_count > 0 then '✅' else '❌' end);
      select count(*) - v_before_amier into v_count from vizserve_pms_notifications where entity_id = v_task and user_id = v_amier;
      v_out := v_out || format('%s Amier (Team Leader) is told', case when v_count > 0 then '✅' else '❌' end);

      select bool_and(in_app and not send_email) into v_flag from vizserve_pms_notifications
       where entity_id = v_task and user_id = v_nina;
      v_out := v_out || format('%s Nina (CEO) hears the request is complete, in the app only',
                               case when v_flag then '✅' else '❌' end);

      select bool_or(send_email) into v_flag from vizserve_pms_notifications
       where entity_id = v_task and user_id = v_kurt and title like 'Client approved%';
      v_out := v_out || format('%s Kurt''s "client approved" notice is marked to email',
                               case when v_flag then '✅' else '❌' end);
    end if;
  end if;

  -- =========================================================================
  -- 7. LEAVE WITH RELIEVERS: relievers → Team Leader → Manager
  -- =========================================================================
  select lt.id into v_leave_type
    from vizserve_pms_leave_types lt
    join vizserve_pms_users u on u.id = v_kurt
   where lt.is_active and lt.requires_reliever
     and (lt.applies_to_gender is null or lt.applies_to_gender = u.gender)
   limit 1;

  -- A task Kurt is on that is still open, to hand over. (The client test task
  -- above is completed by now, and a finished task needs no reliever.)
  select t.id into v_handover
    from vizserve_pms_tasks t
   where vizserve_pms_is_on_task(t.id, v_kurt)
     and t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
   limit 1;

  if v_leave_type is null or v_handover is null then
    v_out := v_out || text '⚠️ Skipped leave with relievers: no reliever leave type or no open task for Kurt';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
    v_leave := (vizserve_pms_submit_internal_request(
                  p_request_type => 'LEAVE', p_reason => 'P14 flow test',
                  p_start_date => current_date + 60, p_end_date => current_date + 60,
                  p_leave_type_id => v_leave_type,
                  p_relievers => jsonb_build_array(jsonb_build_object(
                    'reliever_id', v_raiza, 'task_ids', jsonb_build_array(v_handover))),
                  p_turnover_confirmed => true) ->> 'id')::uuid;

    select approval_stage into v_stage from vizserve_pms_internal_requests where id = v_leave;
    v_out := v_out || format('%s Kurt''s leave starts with the reliever (stage %s)',
                             case when v_stage = 1 then '✅' else '❌' end, v_stage);

    select count(*) into v_count from vizserve_pms_notifications where entity_id = v_leave and user_id = v_raiza;
    v_out := v_out || format('%s Raiza is asked to cover', case when v_count > 0 then '✅' else '❌' end);
    select count(*) into v_count from vizserve_pms_notifications where entity_id = v_leave and user_id = v_amier;
    v_out := v_out || format('%s Amier is NOT told yet', case when v_count = 0 then '✅' else '❌' end);

    perform set_config('request.jwt.claims', json_build_object('sub', v_amier, 'role', 'authenticated')::text, true);
    begin
      perform vizserve_pms_decide_internal_request(v_leave, 'approved', null);
      v_out := v_out || text '❌ Amier approved before the reliever answered';
    exception when others then
      v_out := v_out || text '✅ Amier cannot approve while the reliever has not answered';
    end;

    perform set_config('request.jwt.claims', json_build_object('sub', v_raiza, 'role', 'authenticated')::text, true);
    perform vizserve_pms_decide_internal_request(v_leave, 'approved', null);
    select approval_stage into v_stage from vizserve_pms_internal_requests where id = v_leave;
    v_out := v_out || format('%s Raiza accepts → Team Leader step (stage %s)',
                             case when v_stage = 2 then '✅' else '❌' end, v_stage);

    perform set_config('request.jwt.claims', json_build_object('sub', v_amier, 'role', 'authenticated')::text, true);
    perform vizserve_pms_decide_internal_request(v_leave, 'approved', null);
    perform set_config('request.jwt.claims', json_build_object('sub', v_joel, 'role', 'authenticated')::text, true);
    perform vizserve_pms_decide_internal_request(v_leave, 'approved', null);
    select status::text into v_status from vizserve_pms_internal_requests where id = v_leave;
    v_out := v_out || format('%s Amier then Joel approve → %s',
                             case when v_status = 'APPROVED' then '✅' else '❌' end, v_status);
  end if;

  -- =========================================================================
  -- 8. WITHDRAWING
  -- =========================================================================
  -- (a) Before anybody signed: withdrawn, and the Team Leader is told.
  perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
  v_req := (vizserve_pms_submit_internal_request(
              p_request_type => 'OVERTIME', p_reason => 'P14 flow test',
              p_work_date => v_yday, p_overtime_minutes => 60) ->> 'id')::uuid;
  select count(*) into v_count from vizserve_pms_notifications where entity_id = v_req and user_id = v_amier;
  perform vizserve_pms_withdraw_internal_request(v_req, null);
  select status::text into v_status from vizserve_pms_internal_requests where id = v_req;
  v_out := v_out || format('%s Kurt withdraws an unsigned request → %s',
                           case when v_status = 'WITHDRAWN' then '✅' else '❌' end, v_status);
  select count(*) - v_count into v_count from vizserve_pms_notifications where entity_id = v_req and user_id = v_amier;
  v_out := v_out || format('%s Amier is told it was withdrawn', case when v_count > 0 then '✅' else '❌' end);

  -- (b) Overtime someone has signed cannot be withdrawn.
  v_req := (vizserve_pms_submit_internal_request(
              p_request_type => 'OVERTIME', p_reason => 'P14 flow test',
              p_work_date => v_yday, p_overtime_minutes => 60) ->> 'id')::uuid;
  perform set_config('request.jwt.claims', json_build_object('sub', v_amier, 'role', 'authenticated')::text, true);
  perform vizserve_pms_decide_internal_request(v_req, 'approved', null);
  perform set_config('request.jwt.claims', json_build_object('sub', v_kurt, 'role', 'authenticated')::text, true);
  begin
    perform vizserve_pms_withdraw_internal_request(v_req, null);
    v_out := v_out || text '❌ Kurt withdrew overtime his Team Leader had already signed';
  exception when others then
    v_out := v_out || text '✅ Signed overtime cannot be withdrawn';
  end;

  -- (c) Approved future leave: needs a note, then withdraws and tells the signers.
  if v_leave is not null then
    begin
      perform vizserve_pms_withdraw_internal_request(v_leave, null);
      v_out := v_out || text '❌ Approved leave was withdrawn without a note';
    exception when others then
      v_out := v_out || text '✅ Approved leave needs a note to withdraw';
    end;

    select count(*) into v_count from vizserve_pms_notifications where entity_id = v_leave and user_id = v_joel;
    perform vizserve_pms_withdraw_internal_request(v_leave, '<p>Plans changed — P14 test.</p>');
    select status::text into v_status from vizserve_pms_internal_requests where id = v_leave;
    v_out := v_out || format('%s With a note it is withdrawn → %s',
                             case when v_status = 'WITHDRAWN' then '✅' else '❌' end, v_status);
    select count(*) - v_count into v_count from vizserve_pms_notifications where entity_id = v_leave and user_id = v_joel;
    v_out := v_out || format('%s Joel, who signed it, is told', case when v_count > 0 then '✅' else '❌' end);
  end if;

  -- =========================================================================
  -- THE REPORT — and the rollback.
  -- =========================================================================
  raise exception using
    message = E'P14 FLOW TEST — nothing was saved, everything below was rolled back.\n\n'
              || array_to_string(v_out, E'\n')
              || format(E'\n\n%s of %s checks passed.',
                        (select count(*) from unnest(v_out) line where line like '✅%'),
                        (select count(*) from unnest(v_out) line where line not like '⚠️%'));
end;
$$;
