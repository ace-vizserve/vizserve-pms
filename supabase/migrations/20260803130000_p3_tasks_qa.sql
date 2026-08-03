-- P3-01 / P3-02 / P3-06 / P3-07 / P3-11 — Tasks, lists, and the status machine.
--
-- Phase 2 created `vizserve_pms_tasks` because P2-07 had nothing to approve into.
-- This migration gives it the things that make it a work-tracking system: lists,
-- a history of every status change, and a state machine that is enforced by the
-- database rather than by the screens.
--
-- THE STRUCTURAL DECISION, and everything else follows from it:
--
--   `status` IS NOT UPDATABLE BY `authenticated`.
--
-- The column-level grant is revoked below, so the only way a task changes state
-- is `vizserve_pms_transition_task`. That is what makes three separate promises
-- true at once, none of which survive an ordinary UPDATE policy:
--
--   * every transition is legal          — checked in one place
--   * every transition writes history    — no path exists that skips it
--   * FOR_QA is unreachable without a resolution — no `curl` can get round it
--
-- RLS cannot express "you may update this row but not that column". Column
-- privileges can, and this is exactly what they are for.

-- ---------------------------------------------------------------------------
-- P3-01 — Lists.
--
-- "List per helpdesk area or project" (Amier ~33:00). Department-scoped, because
-- a list is a way of organising one team's work and a global list is a way of
-- organising nobody's.
--
-- This also resolves Q18 and unblocks P2-06, which was deferred out of Phase 2
-- precisely because this table did not exist yet.
-- ---------------------------------------------------------------------------
create table vizserve_pms_lists (
  id            uuid primary key default gen_random_uuid(),
  department_id uuid not null references vizserve_pms_departments (id) on delete restrict,
  name          text not null,
  description   text not null default '',
  is_active     boolean not null default true,
  sort_order    integer not null default 0,
  created_by    uuid references vizserve_pms_users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  -- Unique per department, not globally. Two teams may both have a "Collateral"
  -- list and they are different lists.
  constraint vizserve_pms_lists_name_per_department unique (department_id, name)
);

create index vizserve_pms_lists_department_idx on vizserve_pms_lists (department_id, sort_order);

create trigger vizserve_pms_lists_updated_at
  before update on vizserve_pms_lists
  for each row execute function vizserve_pms_set_updated_at();

alter table vizserve_pms_lists enable row level security;
revoke all on vizserve_pms_lists from anon;

-- Readable by anyone who can see the department's work — including members, who
-- need it to make sense of their own task list.
create policy "lists readable in department"
  on vizserve_pms_lists for select to authenticated
  using (
    vizserve_pms_manages_department(department_id)
    or exists (
      select 1 from vizserve_pms_users u
       where u.id = auth.uid() and u.is_active and u.primary_department_id = department_id
    )
  );

create policy "lists writable by department leads"
  on vizserve_pms_lists for all to authenticated
  using (vizserve_pms_manages_department(department_id))
  with check (vizserve_pms_manages_department(department_id));

alter table vizserve_pms_tasks
  add column list_id uuid references vizserve_pms_lists (id) on delete set null;

create index vizserve_pms_tasks_list_idx on vizserve_pms_tasks (list_id);

-- P2-06, finally buildable. Null means "no default", which is the honest state
-- for a form whose department has not organised itself into lists yet.
alter table vizserve_pms_forms
  add column default_list_id uuid references vizserve_pms_lists (id) on delete set null;

-- ---------------------------------------------------------------------------
-- P3-02 — Status history.
--
-- Not an audit log. The audit log answers "who changed what"; this answers "how
-- long was this task in each state", which is a different question with a
-- different shape — and it is the only way `WAITING_FOR_INFO` duration (P3-11,
-- risk R4) is derivable at all.
-- ---------------------------------------------------------------------------
create table vizserve_pms_task_status_history (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references vizserve_pms_tasks (id) on delete cascade,
  -- Null on the first row: a task is born into OPEN, it does not move there.
  from_status vizserve_pms_task_status,
  to_status   vizserve_pms_task_status not null,
  -- Null for the Phase 4 client and for the auto-complete cron. Both are real
  -- actors and neither has a user row.
  actor_id    uuid references vizserve_pms_users (id) on delete set null,
  comment     text,
  -- Q5: a TL forcing a stuck ticket. Allowed, always with a reason, and flagged
  -- distinctly — an override that reads like an ordinary transition is an
  -- override that destroys the audit trail it appears in.
  is_override boolean not null default false,
  created_at  timestamptz not null default now()
);

