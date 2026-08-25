-- import_07 — Ace joins Kurt on the join table, so neither is privileged.
--
-- A follow-on to import_01…06, not a seventh step of the original plan. It
-- exists because of a rule settled AFTER the import landed:
--
--   INTERNAL TASKS HAVE NO PERSON IN CHARGE. Everyone on them is an equal
--   assignee. The PIC stays a real role only on CLIENT tasks — the ones with a
--   `request_id`, where somebody has to be answerable to the person who filed
--   the request.
--
-- All 24 imported tasks are internal (`request_id is null`), so all 24 fall
-- under the new rule. Ace was written into `assignee_id` by import_03 and
-- import_04 and was deliberately NOT given a join-table row, because at the time
-- that column meant "the accountable name" and duplicating it would have
-- misrepresented the table. Under the new rule it means one assignee among
-- several, and his absence from the table is what now misrepresents it: the
-- screens read membership from the join table, so without this file Ace renders
-- as a special case on tasks that are supposed to have none.
--
-- `assignee_id` IS LEFT SET, and that is not a half-measure. The column still
-- earns its place on an internal task:
--
--   * `vizserve_pms_notify` addresses "assigned to you" to it
--   * the board's ordering falls back to it
--   * every tasks policy names it directly, so a task with a null column and an
--     empty join table is one only a department lead can repair
--
-- What changes is what it MEANS on an internal task: not a rank, just the
-- assignee who also happens to be named in the column. The screens stop drawing
-- a distinction the data no longer claims.
--
-- ⚠️ APPLY BY HAND in the Supabase SQL editor.

do $$
declare
  v_list constant uuid := 'b2000000-0000-4000-8000-000000000001';
  v_pic      uuid;
  v_inserted integer;
begin
  select id into v_pic
    from vizserve_pms_users
   where email = 'ace.guevarra@vizserve.hfse.edu.sg' and is_active;

  if v_pic is null then
    raise notice 'import_07 SKIPPED — no active profile for ace.guevarra@vizserve.hfse.edu.sg.';
    return;
  end if;

  if (select count(*) from vizserve_pms_tasks where list_id = v_list) <> 24 then
    raise exception 'import_07: expected 24 tasks on the list. Apply import_03 and import_04 first.'
      using errcode = 'check_violation';
  end if;

  -- `added_by` is Ace himself: he was already on this work before the table knew
  -- about it, and naming anyone else as the person who added him would invent a
  -- decision nobody made.
  --
  -- Scoped to INTERNAL tasks explicitly. Every row on this list is internal
  -- today, so the clause changes nothing now — it is here so that re-running
  -- this file after a client request has been routed into the list cannot
  -- quietly apply the internal rule to a client task.
  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  select t.id, v_pic, v_pic
    from vizserve_pms_tasks t
   where t.list_id = v_list
     and t.request_id is null
     and t.assignee_id = v_pic
  on conflict (task_id, user_id) do nothing;

  get diagnostics v_inserted = row_count;
  raise notice 'import_07 — Ace added to % of 24 tasks (0 on a re-run). Both assignees are now equal.',
    v_inserted;
end $$;
