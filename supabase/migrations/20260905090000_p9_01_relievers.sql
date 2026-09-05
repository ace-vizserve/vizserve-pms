-- P9-01 — RELIEVERS, COVERAGE, AND THE LEAVE-TYPE FLAG.
--
-- Leave today is one flat decision: any one lead of the requester's department
-- approves it and that is the end of it. Nothing anywhere records who holds that
-- person's work while they are away — `grep -ri reliever` returned zero hits
-- across this entire repo before this file.
--
-- Two changes land together over the next four migrations:
--
--   1. EVERY leave request now needs two approvals — the department's team
--      leader, then a manager. Not just reliever leave. Amier, 4 Sep.
--   2. Leave types HR marks as needing a reliever gain a THIRD stage in front
--      of those two: the people taking the work over have to agree to take it.
--
-- THIS FILE IS DATA AND ACCESS ONLY. It adds the columns and tables the chain
-- hangs from, and the one clause that lets a reliever reach the tasks they are
-- covering. The chain itself is P9-03 (submit) and P9-04 (decide), and nothing
-- here changes the behaviour of a single existing request: every column added
-- is nullable or defaults to the value that means "as before".
--
-- WHAT THIS DELIBERATELY IS NOT: a generic approval-chain engine. There is no
-- step table, no rule resolver, no chain abstraction. The stage is ONE SMALLINT
-- on the request, the relievers' decisions live on the reliever rows, and
-- stages 2 and 3 need no rows at all because "leads this department" and "is a
-- manager" are questions this schema already answers. The first draft of this
-- built a generic step layer with named and ruled rows; it was three times the
-- size and bought nothing that a number in a column does not.

-- ---------------------------------------------------------------------------
-- Which leave types need a reliever.
--
-- A COLUMN ON THE TYPE, not a hardcoded test for the code 'VACATION'. P7-12
-- made leave types a table rather than an enum precisely because the list is
-- POLICY DATA that HR changes — and "does this kind of leave need somebody to
-- cover it" is policy of exactly the same weight. Turning it on for Maternity
-- next quarter should be a tick on /hr/leave-types, not a migration.
--
-- Same call P7-45 made for `applies_to_gender`.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_leave_types
  add column requires_reliever boolean not null default false;

comment on column vizserve_pms_leave_types.requires_reliever is
  'P9-01. When true, a request of this type must name 1-3 relievers, assign '
  'each of them at least one of the requester''s open tasks, and carry the '
  'turn-over confirmation. Those relievers become approval stage 1. Enforced '
  'in vizserve_pms_submit_internal_request, not by a constraint — the rule '
  'spans two tables.';

-- Vacation only, which is where Amier started. Everything else keeps the
-- two-stage lead -> manager path.
update vizserve_pms_leave_types set requires_reliever = true where code = 'VACATION';

-- ---------------------------------------------------------------------------
-- The stage, and the attestation.
--
-- `approval_stage` IS THE WHOLE CHAIN:
--
--   0  no chain. Every non-LEAVE type — overtime, reimbursement, the four
--      corrections — keeps today's single decision by any one lead. This is the
--      default, so every row that already exists reads as unchained and every
--      code path that does not know about stages behaves exactly as it did.
--   1  waiting on the relievers. All of them, individually.
--   2  waiting on a team leader of the department.
--   3  waiting on a manager, company-wide.
--
-- Leave OPENS AT 1 OR AT 2 depending on its type, and from stage 2 on there is
-- one path. That is the reason this is a number and not two booleans or a
-- table per shape: reliever leave is not a different workflow, it is the same
-- workflow started one stage earlier.
--
-- SMALLINT, NOT AN ENUM, and that is a deliberate exception to this schema's
-- own habit. Three migrations here have had to be split in two because Postgres
-- forbids using a new enum value in the transaction that adds it, and a stage
-- is ordered — `> 0`, `= 2`, `+ 1` are all meaningful and all free on an
-- integer. The labels live in one map in lib/schemas/internal-requests.ts.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_internal_requests
  add column approval_stage smallint not null default 0,
  add column turnover_confirmed_at timestamptz;

comment on column vizserve_pms_internal_requests.approval_stage is
  'P9-01. 0 = no chain (every non-LEAVE type, decided once by any lead). '
  '1 = relievers, 2 = team leader, 3 = manager. Leave opens at 1 when its type '
  'requires a reliever and at 2 when it does not. Advanced only by '
  'vizserve_pms_decide_internal_request.';

