-- ---------------------------------------------------------------------------
-- P11-08 — subtasks that were created without a list.
--
-- THE BUG: `quickAddTask` defaulted `list_id` to null, and the composer on
-- `/tasks/[id]` has no list picker — there is nothing to pick, the parent
-- already decided. So every subtask added from a task's own page was created
-- with NO LIST.
--
-- WHY THAT HIDES IT: both views are list-filtered. `/tasks` redirects to the
-- list index unless `?list=` is set, and the board honours the same parameter.
-- A task with `list_id is null` matches neither. The subtask exists, the
-- parent's page lists it — that query reads by `parent_task_id` — and nothing
-- else can see it.
--
-- The code is fixed: a subtask now inherits its parent's list and department at
-- creation. This is for the ones already written.
--
-- ⚠️ RUN THE SELECT FIRST. It is the same predicate as the update, so what it
-- returns is exactly what will change.
-- ---------------------------------------------------------------------------

-- 1. WHAT WOULD CHANGE. Expect a small number; every row should be a subtask
--    you remember adding from a task page.
select
  child.id,
  child.title,
  parent.title as parent_title,
  parent.list_id as will_get_list,
  list.name as will_get_list_name
from vizserve_pms_tasks as child
join vizserve_pms_tasks as parent on parent.id = child.parent_task_id
left join vizserve_pms_lists as list on list.id = parent.list_id
where child.list_id is null
  and parent.list_id is not null
order by parent.title, child.created_at;


-- 2. THE BACKFILL.
--
-- `parent.list_id is not null` matters: a parent with no list of its own has
-- nothing to give, and writing null over null would touch rows for nothing —
-- which, with `vizserve_pms_audit_row_update` on this table, means audit rows
-- for a change that did not happen.
--
-- The department is deliberately NOT touched. `vizserve_pms_check_subtask_parent`
-- has always refused a child whose department differs from its parent's, so
-- every row here already agrees; a subtask that somehow does not is a different
-- problem and should not be papered over by this.
update vizserve_pms_tasks as child
   set list_id = parent.list_id
  from vizserve_pms_tasks as parent
 where parent.id = child.parent_task_id
   and child.list_id is null
   and parent.list_id is not null;


-- 3. VERIFY. Should return zero rows.
select count(*) as still_listless
from vizserve_pms_tasks as child
join vizserve_pms_tasks as parent on parent.id = child.parent_task_id
where child.list_id is null
  and parent.list_id is not null;
