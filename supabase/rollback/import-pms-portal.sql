-- Rollback for import_01 … import_06 — the ClickUp test slice.
--
-- NOT A MIGRATION, and it lives outside `supabase/migrations/` for exactly that
-- reason: a file in there replays on every `db push` and `db reset`, and a
-- delete that replays is a delete that undoes the import every time anyone sets
-- up an environment.
--
-- ⚠️ RUN BY HAND, and only deliberately. Paste into the Supabase SQL editor.
--
-- WHAT IT REMOVES — the 24 tasks of
-- `VizBytes > VIZSERVE > Project Management System Portal`, then the list, then
-- the folder. Three tables clean themselves up on the way out:
--
--   vizserve_pms_task_assignees       on delete cascade  (Kurt's 24 rows)
--   vizserve_pms_task_comments        on delete cascade  (the 2 comments)
--   vizserve_pms_task_status_history  on delete cascade  (the 24 birth rows)
--
-- WHAT IT WILL NOT DO. It deletes by the FIXED id range only — `c1000000-…-0001`
-- through `…-0024`, plus the two `b…` structural ids. Anything else on that list
-- or in that folder is somebody's real work added after the import, and the
-- guards below stop rather than take it with them. That is the whole reason the
-- ids were written down instead of generated.
--
-- After this runs, VizBytes returns to 2 folders, 4 lists and 2 tasks.

do $$
declare
  v_dept  constant uuid := 'a1000000-0000-4000-8000-000000000001';
  v_group constant uuid := 'b1000000-0000-4000-8000-000000000001';
  v_list  constant uuid := 'b2000000-0000-4000-8000-000000000001';
  v_ids   constant uuid[] := array(
    select ('c1000000-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
      from generate_series(1, 24) as n
  );
  v_strays  integer;
  v_deleted integer;
begin
  -- A task on this list that is NOT one of the 24 is real work somebody filed
  -- here afterwards. Deleting the list out from under it would orphan it
  -- (`list_id` is `on delete set null`), so stop and let a human decide.
  select count(*) into v_strays
    from vizserve_pms_tasks
   where list_id = v_list and not (id = any(v_ids));

  if v_strays > 0 then
    raise exception 'rollback: % task(s) on this list are not part of the import. Move them first.', v_strays
      using errcode = 'check_violation';
  end if;

  -- Subtasks cascade from their parent, but deleting by the whole id set is
  -- explicit and does not depend on that ordering holding.
  delete from vizserve_pms_tasks where id = any(v_ids);
  get diagnostics v_deleted = row_count;
  raise notice 'rollback — % task(s) deleted (assignees, comments and history cascaded).', v_deleted;

  -- Same rule one level up: another list in the VIZSERVE folder means the folder
  -- is no longer only ours.
  select count(*) into v_strays
    from vizserve_pms_lists
   where group_id = v_group and id <> v_list;

  if v_strays > 0 then
    raise exception 'rollback: % other list(s) live in the VIZSERVE folder. Delete the list only.', v_strays
      using errcode = 'check_violation';
  end if;

  delete from vizserve_pms_lists where id = v_list;
  raise notice 'rollback — list removed.';

  -- `on delete restrict` from lists to groups, so this can only succeed once the
  -- list above is gone. Belt and braces, but the error would be cryptic.
  delete from vizserve_pms_task_groups where id = v_group and department_id = v_dept;
  raise notice 'rollback — VIZSERVE folder removed. VizBytes is back to its pre-import state.';
end $$;
