-- import_04 — the 5 subtasks.
--
-- Fourth of six. See `20260825110000_import_01_vizbytes_folder.sql` for the
-- shape of the whole slice, the fixed-UUID scheme, and the D21 note.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, after 03.
--
-- All five hang off ONE parent — `Approval Request System with PMS and
-- Attendance`, `c1000000-…-000000000008` from file 03. This is the file that
-- exists to prove the subtask half of the mapping, which is why it is separate
-- from the 19: applying it runs `vizserve_pms_check_subtask_parent` (P7-09) five
-- times, and that trigger enforces the two rules a CHECK constraint cannot,
-- because both read another row:
--
--   * ONE LEVEL — the parent must not itself have a parent. Nothing in ClickUp
--     stops a deeper tree, so this is the assertion that ClickUp's shape and
--     this schema's shape actually agree for this slice. They do: every one of
--     the 24 rows has either no `Parent ID` or points at …008, which has none.
--   * SAME DEPARTMENT — scope resolves through `department_id`, so a subtask
--     elsewhere would be visible to a different set of people than its parent.
--
-- A DISCREPANCY IN THE EXPORT, resolved in favour of `Parent ID`. The parent's
-- `Subtasks IDs` column lists only four children (86d3vpzz5, 86d3uyzha,
-- 86d3uyzhv, 86d3uyzkd) and omits `Clean the database and Auth` (86d3uyywt) —
-- but that row's own `Parent ID` points squarely at 86d3uu5cv. A child knows its
-- parent more reliably than a parent knows its children, and the count that
-- matters downstream is the one on the child. So five, not four.
--
-- Statuses, dates, priority and every omitted column follow file 03 exactly;
-- the reasoning there applies unchanged. Note that `Clean the database and Auth`
-- is the one URGENT row in the slice, and the fifth COMPLETED — which is why the
-- totals only reach 5 COMPLETED / 5 ONGOING / 14 OPEN once this file lands.

do $$
declare
  v_dept   constant uuid := 'a1000000-0000-4000-8000-000000000001';  -- VizBytes
  v_list   constant uuid := 'b2000000-0000-4000-8000-000000000001';  -- the list, from 02
  v_parent constant uuid := 'c1000000-0000-4000-8000-000000000008';  -- from 03
  v_pic      uuid;
  v_inserted integer;
begin
  select id into v_pic
    from vizserve_pms_users
   where email = 'ace.guevarra@vizserve.hfse.edu.sg' and is_active;

  if v_pic is null then
    raise notice 'import_04 SKIPPED — no active profile for ace.guevarra@vizserve.hfse.edu.sg.';
    return;
  end if;

  -- Checked here rather than left to the trigger so the failure names the cause.
  -- The trigger's own message ('That parent task does not exist') is correct but
  -- would not say WHICH file was skipped.
  if not exists (
    select 1 from vizserve_pms_tasks
     where id = v_parent and department_id = v_dept and parent_task_id is null
  ) then
    raise exception 'import_04: parent task % is missing, in the wrong department, or is itself a subtask. Apply import_03 first.',
      v_parent
      using errcode = 'no_data_found';
  end if;

  insert into vizserve_pms_tasks
    (id, department_id, list_id, parent_task_id, title, description, status,
     assignee_id, due_date, start_date, priority, created_by)
  select
    v.id, v_dept, v_list, v_parent, v.title, '', v.status::vizserve_pms_task_status,
    v_pic, v.due_date, v.start_date, v.priority::vizserve_pms_task_priority, v_pic
  from (values
    ('c1000000-0000-4000-8000-000000000020'::uuid, 'Clean the database and Auth', 'COMPLETED', '2026-07-30'::date, '2026-07-28'::date, 'URGENT'),
    ('c1000000-0000-4000-8000-000000000021'::uuid, 'Mockup',                      'ONGOING',   '2026-08-03'::date, null::date,         null),
    ('c1000000-0000-4000-8000-000000000022'::uuid, 'Approval',                    'OPEN',      '2026-08-14'::date, null::date,         null),
    ('c1000000-0000-4000-8000-000000000023'::uuid, 'Attendance',                  'OPEN',      '2026-09-04'::date, null::date,         null),
    ('c1000000-0000-4000-8000-000000000024'::uuid, 'PMS (Click Up)',              'OPEN',      '2026-08-28'::date, null::date,         null)
  ) as v (id, title, status, due_date, start_date, priority)
  on conflict (id) do nothing;

  get diagnostics v_inserted = row_count;
  raise notice 'import_04 — % of 5 subtasks inserted (0 on a re-run). The list now holds 24.', v_inserted;
end $$;
