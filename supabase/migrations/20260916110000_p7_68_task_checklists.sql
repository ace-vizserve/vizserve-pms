-- P7-68 — a checklist on a task.
--
-- ⚠️ IT IS NOT A SUBTASK, AND THE DIFFERENCE IS THE WHOLE REASON FOR A NEW
-- TABLE. A subtask is work: it has a status, an assignee, a due date, it shows
-- up in lists and boards and reports, and somebody owns it. A checklist item is
-- a step in a PROCEDURE — "Record number of malware attacks", ticked off on the
-- way through, meaningless outside the task that contains it.
--
-- The ClickUp export makes the distinction structurally: a subtask is its own
-- row with its own id and status, a checklist is a blob on the parent's row.
-- 162 tasks carry one, 338 items between them, and flattening those into
-- subtasks would put "Take screenshot of quarantined emails" in the same
-- queue as real work — 338 rows nobody wants in a board column.
--
-- ⚠️ `group_label` IS HOW A CHECKLIST KEEPS ITS NAME. ClickUp allows several
-- named checklists per task; every one of the 162 in the export has exactly
-- one, and 131 of those are called the default "Checklist". The other names
-- are worth keeping — "IT Weekly Security Audit" is the procedure, not
-- decoration — so the name rides on the item rather than in a second table that
-- would exist to hold one string. Null renders as a plain list with no heading,
-- which is the common case.
--
-- ⚠️ NO `done_at` OR `done_by`. A checklist is a scratchpad, not a record:
-- somebody ticks four, unticks one, ticks it again. Storing who and when would
-- be audit data about a thing nobody audits, and `vizserve_pms_audit_row_update`
-- exists for the columns that ARE audited. If that ever changes, it changes
-- with a reason attached.

create table vizserve_pms_task_checklist_items (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references vizserve_pms_tasks (id) on delete cascade,

  -- The heading this item sits under, or null for an unnamed list.
  group_label  text,
  label        text not null,
  is_done      boolean not null default false,

  -- Sparse on purpose — see the reorder note below.
  position     integer not null,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint vizserve_pms_task_checklist_items_label_present check (length(btrim(label)) > 0),
  -- 500 is well past a step in a procedure and well short of prose. A checklist
  -- item that needs a paragraph is a subtask.
  constraint vizserve_pms_task_checklist_items_label_length check (length(label) <= 500)
);

-- The one query this table has: every item on one task, in order.
create index vizserve_pms_task_checklist_items_task_idx
  on vizserve_pms_task_checklist_items (task_id, position);

create trigger vizserve_pms_task_checklist_items_updated_at
  before update on vizserve_pms_task_checklist_items
  for each row execute function vizserve_pms_set_updated_at();

alter table vizserve_pms_task_checklist_items enable row level security;

-- `anon` holds no table privilege anywhere in this schema and gains none here.
revoke all on vizserve_pms_task_checklist_items from anon;
grant select, insert, update, delete on vizserve_pms_task_checklist_items to authenticated;

-- ---------------------------------------------------------------------------
-- RLS — it follows the task, in the P11-06 shape.
--
-- ⚠️ DEFERRED, NOT RESTATED. `exists (select 1 from vizserve_pms_tasks t where
-- t.id = task_id)` reads exactly "if you can open the task", because RLS applies
-- inside that subquery. P11-06 changed four policies to this shape precisely
-- because restating the predicate is how it drifts — and every one of those four
-- had drifted. A future change to task visibility carries the checklist along
-- with the comments and the files.
--
-- ⚠️ AND TICKING IS NOT A LEAD DECISION. Anyone who can open the task can tick
-- an item on it, the same audience that can comment and log time (P11-03). A
-- checklist that only its owner may tick is a checklist nobody uses, because the
-- person doing the step is routinely not the person the task is assigned to.
--
-- ⚠️ NO TERMINAL-STATUS GUARD, deliberately, unlike the attachment INSERT. A
-- finished task's FILES are a record; its checklist is how somebody proves the
-- procedure was followed, and noticing a missed step after marking the task done
-- is the normal case rather than an edge one.
-- ---------------------------------------------------------------------------
create policy "checklist items follow their task"
  on vizserve_pms_task_checklist_items for select to authenticated
  using (exists (select 1 from vizserve_pms_tasks t where t.id = task_id));

create policy "checklist items writable by anyone who can read the task"
  on vizserve_pms_task_checklist_items for insert to authenticated
  with check (exists (select 1 from vizserve_pms_tasks t where t.id = task_id));

create policy "checklist items updatable by anyone who can read the task"
  on vizserve_pms_task_checklist_items for update to authenticated
  using (exists (select 1 from vizserve_pms_tasks t where t.id = task_id))
  with check (exists (select 1 from vizserve_pms_tasks t where t.id = task_id));

create policy "checklist items deletable by anyone who can read the task"
  on vizserve_pms_task_checklist_items for delete to authenticated
  using (exists (select 1 from vizserve_pms_tasks t where t.id = task_id));

-- ---------------------------------------------------------------------------
-- Appending, without a race.
--
-- ⚠️ THE CLIENT MUST NOT CHOOSE THE POSITION. Two people adding an item at the
-- same moment both read "the last position is 30" and both write 40, and the
-- order of a procedure becomes whatever the database felt like. This computes it
-- inside the insert, against the row lock the insert already takes.
--
-- Positions step by 10 so an item can be dropped between two others later
-- without renumbering the list. Reordering is not built yet and this is the
-- cheap half of leaving the door open — a gap costs nothing now and is the
-- difference between one update and thirty when it is wanted.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_add_checklist_item(
  p_task_id     uuid,
  p_label       text,
  p_group_label text default null
)
returns vizserve_pms_task_checklist_items
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
  v_row vizserve_pms_task_checklist_items;
begin
  insert into vizserve_pms_task_checklist_items (task_id, label, group_label, position)
  values (
    p_task_id,
    p_label,
    p_group_label,
    coalesce(
      (select max(position) from vizserve_pms_task_checklist_items where task_id = p_task_id),
      0
    ) + 10
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- `security invoker`: the policies above decide, exactly as they would for a
-- direct insert. This function exists for the position, not for privilege.
grant execute on function vizserve_pms_add_checklist_item(uuid, text, text) to authenticated;
