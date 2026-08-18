-- P7-13 / K1 — internal tasks become their own thing.
--
-- TWO CHANGES IN ONE FILE, because both rewrite
-- `vizserve_pms_transition_task` and reproducing a 150-line SECURITY DEFINER
-- function twice in two migrations is how a carried-forward fix gets dropped.
-- That has already nearly happened twice here (P7-00's coalesce guards).
--
--   1. A task carries several people.
--   2. Work with no client moves freely between statuses.
--
-- Together they are the difference the plan kept missing: an internal task is
-- not a client ticket with fewer gates, it is a board card that several people
-- share and anyone can drag.
--
-- `assignee_id` is one person and six separate places key off it. That was
-- right while a task was a client ticket with one owner; it is wrong for the
-- internal work this app is replacing ClickUp for, where three people pick at
-- the same thing and any of them might move it on.
--
-- `assignee_id` STAYS, AND STAYS MEANING SOMETHING. It is the ACCOUNTABLE name:
-- one person the task is filed under, what the board sorts by, what "assigned
-- to you" means in a notification. The new table is who is WORKING on it.
-- Every assignee gets equal capability; exactly one is the name on it. Dropping
-- the column instead would mean rewriting every ordering and every notification
-- for no gain.
--
-- THE RIPPLE IS THE WORK. Each of these keys off the single column today, and
-- each is a place where a second assignee silently cannot do their job:
--
--   tasks SELECT policy      they cannot SEE the task at all
--   tasks UPDATE policy      they can see it and not touch it
--   may_log_time             they cannot log time, so the timesheet is wrong
--   transition_task guard    they cannot move it
--
-- All four go through ONE helper below rather than repeating the same `exists`
-- four times. The helper is the thing that stops the fifth site being missed.

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------
create table vizserve_pms_task_assignees (
  task_id  uuid not null references vizserve_pms_tasks (id) on delete cascade,
  user_id  uuid not null references vizserve_pms_users (id) on delete cascade,
  -- Who put them on it. Not an audit trail — `vizserve_pms_audit_logs` is that
  -- — but the one question people ask about a task they did not expect.
  added_by uuid references vizserve_pms_users (id) on delete set null,
  added_at timestamptz not null default now(),

  primary key (task_id, user_id)
);

comment on table vizserve_pms_task_assignees is
  'P7-13. Additional people on a task. vizserve_pms_tasks.assignee_id remains '
  'the accountable owner; this is who is working on it. Membership here confers '
  'the same read, write, log-time and transition rights as being the PIC.';

-- `on delete cascade` on BOTH sides, and neither is careless. A deleted task
-- has no assignees to remember, and a deleted user cannot be on anything —
-- unlike `author_id` on a comment, which is `restrict` because the comment is a
-- historical statement that must keep its author.

create index vizserve_pms_task_assignees_user_idx
  on vizserve_pms_task_assignees (user_id);

-- ---------------------------------------------------------------------------
-- The helper every site goes through.
--
-- SECURITY DEFINER, and that is what makes it usable inside the tasks policies
-- at all: it reads `vizserve_pms_tasks` and `vizserve_pms_task_assignees`, and
-- a definer function does not re-enter RLS, so calling it from a policy ON
-- those tables cannot recurse. Same pattern and same reason as
-- `vizserve_pms_may_log_time`.
--
-- It answers exactly one question — "is this person on this task" — and
-- deliberately does NOT answer "may they see it", which also admits department
-- leads. Keeping those separate is what stops a lead accidentally counting as
-- an assignee for the transition guard, where the two really are different.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_is_on_task(p_task_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from vizserve_pms_tasks t
     where t.id = p_task_id
       and (t.assignee_id = p_user_id or t.qa_assignee_id = p_user_id)
  )
  or exists (
    select 1 from vizserve_pms_task_assignees a
     where a.task_id = p_task_id and a.user_id = p_user_id
  );
$$;

grant execute on function vizserve_pms_is_on_task(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- RLS on the join table.
--
-- Readable by anyone who can already see the task — otherwise the task detail
-- cannot list who is on it. Written only through the functions below, so there
-- is no INSERT or DELETE policy at all and `lib/database.types.ts` says
-- `Insert: never`. Adding somebody to a task is a decision with a rule behind
-- it, not a row anybody may write.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_task_assignees enable row level security;
revoke all on vizserve_pms_task_assignees from anon;

create policy "task assignees readable with the task"
  on vizserve_pms_task_assignees for select to authenticated
  using (
    vizserve_pms_is_on_task(task_id, auth.uid())
    or exists (
      select 1 from vizserve_pms_tasks t
       where t.id = vizserve_pms_task_assignees.task_id
         and vizserve_pms_manages_department(t.department_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Adding and removing.
--
-- Same rule as editing the task: you must already be on it or lead its
-- department. A member cannot add themselves to somebody else's work, and the
-- person being added must be an active member of the task's own department —
-- the same boundary `vizserve_pms_create_task` applies to `p_assignee_id`.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_add_task_assignee(p_task_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_task  vizserve_pms_tasks;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  if not (
    coalesce(vizserve_pms_is_on_task(p_task_id, v_actor), false)
    or coalesce(vizserve_pms_manages_department(v_task.department_id), false)
  ) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  if not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_user_id and u.is_active
       and u.primary_department_id = v_task.department_id
  ) then
    raise exception 'That person is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  -- Already on it is not an error. Two people pressing the same button is the
  -- ordinary case, and a raise here would surface as a failure for something
  -- that is already true.
  insert into vizserve_pms_task_assignees (task_id, user_id, added_by)
  values (p_task_id, p_user_id, v_actor)
  on conflict (task_id, user_id) do nothing;

  -- They are being handed work. Same channel and same shape as
  -- `vizserve_pms_create_task`'s assignment notice.
  if p_user_id <> v_actor then
    perform vizserve_pms_notify(
      p_user_id, 'assigned', 'Added to: ' || v_task.title,
      coalesce(v_task.description, ''), 'task', p_task_id, '/tasks/' || p_task_id::text
    );
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function vizserve_pms_remove_task_assignee(p_task_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_actor uuid := auth.uid();
  v_task  vizserve_pms_tasks;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  if not (
    coalesce(vizserve_pms_is_on_task(p_task_id, v_actor), false)
    or coalesce(vizserve_pms_manages_department(v_task.department_id), false)
  ) then
    raise exception 'That task is not yours to change.' using errcode = 'insufficient_privilege';
  end if;

  -- The accountable name cannot be removed from here. It is a column, not a
  -- row in this table, and emptying it is a reassignment rather than a removal
  -- — a different decision with a different rule.
  if p_user_id = v_task.assignee_id then
    raise exception 'That is the person this task is assigned to. Reassign it instead.'
      using errcode = 'check_violation';
  end if;

  delete from vizserve_pms_task_assignees
   where task_id = p_task_id and user_id = p_user_id;

  return jsonb_build_object('ok', true);
end;
$$;

grant execute on function vizserve_pms_add_task_assignee(uuid, uuid) to authenticated;
grant execute on function vizserve_pms_remove_task_assignee(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Site 1 and 2 — the tasks policies.
--
-- Postgres has no "alter policy, add a clause", so both are dropped and
-- recreated. Names must match 20260803110000_p2_00_approval_engine.sql:277/285
-- exactly, or the old policy survives alongside the new one and the union of
-- two permissive policies is wider than either.
-- ---------------------------------------------------------------------------
drop policy "tasks readable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    -- P7-13. Without this line a second assignee cannot see the task at all,
    -- and every other right below is unreachable for them.
    or vizserve_pms_is_on_task(id, auth.uid())
  );

drop policy "tasks updatable by participants and department leads" on vizserve_pms_tasks;

create policy "tasks updatable by participants and department leads"
  on vizserve_pms_tasks for update to authenticated
  using (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    or vizserve_pms_is_on_task(id, auth.uid())
  )
  with check (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    or vizserve_pms_is_on_task(id, auth.uid())
  );

-- ---------------------------------------------------------------------------
-- Site 3 — logging time.
--
-- Reproduced whole; the body is the P6-01 original with the membership test
-- swapped for the helper. Without this a second assignee is offered the task in
-- the picker and refused by the INSERT policy — the timesheet's worst failure
-- shape, because a refused INSERT surfaces as a sentence about three unrelated
-- rules.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_may_log_time(p_task_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select vizserve_pms_is_on_task(p_task_id, p_user_id);
$$;

-- ---------------------------------------------------------------------------
-- Site 4 — the transition guard.
--
-- REPRODUCED IN FULL, and read the next three lines before editing it.
--
--   * P7-00's `coalesce(…, false)` guards MUST survive. A nullable column
--     compared with `=` yields NULL, `not NULL` is NULL, and `IF NULL THEN`
--     does not fire — so an unset QA seat silently disabled the ownership check
--     entirely. That was a live authorization hole and this is the third
--     `create or replace` that has had to carry the fix forward.
--   * P7-02's category gate MUST survive — the three separate sentences, not
--     one generic refusal.
--   * The ONLY change here is `v_is_pic`, which now admits anyone on the task.
--
-- Any assignee counts as the PIC for the purpose of moving it. That is the
-- point of several assignees: work nobody can advance because the one named
-- person is on leave is exactly what this slice exists to stop.
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
  v_category   text;
  v_reference  text;
begin
  if v_actor is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select * into v_task from vizserve_pms_tasks where id = p_task_id for update;

  if v_task.id is null then
    raise exception 'That task no longer exists.' using errcode = 'no_data_found';
  end if;

  -- P7-00, carried forward for the third time. An unset seat is "not you",
  -- never "unknown".
  --
  -- P7-13: `v_is_pic` now admits anyone on the task, not just the accountable
  -- name. `vizserve_pms_is_on_task` also returns true for the QA reviewer, so
  -- the explicit `assignee_id` test is kept alongside it for readability rather
  -- than necessity — and `v_is_qa` stays a SEPARATE test, because the QA gate
  -- below must not be satisfiable by being on the task.
  v_is_pic := coalesce(v_task.assignee_id = v_actor, false)
              or coalesce(
                   exists (
                     select 1 from vizserve_pms_task_assignees a
                      where a.task_id = p_task_id and a.user_id = v_actor
                   ),
                   false
                 );
  v_is_qa  := coalesce(v_task.qa_assignee_id = v_actor, false);
  v_leads  := coalesce(vizserve_pms_manages_department(v_task.department_id), false);

  -- The same three-way split the TypeScript mirror computes in `taskCategory`.
  -- A request wins over the personal flag: a task with a client behind it is
  -- client work whatever else is set on it.
  v_category := case
                  when v_task.request_id is not null then 'request'
                  when v_task.is_personal            then 'personal'
                  else 'internal'
                end;

  -- Being able to SEE a task is not being able to move it. A member of the
  -- department who is neither PIC nor QA has no business advancing it.
  if not (v_is_pic or v_is_qa or v_leads) then
    raise exception 'That task is not yours to move.' using errcode = 'insufficient_privilege';
  end if;

  if v_task.status = p_to_status then
    raise exception 'That task is already %.', p_to_status
      using errcode = 'invalid_parameter_value';
  end if;

  -- ==========================================================================
  -- INTERNAL WORK MOVES FREELY. CLIENT WORK DOES NOT.
  --
  -- This is the distinction the slice is about, and it is where an internal
  -- task stops being a client ticket with fewer gates and becomes a different
  -- thing: a board card people drag about, which is what the team already does
  -- in ClickUp all day.
  --
  -- Every gate in the pipeline has somebody OUTSIDE THE COMPANY on the other
  -- end: a resolution before review, a reviewer before the client, the client
  -- before it is done. None of that applies to "read the brand guidelines" or
  -- "chase the supplier". P7-06 already conceded the point by adding five
  -- internal-only rows to the transition table, and that was the half measure —
  -- it still meant predicting, in a migration, every way a person might want to
  -- move their own work.
  --
  -- So for work with no client there is NO TABLE LOOKUP AT ALL. Any status to
  -- any status, no required fields, by anyone on the task or leading the
  -- department.
  --
  -- WHAT STAYS TRUE EVEN HERE, and neither is negotiable:
  --
  --   1. FOR_CLIENT_APPROVAL stays unreachable. That is not strictness, it is
  --      arithmetic: `vizserve_pms_issue_approval_token` raises "That task has
  --      no client to approve it", so a task parked there has no legal way out
  --      and no way to finish. Freedom to strand your own work is not freedom.
  --   2. EVERY MOVE STILL WRITES HISTORY. The insert below sits outside this
  --      branch. Free movement means no gates; it has never meant no record,
  --      and `status` stays outside the column UPDATE grant, so this function
  --      remains the only way a status changes at all.
  -- ==========================================================================
  if v_category <> 'request' then
    if p_to_status = 'FOR_CLIENT_APPROVAL' then
      raise exception 'There is no client to approve this one. It finishes here.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- Nothing further to ask. The ownership check above already established
    -- that the caller is on this task or leads its department.

  else
    -- ---- client work: the table is the authority, exactly as before --------
    select * into v_rule
      from vizserve_pms_task_transitions
     where from_status = v_task.status and to_status = p_to_status;

    -- Every illegal transition rejected server-side, by construction: if it is
    -- not in the table it does not happen.
    if v_rule.to_status is null then
      raise exception 'A task cannot go from % to %.', v_task.status, p_to_status
        using errcode = 'invalid_parameter_value';
    end if;

    -- A rule written for work WITHOUT a client cannot be borrowed by work with
    -- one. This is what stops a client task using P7-02's
    -- `QA_IN_PROGRESS -> COMPLETED` to skip Gate 3 entirely.
    if v_rule.applies_to in ('internal', 'personal') then
      raise exception 'This has a client behind it — it finishes when they sign off, not here.'
        using errcode = 'invalid_parameter_value';
    end if;

    -- Who may make THIS move. A TL leading the department may act in either
    -- seat (they are frequently the QA), but a member cannot QA their own work
    -- by moving it past the gate themselves.
    if v_rule.actor = 'pic' and not (v_is_pic or v_leads) then
      raise exception 'Only the person in charge can do that.'
        using errcode = 'insufficient_privilege';
    end if;

    if v_rule.actor = 'qa' and not (v_is_qa or v_leads) then
      raise exception 'Only the QA reviewer can do that.'
        using errcode = 'insufficient_privilege';
    end if;

    -- The client and system rows belong to Phase 4. Until then only an admin
    -- may exercise them, which is what makes them testable now without a token.
    if v_rule.actor in ('client', 'system') and not vizserve_pms_is_admin() then
      raise exception 'That transition is made by the client, not from here.'
        using errcode = 'insufficient_privilege';
    end if;

    -- --- the gates ----------------------------------------------------------
    if v_rule.required_field = 'resolution'
       and (v_task.resolution is null or length(btrim(v_task.resolution)) = 0) then
      raise exception 'Record what you did in the resolution before sending this for QA.'
        using errcode = 'check_violation';
    end if;

    if v_rule.required_field = 'comment' and v_comment is null then
      raise exception 'A comment is required for that.' using errcode = 'check_violation';
    end if;
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

-- No regrant: same name, same argument list, so the existing
-- `grant execute on function vizserve_pms_transition_task(uuid,
-- vizserve_pms_task_status, text)` from P3 still applies. The drop-and-regrant
-- dance is only for a CHANGED signature.