create index vizserve_pms_task_status_history_task_idx
  on vizserve_pms_task_status_history (task_id, created_at);

alter table vizserve_pms_task_status_history enable row level security;
revoke all on vizserve_pms_task_status_history from anon;

-- Visible to whoever can see the task. No INSERT policy — rows come only from
-- the transition function, so the history cannot be edited to hide a step.
create policy "task history follows its task"
  on vizserve_pms_task_status_history for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_tasks t
       where t.id = task_id
         and (
           t.assignee_id = auth.uid()
           or t.qa_assignee_id = auth.uid()
           or vizserve_pms_manages_department(t.department_id)
         )
    )
  );

-- ---------------------------------------------------------------------------
-- P3-06 — the legal transition table, as data.
--
-- Written as a table rather than a CASE ladder so that it can be read, queried,
-- and rendered — the UI needs to know which buttons to draw, and deriving that
-- from a function body means hard-coding the same list a second time in
-- TypeScript. `lib/schemas/tasks.ts` mirrors it, and a test asserts they agree.
--
-- `required_field` is the gate: 'resolution' means the task's resolution must be
-- non-empty, 'comment' means the caller must supply one.
-- ---------------------------------------------------------------------------
create table vizserve_pms_task_transitions (
  from_status    vizserve_pms_task_status not null,
  to_status      vizserve_pms_task_status not null,
  -- 'pic' | 'qa' | 'client' | 'system'
  actor          text not null,
  required_field text,
  primary key (from_status, to_status)
);

insert into vizserve_pms_task_transitions (from_status, to_status, actor, required_field) values
  ('OPEN',                'ONGOING',               'pic',    null),
  ('ONGOING',             'WAITING_FOR_INFO',      'pic',    'comment'),
  ('WAITING_FOR_INFO',    'ONGOING',               'pic',    null),
  -- THE resolution gate (P3-07). Amier 52:00 — a member must record what they
  -- actually did before anyone reviews it. Without it the QA reviewer has
  -- nothing to review against and the Phase 4 client email is an empty shell.
  ('ONGOING',             'FOR_QA',                'pic',    'resolution'),
  ('FOR_QA',              'QA_IN_PROGRESS',        'qa',     null),
  ('QA_IN_PROGRESS',      'ONGOING',               'qa',     'comment'),
  ('QA_IN_PROGRESS',      'FOR_CLIENT_APPROVAL',   'qa',     null),
  -- The last three are the Phase 4 client path. Present now so the machine is
  -- complete; exercised in Phase 3 only by an admin override.
  ('FOR_CLIENT_APPROVAL', 'ONGOING',               'client', 'comment'),
  ('FOR_CLIENT_APPROVAL', 'COMPLETED',             'client', null),
  ('FOR_CLIENT_APPROVAL', 'COMPLETED_NO_RESPONSE', 'system', null);

alter table vizserve_pms_task_transitions enable row level security;
revoke all on vizserve_pms_task_transitions from anon;

create policy "transitions readable by active users"
  on vizserve_pms_task_transitions for select to authenticated
  using (vizserve_pms_current_role() is not null);

-- Nobody writes it from the app. Changing the state machine is a migration.
revoke insert, update, delete on vizserve_pms_task_transitions from authenticated;

-- ---------------------------------------------------------------------------
-- The column-level lockdown.
--
-- The grants migration handed `authenticated` table-level UPDATE, and in
-- Postgres a table-level privilege still implies every column — revoking one
-- column from it does nothing. So the table grant goes and per-column grants
-- replace it.
--
-- `resolution` stays writable: the PIC drafts it as they work, and the gate is
-- not "you may not write this" but "you may not reach FOR_QA without it".
-- `status` does not, which is what makes the state machine real.
-- ---------------------------------------------------------------------------
revoke update on vizserve_pms_tasks from authenticated;

grant update (
  title, description, resolution, output_link,
  due_date, assignee_id, qa_assignee_id, list_id
) on vizserve_pms_tasks to authenticated;

