-- P7-82 — dragging tasks into your own order, and onto each other to nest.
--
-- ClickUp's drag handle, borrowed under D21. Two gestures, one of them new:
--
--   drop BETWEEN rows  → a manual order, stored in `tasks.position` (this file)
--   drop ON a title    → the dragged task becomes its subtask. That is P7-09's
--                        `parent_task_id`, already in the UPDATE grant and
--                        already guarded by its one-level trigger; nothing here.
--
-- ⚠️ `position` IS ONE NUMBER PER TASK, NOT ONE PER VIEW. The same task shows in
-- "All lists" and in its own list, and a per-view order would need a table of
-- (view, task) that nobody could explain. So a drag PERMUTES THE VALUES THE
-- DRAGGED GROUP ALREADY HOLDS rather than renumbering it 1..n — see
-- `vizserve_pms_reorder_tasks`. The group's rows land in the order you dropped
-- them, and every other view keeps the relative order it had.

-- ---------------------------------------------------------------------------
-- 1. Order is not content, so it is not audited.
--
-- ⚠️ THIS COMES FIRST, BEFORE THE BACKFILL BELOW, or the backfill would write one
-- audit row per task in the database. P11-03 granted department-wide editing on
-- condition that edits are audited; a task changing places in a list is not an
-- edit to the task, and one drag of a twenty-row group would otherwise log
-- twenty "updated" rows that all say nothing. `status` is skipped for the
-- different reason recorded in p11_03 (history already covers it).
-- ---------------------------------------------------------------------------
drop trigger if exists vizserve_pms_tasks_audit_update on vizserve_pms_tasks;
create trigger vizserve_pms_tasks_audit_update
  after update on vizserve_pms_tasks
  for each row
  execute function vizserve_pms_audit_row_update('task', '{updated_at,status,position}');

-- ---------------------------------------------------------------------------
-- 2. The column. Creation time is the starting order, so "Manual" opens on the
--    order things were added in and a new task lands at the bottom.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_tasks add column if not exists position double precision;

update vizserve_pms_tasks
   set position = extract(epoch from created_at)
 where position is null;

alter table vizserve_pms_tasks
  alter column position set default extract(epoch from clock_timestamp()),
  alter column position set not null;

create index if not exists vizserve_pms_tasks_position_idx on vizserve_pms_tasks (position);

-- ADDITIVE, per p7_11a: the same people who may edit a task may move it.
grant update (position) on vizserve_pms_tasks to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Reordering.
--
-- `p_task_ids` is the group as it should now read, top to bottom. The values
-- those tasks already hold are sorted and handed back out in that order.
--
-- SECURITY INVOKER, so the tasks UPDATE policy (P11-03: the department) decides
-- row by row. A task the caller may not edit keeps its value; the count that
-- comes back says how many actually moved.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_reorder_tasks(p_task_ids uuid[])
returns integer
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_count integer;
begin
  -- Numbered AFTER dropping ids the caller cannot see, so the two sides of the
  -- join below count the same rows — a gap in one would shift every value after
  -- it onto the wrong task.
  with wanted as (
    select x.id, row_number() over (order by x.ord) as ord
      from unnest(p_task_ids) with ordinality as x(id, ord)
      join vizserve_pms_tasks t on t.id = x.id
  ),
  held as (
    select t.position, row_number() over (order by t.position, t.id) as ord
      from vizserve_pms_tasks t
     where t.id in (select id from wanted)
  )
  update vizserve_pms_tasks t
     set position = h.position
    from wanted w
    join held h on h.ord = w.ord
   where t.id = w.id
     and t.position is distinct from h.position;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

grant execute on function vizserve_pms_reorder_tasks(uuid[]) to authenticated;
