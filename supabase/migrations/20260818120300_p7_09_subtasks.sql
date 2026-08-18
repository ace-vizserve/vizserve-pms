-- P7-09 — subtasks, as cheaply as they can honestly be done.
--
-- ONE NULLABLE COLUMN. A subtask is an ordinary task that names a parent, which
-- means it already has a status, an assignee, dates, a resolution, attachments,
-- comments and — the one that matters most here — time can be logged against it,
-- because `vizserve_pms_timesheet_entries.task_id` does not care how a task came
-- to exist.
--
-- The alternative was a separate lightweight checklist table. It looks simpler
-- and is not: it would need its own RLS, its own notion of done, and it would
-- be the one kind of work in the system you cannot book hours to. Half the
-- reason to break a task up is to see where the time went.
--
-- ONE LEVEL DEEP, enforced. No grandchildren. That single restriction is what
-- keeps every existing query correct without a recursive CTE anywhere, and
-- nobody has asked to nest further.

alter table vizserve_pms_tasks
  add column parent_task_id uuid references vizserve_pms_tasks (id) on delete cascade;

-- A row cannot be its own parent. A CHECK can compare two columns of the same
-- row, so the cheapest cycle — length one — is refused by the table itself.
alter table vizserve_pms_tasks
  add constraint vizserve_pms_tasks_no_self_parent
  check (parent_task_id is null or parent_task_id <> id);

-- Every "show me the breakdown" query goes through this.
create index vizserve_pms_tasks_parent_idx
  on vizserve_pms_tasks (parent_task_id)
  where parent_task_id is not null;

-- ---------------------------------------------------------------------------
-- The two rules a CHECK cannot express, because both read another row.
--
-- 1. ONE LEVEL. The parent must not itself have a parent. This is also what
--    makes longer cycles impossible: a cycle needs every node to have a parent,
--    and a node whose parent has a parent is refused.
--
-- 2. SAME DEPARTMENT. Scope on this table resolves through `department_id`, so
--    a subtask in another department would be visible to a different set of
--    people than its parent — a task nobody can see the whole of.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_check_subtask_parent()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_parent vizserve_pms_tasks;
begin
  if new.parent_task_id is null then
    return new;
  end if;

  select * into v_parent from vizserve_pms_tasks where id = new.parent_task_id;

  if v_parent.id is null then
    raise exception 'That parent task does not exist.' using errcode = 'foreign_key_violation';
  end if;

  if v_parent.parent_task_id is not null then
    raise exception 'A subtask cannot have subtasks of its own.'
      using errcode = 'check_violation';
  end if;

  if v_parent.department_id <> new.department_id then
    raise exception 'A subtask belongs to the same department as the task above it.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger vizserve_pms_tasks_subtask_parent
  before insert or update of parent_task_id, department_id on vizserve_pms_tasks
  for each row execute function vizserve_pms_check_subtask_parent();

-- Writable like the other planning columns. Moving a task under a parent, or
-- pulling it back out, is ordinary editing rather than a state change.
grant update (parent_task_id) on vizserve_pms_tasks to authenticated;

-- ---------------------------------------------------------------------------
-- What is deliberately NOT here.
--
-- No rule that a parent cannot be completed while a subtask is open. It is the
-- obvious next constraint and it is the wrong one to add blind: sometimes the
-- last subtask stops being necessary, and a system that refuses to let you
-- close the parent then teaches people to write fake subtasks. Show it on the
-- screen instead, and let a person decide.
--
-- No progress roll-up, no inherited assignee, no inherited dates. Each subtask
-- carries its own, because the whole point of splitting a task is that the
-- pieces differ.
--
-- No change to the category model. A subtask has its own `request_id` (null) and
-- its own `is_personal`, so a breakdown of client work is INTERNAL work — which
-- is correct: the client asked for the outcome, not for the checklist. The
-- parent keeps the client relationship and the client gate.
-- ---------------------------------------------------------------------------