-- ---------------------------------------------------------------------------
-- P3-06 / P3-07 — the state machine.
--
-- The single path by which a task changes status. Returns the new status so the
-- caller does not have to re-read the row.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_transition_task(
  p_task_id   uuid,
  p_to_status vizserve_pms_task_status,
  p_comment   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task       vizserve_pms_tasks;
  v_rule       vizserve_pms_task_transitions;
  v_actor      uuid := auth.uid();
  v_comment    text := nullif(btrim(coalesce(p_comment, '')), '');
  v_is_pic     boolean;
  v_is_qa      boolean;
  v_leads      boolean;
  v_reference  text;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  v_is_pic := v_task.assignee_id = v_actor;
  v_is_qa  := v_task.qa_assignee_id = v_actor;
  v_leads  := vizserve_pms_manages_department(v_task.department_id);

  -- Being able to SEE a task is not being able to move it. A member of the
  -- department who is neither PIC nor QA has no business advancing it.
  if not (v_is_pic or v_is_qa or v_leads) then
    raise exception 'That task is not yours to move.' using errcode = 'insufficient_privilege';
  end if;

  if v_task.status = p_to_status then
    raise exception 'That task is already %.', p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_rule
    from vizserve_pms_task_transitions
   where from_status = v_task.status and to_status = p_to_status;

  -- Every illegal transition rejected server-side, by construction: if it is not
  -- in the table it does not happen.
  if v_rule.to_status is null then
    raise exception 'A task cannot go from % to %.', v_task.status, p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  -- Who may make THIS move. A TL leading the department may act in either seat
  -- (they are frequently the QA), but a member cannot QA their own work by
  -- moving it past the gate themselves.
  if v_rule.actor = 'pic' and not (v_is_pic or v_leads) then
    raise exception 'Only the person in charge can do that.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_rule.actor = 'qa' and not (v_is_qa or v_leads) then
    raise exception 'Only the QA reviewer can do that.'
      using errcode = 'insufficient_privilege';
  end if;

  -- The client and system rows belong to Phase 4. Until then only an admin may
  -- exercise them, which is what makes them testable now without a token.
  if v_rule.actor in ('client', 'system') and not vizserve_pms_is_admin() then
    raise exception 'That transition is made by the client, not from here.'
      using errcode = 'insufficient_privilege';
  end if;

  -- --- the gates ------------------------------------------------------------
  if v_rule.required_field = 'resolution'
     and (v_task.resolution is null or length(btrim(v_task.resolution)) = 0) then
    raise exception 'Record what you did in the resolution before sending this for QA.'
      using errcode = 'check_violation';
  end if;

  if v_rule.required_field = 'comment' and v_comment is null then
    raise exception 'A comment is required for that.' using errcode = 'check_violation';
  end if;

  update vizserve_pms_tasks set status = p_to_status where id = p_task_id;

  insert into vizserve_pms_task_status_history
    (task_id, from_status, to_status, actor_id, comment, is_override)
  values
    (p_task_id, v_task.status, p_to_status, v_actor, v_comment, false);

  select r.reference_no into v_reference
    from vizserve_pms_requests r where r.id = v_task.request_id;

  -- --- notifications --------------------------------------------------------
  -- Only where somebody has to act. Ordinary status movement is inbox-only
  -- (docs/12 §3) and this is where that budget is actually spent.
  if p_to_status = 'FOR_QA' and v_task.qa_assignee_id is not null then
    perform vizserve_pms_notify(
      v_task.qa_assignee_id, 'qa_requested',
      'Ready for QA: ' || coalesce(v_reference, v_task.title),
      v_task.title, 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  -- QA sent it back. The PIC is the one who has to do something about it, and
  -- the comment travels with the notification so they do not have to go looking.
  if v_task.status = 'QA_IN_PROGRESS' and p_to_status = 'ONGOING'
     and v_task.assignee_id is not null then
    perform vizserve_pms_notify(
      v_task.assignee_id, 'status_changed',
      'QA sent back: ' || coalesce(v_reference, v_task.title),
      coalesce(v_comment, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'status', p_to_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- Q5 — the override.
--
-- Real systems need someone able to unstick a ticket: a PIC leaves, a task sits
-- in QA_IN_PROGRESS for a fortnight. The recommendation in docs/07 is to allow
-- it for TL and above, always with a reason, and flag it distinctly in history.
--
-- Separate function rather than a flag on the one above, so that "I forced this"
-- is a different thing to type as well as a different thing to read.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_force_task_status(
  p_task_id   uuid,
  p_to_status vizserve_pms_task_status,
  p_reason    text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_task   vizserve_pms_tasks;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  if not vizserve_pms_manages_department(v_task.department_id) then
    raise exception 'Only a team leader for this department can override a status.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Not optional, and not defaulted. An unexplained override is the thing that
  -- makes the whole history untrustworthy rather than just this one row.
  if v_reason is null then
    raise exception 'An override needs a reason.' using errcode = 'check_violation';
  end if;

  if v_task.status = p_to_status then
    raise exception 'That task is already %.', p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  update vizserve_pms_tasks set status = p_to_status where id = p_task_id;

  insert into vizserve_pms_task_status_history
    (task_id, from_status, to_status, actor_id, comment, is_override)
  values
    (p_task_id, v_task.status, p_to_status, auth.uid(), v_reason, true);

  perform vizserve_pms_write_audit_log(
    'task', p_task_id, 'status_overridden', auth.uid(),
    jsonb_build_object('status', v_task.status),
    jsonb_build_object('status', p_to_status, 'reason', v_reason)
  );

  return jsonb_build_object('ok', true, 'status', p_to_status);
end;
$$;

-- ---------------------------------------------------------------------------
-- P3-12 — manual task creation.
--
-- "Create a task with no request behind it" (Amier 33:20). Real internal work
-- that never came through a form, and the reason `request_id` was nullable from
-- the day the table was created.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_create_task(
  p_department_id  uuid,
  p_title          text,
  p_description    text default '',
  p_assignee_id    uuid default null,
  p_qa_assignee_id uuid default null,
  p_due_date       date default null,
  p_list_id        uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_title   text := nullif(btrim(coalesce(p_title, '')), '');
  v_task_id uuid;
begin
  if not vizserve_pms_manages_department(p_department_id) then
    raise exception 'That department is outside your scope.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_title is null then
    raise exception 'A task needs a title.' using errcode = 'check_violation';
  end if;

  -- Same rule as the approval path: work belongs to the department doing it, or
  -- someone ends up holding a task their own TL cannot see.
  if p_assignee_id is not null and not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_assignee_id and u.is_active and u.primary_department_id = p_department_id
  ) then
    raise exception 'That assignee is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  if p_list_id is not null and not exists (
    select 1 from vizserve_pms_lists l
     where l.id = p_list_id and l.department_id = p_department_id
  ) then
    raise exception 'That list belongs to another department.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, list_id, created_by
  ) values (
    null, p_department_id, v_title, coalesce(btrim(p_description), ''), 'OPEN',
    p_assignee_id, p_qa_assignee_id, p_due_date, p_list_id, auth.uid()
  )
  returning id into v_task_id;

  perform vizserve_pms_write_audit_log(
    'task', v_task_id, 'created', auth.uid(), null,
    jsonb_build_object('manual', true, 'title', v_title, 'assignee_id', p_assignee_id)
  );

  if p_assignee_id is not null then
    perform vizserve_pms_notify(
      p_assignee_id, 'assigned', 'Assigned to you: ' || v_title,
      coalesce(btrim(p_description), ''), 'task', v_task_id, '/tasks/' || v_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true, 'task_id', v_task_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- P3-11 — how long has this spent waiting?
--
-- Derived from history rather than stored on the task, so it cannot drift and so
-- it stays correct for a task that has bounced in and out of WAITING_FOR_INFO
-- several times. Risk R4 is that this becomes unanswerable; a stored counter is
-- how that happens.
--
-- The still-waiting case measures to now(), which is what someone asking "how
-- long has this been stuck" actually means.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_task_waiting_duration(p_task_id uuid)
returns interval
language sql
stable
security definer
set search_path = public, extensions
as $$
  with moves as (
    select
      to_status,
      created_at,
      lead(created_at) over (order by created_at) as next_at
    from vizserve_pms_task_status_history
    where task_id = p_task_id
  )
  select coalesce(sum(coalesce(next_at, now()) - created_at), interval '0')
    from moves
   where to_status = 'WAITING_FOR_INFO'
     and exists (
       select 1 from vizserve_pms_tasks t
        where t.id = p_task_id
          and (
            t.assignee_id = auth.uid()
            or t.qa_assignee_id = auth.uid()
            or vizserve_pms_manages_department(t.department_id)
          )
     )
$$;

grant execute on function vizserve_pms_transition_task(uuid, vizserve_pms_task_status, text) to authenticated;
grant execute on function vizserve_pms_force_task_status(uuid, vizserve_pms_task_status, text) to authenticated;
grant execute on function vizserve_pms_create_task(uuid, text, text, uuid, uuid, date, uuid) to authenticated;
grant execute on function vizserve_pms_task_waiting_duration(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The first history row.
--
-- A task is born into OPEN rather than moving there, so nothing in the machine
-- above would ever record it — and a history that starts at the second event
-- makes "how long did this sit unstarted" unanswerable.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_task_record_creation()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into vizserve_pms_task_status_history (task_id, from_status, to_status, actor_id)
  values (new.id, null, new.status, new.created_by);
  return new;
end;
$$;

create trigger vizserve_pms_tasks_record_creation
  after insert on vizserve_pms_tasks
  for each row execute function vizserve_pms_task_record_creation();
