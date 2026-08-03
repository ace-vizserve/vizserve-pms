-- P2-00 — THE GENERIC APPROVAL ENGINE.
--
-- Built once, deliberately, before its first consumer. Phase 5's internal
-- approvals (leave, no time-in, no time-out, reimbursement) are the same shape
-- as the client-request Team Leader gate: a pending item, an approver determined
-- by department, a decision, a mandatory reason on the negative paths, an audit
-- entry, a notification. Building that twice is the most obvious avoidable waste
-- in the plan.
--
-- THE LINE THIS FILE DRAWS, and the reason it is drawn here rather than left to
-- judgement at each call site:
--
--   IN the engine   routing by department · approve/return/reject · mandatory
--                   reason · audit · notify · "pending my approval"
--   OUT of it       the capacity panel · PIC and QA assignment · editing the
--                   target date · creating a task
--
-- Everything in the second column is Gate 1 ONLY. It composes AROUND the engine
-- — an approve call that also runs the task-creation transaction — never inside
-- it. The acceptance test for this phase is a throwaway second entity type
-- routing end to end without touching anything in this section, and that test is
-- only meaningful because nothing below knows the word "request".

create type vizserve_pms_approval_decision as enum ('approved', 'returned', 'rejected');

-- ---------------------------------------------------------------------------
-- The decision log.
--
-- Deliberately NOT a status column on the approved thing. A request carries its
-- own status; this table is the record of who decided what, when, and why —
-- which survives the entity being edited afterwards, and which Phase 6 reports
-- turnaround from.
--
-- `entity_type` is a plain text discriminator with no foreign key, because the
-- whole point is that Phase 5 adds `dtr_correction` and `leave_request` without
-- touching this table.
-- ---------------------------------------------------------------------------
create table vizserve_pms_approvals (
  id             uuid primary key default gen_random_uuid(),
  entity_type    text not null,
  entity_id      uuid not null,
  -- Who was entitled to decide. Stored rather than derived, because the
  -- department a form belongs to can be changed later and the decision was made
  -- under the arrangement that existed at the time.
  department_id  uuid references vizserve_pms_departments (id) on delete set null,
  approver_id    uuid not null references vizserve_pms_users (id) on delete restrict,
  decision       vizserve_pms_approval_decision not null,
  reason         text,
  created_at     timestamptz not null default now(),

  -- The negative paths are useless to the requester without a reason. Amier's
  -- point at 37:00 is that negotiation is the primary path — but when it fails,
  -- the person on the other end has to know why. Enforced here, not in the UI.
  constraint vizserve_pms_approvals_reason_required
    check (
      decision = 'approved'
      or (reason is not null and length(btrim(reason)) > 0)
    )
);

create index vizserve_pms_approvals_entity_idx
  on vizserve_pms_approvals (entity_type, entity_id, created_at desc);
create index vizserve_pms_approvals_approver_idx
  on vizserve_pms_approvals (approver_id, created_at desc);