comment on column vizserve_pms_internal_requests.turnover_confirmed_at is
  'P9-01. When the requester ticked the turn-over confirmation. NULL on every '
  'request that never needed one. A timestamp rather than a boolean because '
  'this is an attestation — when somebody said it is part of what they said.';

alter table vizserve_pms_internal_requests
  add constraint vizserve_pms_internal_requests_stage_range
    check (approval_stage between 0 and 3);

-- A stage only means anything on leave. A reimbursement sitting at stage 2
-- would be waiting on a queue no screen builds.
--
-- NOT VALID is unnecessary here — every existing row is at 0 and satisfies it —
-- but the constraint is stated anyway so a future request type that grows a
-- chain has to come back to this line and say so.
alter table vizserve_pms_internal_requests
  add constraint vizserve_pms_internal_requests_stage_is_leave
    check (approval_stage = 0 or request_type = 'LEAVE');

-- ---------------------------------------------------------------------------
-- The relievers.
--
-- ONE ROW PER PERSON PER REQUEST, carrying that person's own decision. This is
-- what makes stage 1 an AND rather than an OR: the stage passes when no row is
-- left undecided, and that test is a `count(*) where decision is null`.
--
-- The decision lives HERE rather than in vizserve_pms_approvals on purpose.
-- That table's `department_id` means "the department whose work this decision
-- was made on behalf of", and its policy is written in those terms. A reliever
-- is not approving for a department; they are agreeing to take four named
-- tasks. Recording it as a departmental approval would make the Phase 6
-- turnaround reports count each reliever as an approver of the leave, which is
-- not what happened.
-- ---------------------------------------------------------------------------
create table vizserve_pms_internal_request_relievers (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references vizserve_pms_internal_requests (id) on delete cascade,
  -- `restrict`, matching requester_id: a person who has agreed to cover work
  -- cannot be deleted out of the record of having agreed. Deactivation is what
  -- `is_active` is for.
  reliever_id uuid not null references vizserve_pms_users (id) on delete restrict,

  -- NULL until they answer. Reuses the Phase 2 decision enum rather than a
  -- boolean so a reliever's "no" reads the same as every other no in this app.
  -- 'returned' is never written here — same posture as internal requests.
  decision    vizserve_pms_approval_decision,
  decided_at  timestamptz,
  reason      text,

  created_at  timestamptz not null default now(),

  -- The same person twice is not two approvals, and would make the stage
  -- impossible to complete honestly.
  unique (request_id, reliever_id),

  constraint vizserve_pms_reliever_decided_together
    check ((decision is null) = (decided_at is null)),

  -- The engine's rule, restated where the row lives: a refusal nobody explained
  -- is unactionable, and this is the one place a refusal is written without
  -- passing through vizserve_pms_record_decision.
  constraint vizserve_pms_reliever_reason_required
    check (
      decision is null
      or decision = 'approved'
      or (reason is not null and length(btrim(reason)) > 0)
    )
);

create index vizserve_pms_internal_request_relievers_request_idx
  on vizserve_pms_internal_request_relievers (request_id);
-- Read on every RLS check for a covered task, and by the approvals queue for
-- "what is waiting on me". Both are lookups by person.
create index vizserve_pms_internal_request_relievers_reliever_idx
  on vizserve_pms_internal_request_relievers (reliever_id);

create table vizserve_pms_internal_request_reliever_tasks (
  reliever_row_id uuid not null
    references vizserve_pms_internal_request_relievers (id) on delete cascade,
  -- CASCADE, not restrict. A reliever row can therefore end up holding no tasks
  -- if the last one is deleted mid-leave, and that is correct: "at least one
  -- task each" is a rule about what was SUBMITTED, not an invariant to defend
  -- forever. Blocking a task deletion because a colleague is on holiday is the
  -- worse failure of the two.
  task_id uuid not null references vizserve_pms_tasks (id) on delete cascade,
  created_at timestamptz not null default now(),

  primary key (reliever_row_id, task_id)
);

-- The coverage view's join direction, and the task-detail badge's lookup.
create index vizserve_pms_internal_request_reliever_tasks_task_idx
  on vizserve_pms_internal_request_reliever_tasks (task_id);

