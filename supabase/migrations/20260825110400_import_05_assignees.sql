-- import_05 — Kurt Arciga on all 24.
--
-- Fifth of six. See `20260825110000_import_01_vizbytes_folder.sql` for the shape
-- of the whole slice, the fixed-UUID scheme, and the D21 note.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor, after 04.
--
-- WHY THIS IS A SEPARATE FILE AND NOT PART OF 03. `vizserve_pms_tasks.assignee_id`
-- is a single uuid column: it holds ONE person, the accountable name — what the
-- board sorts by and what "assigned to you" means in a notification. Everyone
-- else working on a task lives here, in the P7-13 join table, and every one of
-- them is a full participant: the tasks SELECT and UPDATE policies,
-- `vizserve_pms_may_log_time` and the transition ownership guard all resolve
-- through `vizserve_pms_is_on_task`, which reads this table.
--
-- So Ace is `assignee_id` on all 24 (files 03 and 04) and Kurt is here. It comes
-- after 04 because 03 created 19 tasks and 04 the last 5 — one insert covering
-- all 24 is simpler to verify than two partial ones.
--
-- NO ROW FOR ACE. He is already the PIC, and `app/(app)/tasks/page.tsx:740`
-- filters the PIC out of the "others" list when it renders the assignee stack.
-- A row here would be ignored by the screen and would misrepresent the table,
-- whose meaning is "in ADDITION to the accountable name".
--
-- WHY A DIRECT INSERT AND NOT `vizserve_pms_add_task_assignee`. The RPC reads
-- `auth.uid()` for its scope check and for `added_by`, and a migration has no
-- session user. It also NOTIFIES the person added — correct when a lead puts
-- somebody on a task, wrong 24 times in a row for a backfill of work Kurt has
-- been doing since July. The two rules the RPC enforces are asserted below
-- instead, so nothing is skipped, only relocated.
--
-- KNOWN CONSEQUENCE, and it is a property of the app rather than of this import:
-- the "Mine" view filters on `assignee_id` alone (`app/(app)/tasks/page.tsx:213`),
-- so these 24 appear under Ace's Mine and Kurt reaches them through the VIZSERVE
-- folder tree. Everything else treats him as a full participant.

do $$
declare
  v_dept constant uuid := 'a1000000-0000-4000-8000-000000000001';  -- VizBytes
  v_list constant uuid := 'b2000000-0000-4000-8000-000000000001';  -- the list, from 02
  v_pic       uuid;
  v_kurt      uuid;
  v_task_count integer;
  v_inserted  integer;
begin
  select id into v_pic
    from vizserve_pms_users
   where email = 'ace.guevarra@vizserve.hfse.edu.sg' and is_active;

  -- ClickUp spells him "Kurt Steven Arciga"; the roster has "Kurt Arciga" at
  -- kurt.arciaga@… . Resolved by ADDRESS, which is unique and stable, rather
  -- than by display name, which is neither.
  select id into v_kurt
    from vizserve_pms_users
   where email = 'kurt.arciaga@vizserve.hfse.edu.sg' and is_active;

  if v_pic is null or v_kurt is null then
    raise notice 'import_05 SKIPPED — ace.guevarra@ or kurt.arciaga@ has no active profile.';
    return;
  end if;

  -- The rule `vizserve_pms_add_task_assignee` applies to everyone it adds:
  -- "that person is not an active member of this department". Work belongs to
  -- the department doing it, or someone ends up holding a task their own TL
  -- cannot see. Asserted here because the direct insert bypasses the RPC.
  if not exists (
    select 1 from vizserve_pms_users
     where id = v_kurt and is_active and primary_department_id = v_dept
  ) then
    raise exception 'import_05: kurt.arciaga@ is not an active member of VizBytes.'
      using errcode = 'check_violation';
  end if;

  -- The insert is scoped by `list_id`, so this is the guard that keeps that
  -- honest: if the list ever holds anything other than the 24 imported rows,
  -- stop rather than quietly put Kurt on someone else's work.
  select count(*) into v_task_count from vizserve_pms_tasks where list_id = v_list;

  if v_task_count <> 24 then
    raise exception 'import_05: expected 24 tasks on the list, found %. Apply import_03 and import_04 first.',
      v_task_count
      using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  select t.id, v_kurt, v_pic
    from vizserve_pms_tasks t
   where t.list_id = v_list
  on conflict (task_id, user_id) do nothing;

  get diagnostics v_inserted = row_count;
  raise notice 'import_05 — Kurt added to % of 24 tasks (0 on a re-run).', v_inserted;
end $$;