-- ---------------------------------------------------------------------------
-- May the caller decide on something owned by this department?
--
-- One function so that "who approves" is answered in one place for every entity
-- type that ever exists. It is the same question `vizserve_pms_manages_department`
-- answers, named for the thing it is used for, so a Phase 5 author does not have
-- to work out that "manages" is the approval rule.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_can_approve(p_department_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select vizserve_pms_manages_department(p_department_id)
$$;

-- ---------------------------------------------------------------------------
-- Record a decision. THE engine entry point.
--
-- Takes (entity_type, entity_id, department_id, decision, reason) and nothing
-- else — no request, no task, no form. Returns the approval row id.
--
-- Raises rather than returning a result object, unlike the public submission
-- path. The difference is who is calling: this is an authenticated staff action
-- behind a server action that will surface the message, and an exception here
-- rolls back whatever composed transaction wrapped it. That rollback is the
-- point — a half-approved request is the bug that erodes trust permanently
-- (R9).
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_record_decision(
  p_entity_type   text,
  p_entity_id     uuid,
  p_department_id uuid,
  p_decision      vizserve_pms_approval_decision,
  p_reason        text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_approver uuid := auth.uid();
  v_reason   text := nullif(btrim(coalesce(p_reason, '')), '');
  v_id       uuid;
begin
  if v_approver is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  if not vizserve_pms_can_approve(p_department_id) then
    raise exception 'That is outside your approval scope.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Checked here as well as in the table constraint, so the caller gets a
  -- sentence rather than a constraint name.
  if p_decision <> 'approved' and v_reason is null then
    raise exception 'A reason is required to % this.',
      case p_decision when 'returned' then 'return' else 'reject' end
      using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_approvals
    (entity_type, entity_id, department_id, approver_id, decision, reason)
  values
    (p_entity_type, p_entity_id, p_department_id, v_approver, p_decision, v_reason)
  returning id into v_id;

  perform vizserve_pms_write_audit_log(
    p_entity_type,
    p_entity_id,
    p_decision::text,
    v_approver,
    null,
    jsonb_build_object('decision', p_decision, 'reason', v_reason)
  );

  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- "Pending my approval", generically.
--
-- Returns (entity_type, entity_id) pairs the caller is entitled to decide on.
-- The engine cannot render a queue — it does not know what a request looks like
-- — but it can answer which departments the caller approves for, which is the
-- half that is identical for every entity type.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_approvable_department_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public, extensions
as $$
  select d.id
    from vizserve_pms_departments d
   where vizserve_pms_manages_department(d.id)
$$;

alter table vizserve_pms_approvals enable row level security;
revoke all on vizserve_pms_approvals from anon;

-- Readable by whoever has scope over the deciding department, plus the approver
-- themselves. No INSERT policy: rows arrive only through
-- vizserve_pms_record_decision, so nobody can forge a decision they did not make.
create policy "approvals readable in scope"
  on vizserve_pms_approvals for select to authenticated
  using (approver_id = auth.uid() or vizserve_pms_manages_department(department_id));

grant execute on function vizserve_pms_can_approve(uuid) to authenticated;
grant execute on function vizserve_pms_record_decision(text, uuid, uuid, vizserve_pms_approval_decision, text) to authenticated;
grant execute on function vizserve_pms_approvable_department_ids() to authenticated;

-- ===========================================================================
-- Everything below this line is GATE 1 — the client-request consumer.
-- Nothing above knows it exists.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Tasks.
--
-- Created here rather than in Phase 3 because P2-07 has nothing to approve INTO
-- otherwise. The full canonical status enum is declared now — the set is fixed
-- (docs/01 §3) and inventing values later is worse than carrying unused ones.
-- Phase 3 owns the transition machine, the resolution gate, and the screens;
-- this migration only creates rows in `OPEN`.
--
-- The order below is the corrected one. Amier's Miro frame had
-- Testing/QA → Completed → Submit for Final Approval, and he corrected himself
-- live: COMPLETED is terminal, AFTER the client signs off. Ship the wrong order
-- and the word "Completed" means nothing, which breaks every Phase 6 report.
-- ---------------------------------------------------------------------------
create type vizserve_pms_task_status as enum (
  'OPEN',
  'ONGOING',
  'WAITING_FOR_INFO',
  'FOR_QA',
  'QA_IN_PROGRESS',
  'FOR_CLIENT_APPROVAL',
  'COMPLETED',
  -- Distinct from COMPLETED on purpose. "The client approved it" and "the client
  -- never answered and the clock ran out" are different facts, and Phase 6
  -- reports the split.
  'COMPLETED_NO_RESPONSE'
);

create table vizserve_pms_tasks (
  id                   uuid primary key default gen_random_uuid(),
  -- NULLABLE. Phase 3 creates tasks with no request behind them (P3-12) — real
  -- internal work that never came through a form.
  request_id           uuid references vizserve_pms_requests (id) on delete set null,
  -- Denormalised from the request's form. A task must know its own department
  -- even when it has no request, and RLS should not have to walk two joins to
  -- find out who can see it.
  department_id        uuid not null references vizserve_pms_departments (id) on delete restrict,

  title                text not null,
  description          text not null default '',

  status               vizserve_pms_task_status not null default 'OPEN',

  -- The person doing the work.
  assignee_id          uuid references vizserve_pms_users (id) on delete set null,
  -- The second pair of eyes. Defaults to the approving TL, overridable to any
  -- member of the department (Amier 41:30).
  qa_assignee_id       uuid references vizserve_pms_users (id) on delete set null,

  -- The negotiated date, not the requested one.
  due_date             date,

  -- Copied from the request at approval time, so the task board can show the
  -- originating form's columns without joining back (P3-03) — and so an
  -- archived field still renders on the task that used it.
  field_values         jsonb not null default '{}'::jsonb,

  -- Phase 3 fills these. Declared now so the Phase 3 migration is additive
  -- rather than a rewrite of a table that already has rows.
  resolution           text,
  output_link          text,

  created_by           uuid references vizserve_pms_users (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint vizserve_pms_tasks_field_values_is_object
    check (jsonb_typeof(field_values) = 'object')
);

create index vizserve_pms_tasks_department_idx on vizserve_pms_tasks (department_id, status);
create index vizserve_pms_tasks_assignee_idx on vizserve_pms_tasks (assignee_id, status);
create index vizserve_pms_tasks_qa_idx on vizserve_pms_tasks (qa_assignee_id, status);
create index vizserve_pms_tasks_due_idx on vizserve_pms_tasks (due_date);
-- One task per request. A double-submitted Approve must not produce two tickets.
create unique index vizserve_pms_tasks_request_unique
  on vizserve_pms_tasks (request_id) where request_id is not null;

create trigger vizserve_pms_tasks_updated_at
  before update on vizserve_pms_tasks
  for each row execute function vizserve_pms_set_updated_at();

alter table vizserve_pms_tasks enable row level security;
revoke all on vizserve_pms_tasks from anon;

-- A member reaches a task by being ON it — as PIC or as QA. Department scope is
-- for the people who lead the department. This is the P3-15 rule, written now
-- because a table with RLS off for one phase is a table that ships with RLS off.
create policy "tasks readable by participants and department leads"
  on vizserve_pms_tasks for select to authenticated
  using (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
  );

create policy "tasks updatable by participants and department leads"
  on vizserve_pms_tasks for update to authenticated
  using (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
  )
  with check (
    assignee_id = auth.uid()
    or qa_assignee_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
  );

-- No INSERT policy. In this phase tasks are born only from an approval, inside
-- vizserve_pms_approve_request. Phase 3 adds one for manual creation (P3-12).

-- ---------------------------------------------------------------------------
-- P2-02 — the capacity query.
--
-- THE feature of the review screen. Amier, 37:00: the Team Leader's job is to
-- assess whether the person can take this on — "yung load nung tao niya, kaya pa
-- ba? Kasi kung hindi, dapat maigi pag-negotiate siya... Para hindi ma-burn out
-- yung tao." A review screen that shows only the request is a rubber stamp with
-- extra clicks, and if the TL has to open another tab to check whether someone
-- is drowning, they will not do it.
--
-- Returns one row per candidate assignee in the department:
--   open_count      — everything not yet finished
--   due_before      — how many of those are already due before this request's
--                     target date. This is the number that decides the answer.
--   next_due_dates  — the nearest three, so "4 open" gains context.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_department_capacity(
  p_department_id uuid,
  p_target_date   date default null
)
returns table (
  user_id        uuid,
  full_name      text,
  role           vizserve_pms_user_role,
  open_count     integer,
  due_before     integer,
  overdue_count  integer,
  next_due_dates date[]
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    u.id,
    u.full_name,
    u.role,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
    )::integer,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
        and p_target_date is not null
        and t.due_date is not null
        and t.due_date <= p_target_date
    )::integer,
    count(t.id) filter (
      where t.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
        and t.due_date is not null
        -- Manila, not UTC. "Overdue" is a question about the local calendar day,
        -- and a UTC comparison marks work late several hours early.
        and t.due_date < (now() at time zone 'Asia/Manila')::date
    )::integer,
    coalesce(
      (
        select array_agg(d order by d)
          from (
            select t2.due_date as d
              from vizserve_pms_tasks t2
             where t2.assignee_id = u.id
               and t2.status not in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
               and t2.due_date is not null
             order by t2.due_date
             limit 3
          ) nearest
      ),
      '{}'::date[]
    )
  from vizserve_pms_users u
  left join vizserve_pms_tasks t on t.assignee_id = u.id
  where u.is_active
    and u.primary_department_id = p_department_id
    -- Only callable by someone with scope over the department. Without this,
    -- SECURITY DEFINER would hand any signed-in user a headcount and workload
    -- report for every team in the company.
    and vizserve_pms_manages_department(p_department_id)
  group by u.id, u.full_name, u.role
  order by u.full_name
$$;

grant execute on function vizserve_pms_department_capacity(uuid, date) to authenticated;

-- Does a SPECIFIC user manage a specific department? `vizserve_pms_manages_department`
-- answers it only for `auth.uid()`, and the QA check below asks about the
-- candidate rather than about the caller.
create or replace function vizserve_pms_manages_department_for(
  p_user_id       uuid,
  p_department_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_user_managed_departments md
      join vizserve_pms_users u on u.id = md.user_id
     where md.user_id = p_user_id
       and md.department_id = p_department_id
       and u.is_active
  )
$$;

-- ---------------------------------------------------------------------------
-- P2-07 — THE APPROVAL TRANSACTION.
--
-- Writes to five tables and must be atomic. A half-approved request — status
-- changed, no task created — is the kind of bug that erodes trust permanently
-- and sends the team back to ClickUp (R9). A plpgsql function body is one
-- transaction, so a raise anywhere below rolls back everything above it. This is
-- exactly why it is not four calls orchestrated from a server action.
--
-- P2-03 rides along: the TL may adjust the date and correct typos in the title
-- and description while approving. BOTH dates survive — `target_date` is what
-- the client asked for and `approved_target_date` is what was negotiated, and
-- that delta is the only evidence that Gate 1 is working rather than
-- rubber-stamping.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_approve_request(
  p_request_id           uuid,
  p_assignee_id          uuid,
  p_qa_assignee_id       uuid,
  p_approved_target_date date default null,
  p_title                text default null,
  p_description          text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request       vizserve_pms_requests;
  v_department_id uuid;
  v_before        jsonb;
  v_task_id       uuid;
  v_title         text;
  v_description   text;
  v_due           date;
  v_reference     text;
begin
  select r.* into v_request
    from vizserve_pms_requests r
   where r.id = p_request_id
   for update;

  if v_request.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  -- Only a request actually awaiting review can be approved. Without this, two
  -- Team Leaders clicking Approve seconds apart both succeed, and the second one
  -- silently reassigns the first one's task. The row lock above plus this check
  -- makes the second call fail with a sentence.
  if v_request.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_request.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  select f.department_id into v_department_id
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  -- The engine call. It re-checks scope itself, so this function does not, and
  -- there is exactly one place where "may this person decide" is answered.
  perform vizserve_pms_record_decision(
    'request', p_request_id, v_department_id, 'approved', null
  );

  -- The PIC and QA must belong to the department the work is for. A TL who leads
  -- two departments could otherwise assign VizBytes work to a VizMedia member,
  -- who would then hold a task their own TL cannot see.
  if p_assignee_id is null then
    raise exception 'Choose who will do the work.' using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_assignee_id and u.is_active and u.primary_department_id = v_department_id
  ) then
    raise exception 'That assignee is not an active member of this department.'
      using errcode = 'check_violation';
  end if;

  if p_qa_assignee_id is not null and not exists (
    select 1 from vizserve_pms_users u
     where u.id = p_qa_assignee_id and u.is_active
       and (u.primary_department_id = v_department_id
            or vizserve_pms_manages_department_for(u.id, v_department_id))
  ) then
    raise exception 'That QA reviewer is not available for this department.'
      using errcode = 'check_violation';
  end if;

  v_before := to_jsonb(v_request);

  -- Null means "no change", empty means the TL cleared it — and an empty title
  -- is not an edit anybody meant to make.
  v_title       := coalesce(nullif(btrim(coalesce(p_title, '')), ''), v_request.title);
  v_description := coalesce(nullif(btrim(coalesce(p_description, '')), ''), v_request.description);
  v_due         := coalesce(p_approved_target_date, v_request.target_date);

  update vizserve_pms_requests
     set status               = 'APPROVED',
         approved_target_date = v_due,
         title                = v_title,
         description          = v_description,
         reviewed_by          = auth.uid(),
         reviewed_at          = now()
   where id = p_request_id
  returning reference_no into v_reference;

  insert into vizserve_pms_tasks (
    request_id, department_id, title, description, status,
    assignee_id, qa_assignee_id, due_date, field_values, created_by
  ) values (
    p_request_id, v_department_id, v_title, v_description, 'OPEN',
    p_assignee_id, p_qa_assignee_id, v_due, v_request.field_values, auth.uid()
  )
  returning id into v_task_id;

  -- Every edit recorded with before and after. This is the negotiation evidence
  -- — without it, "the TL moved the date" is unprovable.
  perform vizserve_pms_write_audit_log(
    'request', p_request_id, 'approved', auth.uid(), v_before,
    jsonb_build_object(
      'status', 'APPROVED',
      'approved_target_date', v_due,
      'original_target_date', v_request.target_date,
      'title', v_title,
      'description', v_description,
      'task_id', v_task_id,
      'assignee_id', p_assignee_id,
      'qa_assignee_id', p_qa_assignee_id
    )
  );

  perform vizserve_pms_notify(
    p_assignee_id,
    'assigned',
    'Assigned to you: ' || v_reference,
    v_title,
    'task',
    v_task_id,
    '/tasks/' || v_task_id::text
  );

  -- The QA reviewer is told now, at assignment, not when the task reaches
  -- FOR_QA. Knowing you are on the hook for a review is what lets you plan
  -- around it; being told the moment it lands is what makes it a fire drill.
  if p_qa_assignee_id is not null and p_qa_assignee_id <> p_assignee_id then
    perform vizserve_pms_notify(
      p_qa_assignee_id,
      'qa_requested',
      'You are QA on ' || v_reference,
      v_title,
      'task',
      v_task_id,
      '/tasks/' || v_task_id::text
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'task_id', v_task_id,
    'reference_no', v_reference,
    'approved_target_date', v_due
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- P2-08 / P2-09 — return and reject.
--
-- One function, because the two differ only in terminality and in the sentence
-- the requester reads. Both REQUIRE a reason; the engine enforces it and the
-- table constraint enforces it again.
--
-- No task is created and no notification is written here: the person who needs
-- telling is the CLIENT, who has no account and therefore no inbox row to write.
-- The email is sent from the server action, which returns the address to write
-- to. That asymmetry is the reason this function returns the requester's details
-- rather than just an ok.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_decide_request(
  p_request_id uuid,
  p_decision   vizserve_pms_approval_decision,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_request       vizserve_pms_requests;
  v_department_id uuid;
  v_before        jsonb;
  v_status        vizserve_pms_request_status;
begin
  if p_decision = 'approved' then
    raise exception 'Use vizserve_pms_approve_request to approve.'
      using errcode = 'invalid_parameter_value';
  end if;

  select r.* into v_request
    from vizserve_pms_requests r
   where r.id = p_request_id
   for update;

  if v_request.id is null then
    raise exception 'That request no longer exists.' using errcode = 'no_data_found';
  end if;

  if v_request.status <> 'PENDING_REVIEW' then
    raise exception 'That request has already been %.', lower(v_request.status::text)
      using errcode = 'invalid_parameter_value';
  end if;

  select f.department_id into v_department_id
    from vizserve_pms_forms f
   where f.id = v_request.form_id;

  perform vizserve_pms_record_decision(
    'request', p_request_id, v_department_id, p_decision, p_reason
  );

  v_before := to_jsonb(v_request);
  v_status := case p_decision when 'returned' then 'RETURNED' else 'REJECTED' end;

  update vizserve_pms_requests
     set status          = v_status,
         decision_reason = btrim(p_reason),
         reviewed_by     = auth.uid(),
         reviewed_at     = now()
   where id = p_request_id;

  perform vizserve_pms_write_audit_log(
    'request', p_request_id, lower(v_status::text), auth.uid(), v_before,
    jsonb_build_object('status', v_status, 'reason', btrim(p_reason))
  );

  return jsonb_build_object(
    'ok', true,
    'status', v_status,
    'reference_no', v_request.reference_no,
    'requester_email', v_request.requester_email,
    'requester_name', v_request.requester_name,
    'title', v_request.title
  );
end;
$$;

grant execute on function vizserve_pms_manages_department_for(uuid, uuid) to authenticated;
grant execute on function vizserve_pms_approve_request(uuid, uuid, uuid, date, text, text) to authenticated;
grant execute on function vizserve_pms_decide_request(uuid, vizserve_pms_approval_decision, text) to authenticated;