-- ---------------------------------------------------------------------------
-- RLS on both.
--
-- Readable by the requester, by anyone who leads the request's department, by
-- HR, and BY THE RELIEVER THEMSELVES — that last one is not optional, because a
-- reliever who cannot read the row naming them cannot see what they are being
-- asked to approve.
--
-- No INSERT, UPDATE or DELETE policy on either table. Rows arrive through
-- vizserve_pms_submit_internal_request and are stamped by
-- vizserve_pms_decide_internal_request, both SECURITY DEFINER. Naming somebody
-- as your reliever is a decision with a rule behind it, not a row anybody may
-- write — the same posture vizserve_pms_task_assignees takes.
-- ---------------------------------------------------------------------------
-- ⚠️ BOTH DIRECTIONS GO THROUGH SECURITY DEFINER, AND THEY HAVE TO.
--
-- These two tables need to see each other: the reliever rows are readable by
-- whoever can read the request, and the request is readable by its relievers.
-- Written as plain EXISTS subqueries, that is INFINITE RLS RECURSION — the
-- policy on requests would query relievers, whose policy queries requests, and
-- Postgres does not short-circuit an OR reliably enough to save it. The failure
-- is a stack-depth error on a page that used to work.
--
-- So each side asks its question through a SECURITY DEFINER function, which
-- reads past the other table's policy. Neither function widens anything: they
-- answer exactly the questions the policies would have asked inline.
create or replace function vizserve_pms_may_read_internal_request(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from vizserve_pms_internal_requests r
     where r.id = p_request_id
       and (
         r.requester_id = auth.uid()
         or vizserve_pms_manages_department(r.department_id)
         or vizserve_pms_is_hr()
       )
  );
$$;

grant execute on function vizserve_pms_may_read_internal_request(uuid) to authenticated;

-- The other direction. Named for the question rather than the table so the
-- policy on vizserve_pms_internal_requests reads as a sentence.
create or replace function vizserve_pms_is_reliever_on(p_request_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1 from vizserve_pms_internal_request_relievers r
     where r.request_id = p_request_id and r.reliever_id = p_user_id
  );
$$;

grant execute on function vizserve_pms_is_reliever_on(uuid, uuid) to authenticated;

alter table vizserve_pms_internal_request_relievers enable row level security;
revoke all on vizserve_pms_internal_request_relievers from anon;

create policy "relievers readable with the request"
  on vizserve_pms_internal_request_relievers for select to authenticated
  using (
    reliever_id = auth.uid()
    or vizserve_pms_may_read_internal_request(request_id)
  );

-- ---------------------------------------------------------------------------
-- And the request itself, to its relievers.
--
-- WITHOUT THIS THE WHOLE FEATURE IS UNREACHABLE. A reliever is usually a plain
-- member: not the requester, not a lead of the department, not HR. They would
-- satisfy none of the three existing policies, so the request they are being
-- asked to approve would 404 for them — while the decide function worked
-- perfectly. Exactly the failure shape docs/13:1509 describes: the migration
-- lands, the layer that reaches it does not, and no test notices.
--
-- ADDITIVE. Postgres ORs permissive policies on the same command, so the three
-- existing ones are untouched and nobody loses access.
--
-- NOT limited to stage 1. A reliever who accepted a hand-over keeps sight of
-- the leave they agreed to cover — they need to know the dates they are holding
-- somebody's work, and those are on this row.
-- ---------------------------------------------------------------------------
create policy "internal requests readable by their relievers"
  on vizserve_pms_internal_requests for select to authenticated
  using (vizserve_pms_is_reliever_on(id, auth.uid()));

alter table vizserve_pms_internal_request_reliever_tasks enable row level security;
revoke all on vizserve_pms_internal_request_reliever_tasks from anon;

-- Whoever can see the reliever row can see what that reliever is taking. The
-- EXISTS below is not a no-op: the policy on the relievers table applies inside
-- it, so a row whose reliever row is withheld is withheld too. Any other rule
-- would produce a list of relievers with no work against them, which is the
-- half of the screen that carries the meaning.
create policy "reliever tasks readable with the reliever row"
  on vizserve_pms_internal_request_reliever_tasks for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_internal_request_relievers r
       where r.id = vizserve_pms_internal_request_reliever_tasks.reliever_row_id
    )
  );

-- No explicit grants: 20260729110000_p0_06_grants.sql sets ALTER DEFAULT
-- PRIVILEGES for `authenticated` and `service_role` on tables created later, so
-- these two inherit. Stated because "permission denied for table" is a GRANT
-- diagnosis and never an RLS one.

