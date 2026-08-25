-- import_03 — the 19 top-level tasks.
--
-- Third of six. See `20260825110000_import_01_vizbytes_folder.sql` for the shape
-- of the whole slice, the fixed-UUID scheme, and the D21 note.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, after 02.
--
-- THE 5 SUBTASKS ARE NOT HERE. They are file 04, on their own, so that the P7-09
-- one-level / same-department trigger is exercised and verified by itself rather
-- than buried in a 24-row insert that either works or does not.
--
-- WHY A DIRECT INSERT AND NOT `vizserve_pms_create_task`. Two reasons, either
-- one fatal to the RPC:
--
--   * it reads `auth.uid()` for `created_by` and for its scope check, and a
--     migration has no session user — `auth.uid()` is null here.
--   * it hard-codes `status = 'OPEN'`. Nine of these are finished or in progress
--     in ClickUp, and the state machine has no legal path that puts a task
--     straight into COMPLETED at birth. Replaying the history through
--     `vizserve_pms_transition_task` would mean inventing transitions, actors
--     and timestamps that never happened.
--
-- THE 4 COMPLETED TASKS HERE LAND WITH A NULL `resolution`, AND THAT IS
-- DELIBERATE. The resolution gate lives in `vizserve_pms_transition_task`
-- (P3-07), not in a constraint, so a direct insert is not stopped by it. ClickUp
-- has no field that corresponds to a resolution, and writing a plausible
-- sentence into a closed task is worse than leaving the truth — that nobody
-- recorded one — visible.
--
-- WHAT THE INSERT SETS BY OMISSION, and why each is right:
--
--   request_id      null    internal work, no client request behind it (P3-12)
--   is_personal     false   it belongs to the department, not to one person
--   field_values    '{}'    nothing to copy: there was no form
--   qa_assignee_id  null    ClickUp has no column meaning "second pair of eyes"
--   description     ''      all 24 rows have an empty `Task Content`
--   resolution      null    see above
--
-- `created_by` is Ace, so the row the P3-02 `record_creation` trigger writes into
-- `vizserve_pms_task_status_history` carries a real actor instead of null. Every
-- one of those rows will read `null -> <status>`, which is honest: these tasks
-- were born into the state ClickUp left them in.

do $$
declare
  v_dept constant uuid := 'a1000000-0000-4000-8000-000000000001';  -- VizBytes
  v_list constant uuid := 'b2000000-0000-4000-8000-000000000001';  -- the list, from 02
  v_pic      uuid;
  v_inserted integer;
begin
  select id into v_pic
    from vizserve_pms_users
   where email = 'ace.guevarra@vizserve.hfse.edu.sg' and is_active;

  if v_pic is null then
    raise notice 'import_03 SKIPPED — no active profile for ace.guevarra@vizserve.hfse.edu.sg.';
    return;
  end if;

  if not exists (
    select 1 from vizserve_pms_lists where id = v_list and department_id = v_dept
  ) then
    raise exception 'import_03: the Project Management System Portal list is missing. Apply import_02 first.'
      using errcode = 'no_data_found';
  end if;

  -- `on conflict (id) do nothing` on FIXED ids is what makes a re-run a no-op
  -- rather than a second copy of the list. There is no natural key on this table
  -- to conflict against — two tasks may legitimately share a title — so the id
  -- is the handle, and that is the whole reason these UUIDs are written down
  -- rather than generated.
  insert into vizserve_pms_tasks
    (id, department_id, list_id, title, description, status,
     assignee_id, due_date, start_date, priority, created_by)
  select
    v.id, v_dept, v_list, v.title, '', v.status::vizserve_pms_task_status,
    v_pic, v.due_date, v.start_date, v.priority::vizserve_pms_task_priority, v_pic
  from (values
    ('c1000000-0000-4000-8000-000000000001'::uuid, 'Create Project Timeline',                         'COMPLETED', '2026-07-24'::date, '2026-07-20'::date, null),
    ('c1000000-0000-4000-8000-000000000002'::uuid, 'Workflow & Data Model Design',                    'COMPLETED', '2026-07-24'::date, null::date,         null),
    ('c1000000-0000-4000-8000-000000000003'::uuid, 'Kick Off',                                        'COMPLETED', '2026-07-22'::date, null::date,         null),
    ('c1000000-0000-4000-8000-000000000004'::uuid, 'Meeting',                                         'COMPLETED', '2026-08-05'::date, null::date,         null),
    ('c1000000-0000-4000-8000-000000000005'::uuid, 'UI/UX Design & Branding',                         'ONGOING',   '2026-08-21'::date, '2026-07-27'::date, null),
    ('c1000000-0000-4000-8000-000000000006'::uuid, 'Database Setup and Configuration',                'ONGOING',   '2026-08-21'::date, '2026-08-10'::date, null),
    ('c1000000-0000-4000-8000-000000000007'::uuid, 'Authentication & User Management',                'ONGOING',   '2026-08-21'::date, '2026-08-10'::date, null),
    ('c1000000-0000-4000-8000-000000000008'::uuid, 'Approval Request System with PMS and Attendance', 'ONGOING',   '2026-10-09'::date, '2026-07-28'::date, 'NORMAL'),
    ('c1000000-0000-4000-8000-000000000009'::uuid, 'Email & Domain Configuration',                    'OPEN',      null::date,         null::date,         null),
    ('c1000000-0000-4000-8000-000000000010'::uuid, 'Timesheet & Reporting Module',                    'OPEN',      '2026-09-18'::date, '2026-09-07'::date, null),
    ('c1000000-0000-4000-8000-000000000011'::uuid, 'Internal Approvals Module',                       'OPEN',      '2026-09-11'::date, '2026-08-31'::date, null),
    ('c1000000-0000-4000-8000-000000000012'::uuid, 'Deployment of Live Environment',                  'OPEN',      '2026-09-18'::date, '2026-09-14'::date, null),
    ('c1000000-0000-4000-8000-000000000013'::uuid, 'ClickUp Data Migration',                          'OPEN',      '2026-10-09'::date, '2026-09-28'::date, null),
    ('c1000000-0000-4000-8000-000000000014'::uuid, 'Testing and Bug Fixing',                          'OPEN',      null::date,         null::date,         null),
    ('c1000000-0000-4000-8000-000000000015'::uuid, 'Client Request Forms Module',                     'OPEN',      '2026-08-21'::date, '2026-08-10'::date, null),
    ('c1000000-0000-4000-8000-000000000016'::uuid, 'Approval Engine & Team Leader Review',            'OPEN',      '2026-08-28'::date, '2026-08-17'::date, null),
    ('c1000000-0000-4000-8000-000000000017'::uuid, 'DTR Module',                                      'OPEN',      '2026-09-04'::date, '2026-08-24'::date, null),
    ('c1000000-0000-4000-8000-000000000018'::uuid, 'Client Approval & Feedback Module',               'OPEN',      '2026-09-04'::date, '2026-08-24'::date, null),
    ('c1000000-0000-4000-8000-000000000019'::uuid, 'Task Management & QA Module',                     'OPEN',      '2026-09-04'::date, '2026-08-24'::date, null)
  ) as v (id, title, status, due_date, start_date, priority)
  on conflict (id) do nothing;

  get diagnostics v_inserted = row_count;
  raise notice 'import_03 — % of 19 top-level tasks inserted (0 on a re-run).', v_inserted;
end $$;