-- ---------------------------------------------------------------------------
-- COVERAGE — who is holding whose work, right now.
--
-- A VIEW, not a column and not a scheduled job. Coverage is a QUESTION ABOUT
-- TODAY that the leave dates already answer, so it needs nothing written when
-- the leave starts and nothing un-written when it ends. The alternative — a
-- cron that swaps assignee_id on the start date and swaps it back on the end
-- date — rewrites the task's history, loses the original owner, and fails
-- permanently if it misses a night.
--
-- The requester's assignee_id is NEVER touched. The reliever is added to the
-- people who can reach the task, and that is all.
--
-- MANILA, NOT UTC. Coverage starts on the first day of leave and ends on the
-- last, and "which day is it" is a question about the local calendar — a UTC
-- comparison starts and ends coverage several hours early. Same reasoning
-- vizserve_pms_department_capacity applies to "overdue".
--
-- HALF DAYS ARE IGNORED. Leave starting on the AFTERNOON of the 3rd gives
-- coverage for the whole of the 3rd. P7-16 half days matter for counting days
-- off; half-day granularity on who may open a task is noise, and the failure it
-- would prevent — a reliever reading a task four hours early — is not one.
-- ---------------------------------------------------------------------------
create view vizserve_pms_active_task_coverage
with (security_invoker = true)
as
  select
    rt.task_id,
    r.reliever_id,
    r.request_id,
    ir.requester_id as absent_user_id,
    ir.start_date,
    ir.end_date
  from vizserve_pms_internal_request_reliever_tasks rt
  join vizserve_pms_internal_request_relievers r on r.id = rt.reliever_row_id
  join vizserve_pms_internal_requests ir on ir.id = r.request_id
  where ir.status = 'APPROVED'
    and (now() at time zone 'Asia/Manila')::date between ir.start_date and ir.end_date;

comment on view vizserve_pms_active_task_coverage is
  'P9-01. Task coverage in force TODAY, Manila. security_invoker so it is '
  'scoped by the policies on the tables beneath it — the caller sees the '
  'coverage rows they were already entitled to. vizserve_pms_is_on_task reads '
  'it through a SECURITY DEFINER function instead, because an RLS check that '
  'depended on RLS would be circular.';

revoke all on vizserve_pms_active_task_coverage from anon;
grant select on vizserve_pms_active_task_coverage to authenticated;

-- ---------------------------------------------------------------------------
-- The access clause.
--
-- SECURITY DEFINER, and the view above is not — which is the whole reason this
-- function exists rather than vizserve_pms_is_on_task selecting from the view
-- directly. vizserve_pms_is_on_task is called FROM the task policies; if the
-- coverage test were itself policy-scoped, the answer to "may I see this task"
-- would depend on rows I can only see if I may see the task.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_is_covering_task(p_task_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_internal_request_reliever_tasks rt
      join vizserve_pms_internal_request_relievers r on r.id = rt.reliever_row_id
      join vizserve_pms_internal_requests ir on ir.id = r.request_id
     where rt.task_id = p_task_id
       and r.reliever_id = p_user_id
       and ir.status = 'APPROVED'
       and (now() at time zone 'Asia/Manila')::date between ir.start_date and ir.end_date
  );
$$;

grant execute on function vizserve_pms_is_covering_task(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- ONE CLAUSE, AND IT IS THE ENTIRE ACCESS STORY.
--
-- vizserve_pms_is_on_task is already what the task SELECT and UPDATE policies,
-- vizserve_pms_may_log_time, the transition guard and the assignee functions
-- all call. Adding coverage here gives the reliever read, update, comment,
-- time-log and transition rights on exactly the tasks they were handed, for
-- exactly the days of the leave, and takes them away again the following
-- morning — with no other file edited and nothing to run.
--
-- Exactly the move P7-13 made when it added vizserve_pms_task_assignees: the
-- new way of being on a task went into this one function, not into eight
-- policies.
--
-- Body rewritten in full because `create or replace` replaces it; the first two
-- clauses are byte-for-byte the P7-13 original.
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
  )
  -- P9-01. Temporary and self-expiring.
  or vizserve_pms_is_covering_task(p_task_id, p_user_id);
$$;

-- Signature unchanged, so the P7-13 grant still stands and no regrant is needed.

-- ---------------------------------------------------------------------------
-- WHAT DELIBERATELY DOES NOT CHANGE HERE.
--
-- `vizserve_pms_submit_internal_request` and
-- `vizserve_pms_decide_internal_request` are untouched by this file. Every
-- request written today still gets approval_stage 0 and still takes the single
-- decision it always has. P9-03 is the first migration that sets a stage above
-- zero, and P9-04 is the first that reads one.
--
-- That ordering is on purpose: this file can be applied on its own, against the
-- live project, and change nothing anybody can see except a new tick on
-- /hr/leave-types that nothing yet consumes.
-- ---------------------------------------------------------------------------
