-- P11-11 — a reliever can be anybody, and can then see what they agreed to hold.
--
-- "For assigning relievers make it for all members, not scoped by department"
-- — Amier, 9 Sep. P9-01 scoped the picker and the submit function to the
-- requester's own department. Work does not divide that neatly: the person who
-- can actually hold your accounts for a week is often the one you already work
-- with across a line.
--
-- ⚠️ DROPPING THE CHECK IS ONE LINE AND WOULD HAVE SHIPPED A HALF-FEATURE. A
-- reliever outside the requester's department already reached the REQUEST —
-- p9_01's "internal requests readable by their relievers" asks only whether you
-- are named on it. Three other things they need were still department-scoped,
-- and each one fails quietly rather than loudly:
--
--   1. THE PICKER had nothing to offer. `vizserve_pms_users` is readable to your
--      own department, your managed departments and HR. Removing the `.eq()`
--      filter in `approvals/page.tsx` would have changed nothing, because RLS
--      was the filter.
--   2. THE REQUESTER'S NAME rendered blank on the reliever's own screen. They
--      would be asked to cover a week of work for somebody the page could not
--      name.
--   3. THE TASKS THEY ARE TAKING were invisible. The reliever row carries task
--      ids; the titles come from `vizserve_pms_tasks`, which a non-member
--      cannot read. A hand-over screen listing nothing is an approval nobody
--      can give honestly.
--
-- Four parts below, and 2 and 3 are the reason this is not a one-line file.
--
-- ⚠️ THE TWO NEW POLICIES ARE SCOPED TO THE HAND-OVER AND NOTHING ELSE. Neither
-- says "a reliever may see other departments"; both say "a reliever may see the
-- person and the tasks named on a request they are a reliever on". A cross-
-- department reliever gains sight of exactly the rows the hand-over is about,
-- and reverts to seeing nothing extra the moment they are not on one.


-- ---------------------------------------------------------------------------
-- 1. THE PICKER'S OPTIONS.
--
-- A `security definer` function rather than a wider policy on
-- `vizserve_pms_users`, and that is the whole point: this returns TWO COLUMNS.
-- Opening the table instead would expose email, gender, role, `is_hr`,
-- `is_dept_admin` and `app_access` to everybody, to populate a dropdown.
--
-- ⚠️ NOT `security invoker`. The caller is usually a plain member whose reach
-- stops at their own department, which is the situation this exists to solve.
--
-- Themselves excluded, matching what the submit function refuses further down
-- and what the old query did with `.neq("id", auth.uid())`.
--
-- ⚠️ AND NOBODY WITHOUT A DEPARTMENT. The join is inner on purpose. An
-- unfiled account has no team behind it to absorb the work if the hand-over
-- goes wrong, and the picker groups its options under a department heading —
-- so such a person would need a heading that says nothing.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_reliever_candidates()
returns table (id uuid, full_name text, department_id uuid, department_name text)
language sql
stable
security definer
set search_path = public, extensions
as $fn$
  select u.id, u.full_name, d.id, d.name
    from vizserve_pms_users u
    -- INNER, and that is the filter. Somebody with no department is not
    -- offered: there is no team behind them to absorb the work if the
    -- hand-over goes wrong, and the picker groups by department, so an
    -- unfiled person would need a heading that says nothing.
    join vizserve_pms_departments d on d.id = u.primary_department_id
   where u.is_active
     and d.is_active
     and u.id <> auth.uid()
     -- The same app-access gate every other capability check applies. Somebody
     -- whose access to this product was revoked is not a candidate to hold
     -- somebody else's work in it.
     and 'vizserve-pms' = any(u.app_access)
   -- Department first: the picker draws a heading per team, and ordering it
   -- here means the component groups by walking the list once instead of
   -- sorting a map whose key order is not guaranteed.
   order by d.name, u.full_name;
$fn$;

revoke all on function vizserve_pms_reliever_candidates() from public, anon;
grant execute on function vizserve_pms_reliever_candidates() to authenticated;

comment on function vizserve_pms_reliever_candidates() is
  'P11-11. Every active account except the caller that HAS a department, as name and '
  'team only. Feeds the reliever picker, which is no longer department-scoped but '
  'groups by department. SECURITY DEFINER because the caller is usually a member who '
  'cannot read outside their own department.';


-- ---------------------------------------------------------------------------
-- 2. THE NAME ON THE OTHER SIDE OF A HAND-OVER.
--
-- Symmetric on purpose, and it has to be: the requester needs the reliever's
-- name on their own request, and the reliever needs the requester's. One
-- predicate answers both, so the two halves cannot drift.
--
-- ⚠️ `security definer`, because the function reads the very tables whose
-- policies would otherwise have to admit the reader first — the circularity
-- p9_08 and p11_01 both hit and solved the same way.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_shares_a_handover_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $fn$
  select exists (
    -- They are a reliever on a request of mine.
    select 1
      from vizserve_pms_internal_requests r
      join vizserve_pms_internal_request_relievers rl on rl.request_id = r.id
     where r.requester_id = auth.uid()
       and rl.reliever_id = p_user_id
    union all
    -- Or I am a reliever on a request of theirs.
    select 1
      from vizserve_pms_internal_requests r
      join vizserve_pms_internal_request_relievers rl on rl.request_id = r.id
     where r.requester_id = p_user_id
       and rl.reliever_id = auth.uid()
    union all
    -- Or we are both relievers on the same request, which is how a three-way
    -- hand-over renders its own list of who else is covering what.
    select 1
      from vizserve_pms_internal_request_relievers mine
      join vizserve_pms_internal_request_relievers theirs
        on theirs.request_id = mine.request_id
     where mine.reliever_id = auth.uid()
       and theirs.reliever_id = p_user_id
  );
$fn$;

revoke all on function vizserve_pms_shares_a_handover_with(uuid) from public, anon;
grant execute on function vizserve_pms_shares_a_handover_with(uuid) to authenticated;

-- ADDITIVE. Postgres ORs permissive policies, so every existing rule on this
-- table is untouched and nobody loses a row.
drop policy if exists "users readable across a handover" on vizserve_pms_users;

create policy "users readable across a handover"
  on vizserve_pms_users for select to authenticated
  using (vizserve_pms_shares_a_handover_with(id));


-- ---------------------------------------------------------------------------
-- 3. THE TASKS A RELIEVER IS COVERING.
--
-- ⚠️ THE NARROWEST WIDENING THAT MAKES THE SCREEN HONEST, and it is worth being
-- precise about what it is not. It does NOT admit a reliever to the
-- department's work, or to the requester's other tasks. It admits exactly the
-- rows named on a reliever line they are on — the ones they are being asked to
-- hold. Stop being a reliever and the rows go again.
--
-- P7-17's rule that a colleague sees their department's shared work is
-- untouched. This is a fourth route to a specific set of rows, not a fifth
-- reading of "who is in what team".
-- ---------------------------------------------------------------------------
drop policy if exists "tasks readable by a reliever covering them" on vizserve_pms_tasks;

create policy "tasks readable by a reliever covering them"
  on vizserve_pms_tasks for select to authenticated
  using (
    exists (
      select 1
        from vizserve_pms_internal_request_reliever_tasks rt
        join vizserve_pms_internal_request_relievers rl on rl.id = rt.reliever_row_id
       where rt.task_id = vizserve_pms_tasks.id
         and rl.reliever_id = auth.uid()
    )
  );


-- ---------------------------------------------------------------------------
-- 4. THE SUBMIT FUNCTION, REPRODUCED WHOLE.
--
-- ⚠️ REPRODUCED RATHER THAN PATCHED, because that is the only safe way to
-- change one line of a function this schema redefines across several files.
-- Re-pasting an older migration silently reinstates an older rule and nothing
-- raises — the trap `may_log_time` and `transition_task` are both in. THIS IS
-- NOW THE LIVE DEFINITION.
--
-- One line differs from p9_03: the reliever check drops
-- `and u.primary_department_id = v_department`. Everything else — the
-- three-reliever ceiling, the no-duplicates rule, one-task-one-reliever, the
-- turn-over attestation and the whole approval-stage calculation — is
-- character for character what it was.
--
-- ⚠️ `v_department` IS STILL READ AND STILL REQUIRED. It is the REQUESTER's
-- department and it decides who approves the request, which has not changed:
-- leave still goes to the requester's own team leader and then a manager. Only
-- who may be NAMED as a reliever has widened.
-- ---------------------------------------------------------------------------

create or replace function vizserve_pms_submit_internal_request(
  p_request_type    vizserve_pms_internal_request_type,
  p_reason          text,
  p_start_date      date default null,
  p_end_date        date default null,
  p_work_date       date default null,
  -- Wall-clock time on p_work_date, e.g. '08:00'. Combined with the date in
  -- Manila below; the client never sends an instant.
  p_correction_time time default null,
  p_amount          numeric default null,
  p_overtime_minutes integer default null,
  p_leave_type_id   uuid default null,
  p_start_half      vizserve_pms_day_half default 'MORNING',
  p_end_half        vizserve_pms_day_half default 'AFTERNOON',
  -- P9-03. `[{ "reliever_id": uuid, "task_ids": [uuid, ...] }, ...]`
  --
  -- JSONB rather than two parallel arrays because the shape is a nesting, and
  -- `uuid[]` plus `uuid[][]` would make "which tasks belong to which reliever"
  -- a matter of index alignment between two parameters — the kind of implicit
  -- contract that survives exactly until somebody filters one of them.
  p_relievers       jsonb default null,
  p_turnover_confirmed boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user       uuid := auth.uid();
  v_department uuid;
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_correction timestamptz;
  v_id         uuid;
  v_approver   record;
  v_name       text;
  -- P9-03
  v_requires_reliever boolean := false;
  v_relievers  jsonb;
  v_count      integer;
  v_stage      smallint := 0;
  v_entry      record;
  v_task       record;
  v_reliever   uuid;
  v_row_id     uuid;
  v_tasks      integer;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = 'insufficient_privilege';
  end if;

  select u.primary_department_id, u.full_name into v_department, v_name
    from vizserve_pms_users u
   where u.id = v_user and u.is_active;

  if v_name is null then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;

  if v_department is null then
    raise exception 'You have no department set, so there is nobody to approve this. Ask an admin to set your department.'
      using errcode = 'check_violation';
  end if;

  if v_reason is null then
    raise exception 'Say why you are requesting this.' using errcode = 'check_violation';
  end if;

  if p_request_type = 'LEAVE' then
    if p_leave_type_id is null then
      raise exception 'Choose what kind of leave this is.' using errcode = 'check_violation';
    end if;

    -- P9-03 reads `requires_reliever` off the same row P7-12 already checks for
    -- `is_active`, so this is one lookup rather than two.
    select lt.requires_reliever into v_requires_reliever
      from vizserve_pms_leave_types lt
     where lt.id = p_leave_type_id and lt.is_active;

    if v_requires_reliever is null then
      raise exception 'That leave type is no longer available. Pick one from the list.'
        using errcode = 'check_violation';
    end if;

    -- P7-16. The constraint says the same thing, but a constraint violation
    -- reads as a constraint name. This is the sentence somebody can act on.
    if p_start_date = p_end_date and p_start_half > p_end_half then
      raise exception 'Leave on one day cannot start in the afternoon and end in the morning.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- ⚠️ P7-39: all four correction types compose an instant the same way and
  -- refuse the future the same way.
  if p_request_type in (
    'NO_TIME_IN', 'NO_TIME_OUT', 'TIME_IN_CORRECTION', 'TIME_OUT_CORRECTION'
  ) then
    if p_work_date is null or p_correction_time is null then
      raise exception 'A correction needs the date and the time it should have been.'
        using errcode = 'check_violation';
    end if;

    v_correction := (p_work_date::text || ' ' || p_correction_time::text)::timestamp
                    at time zone 'Asia/Manila';

    if v_correction > now() then
      raise exception 'You cannot correct a time that has not happened yet.'
        using errcode = 'check_violation';
    end if;
  end if;

  if p_request_type = 'OVERTIME' then
    if p_work_date is null or p_overtime_minutes is null then
      raise exception 'Overtime needs the day and how long it ran.'
        using errcode = 'check_violation';
    end if;

    if p_work_date > (now() at time zone 'Asia/Manila')::date then
      raise exception 'Pick the day the overtime was or is being worked, not a future one.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- =========================================================================
  -- P9-03 — THE RELIEVER PAYLOAD.
  --
  -- Validated in full BEFORE the request row is inserted, so a request that
  -- fails any rule below leaves nothing behind at all. Everything here raises,
  -- and a raise in a plpgsql body rolls the whole function back — the same
  -- property vizserve_pms_approve_request relies on.
  --
  -- Every message is a SENTENCE. A person filling this in has just picked three
  -- colleagues and a dozen tasks off two dropdowns, and "violates check
  -- constraint vizserve_pms_reliever_..." tells them nothing about which one to
  -- change.
  -- =========================================================================

  -- Ignored rather than refused when the type does not want them. The client
  -- can send a stale array after somebody switches the leave type in the dialog,
  -- and refusing that is a worse error message than dropping it — the same call
  -- `leave_type_id` and the two halves already make for the other types.
  v_relievers := case
    when p_request_type = 'LEAVE' and coalesce(v_requires_reliever, false)
    then coalesce(p_relievers, '[]'::jsonb)
    else '[]'::jsonb
  end;

  if jsonb_typeof(v_relievers) <> 'array' then
    raise exception 'The reliever list is malformed.' using errcode = 'check_violation';
  end if;

  select count(*) into v_count from jsonb_array_elements(v_relievers);

  if coalesce(v_requires_reliever, false) then
    if v_count = 0 then
      raise exception 'This kind of leave needs a reliever. Add at least one.'
        using errcode = 'check_violation';
    end if;

    -- Three is Amier's ceiling. Past that the turn-over is not a hand-over, it
    -- is a redistribution, and it wants a conversation rather than a form.
    if v_count > 3 then
      raise exception 'Name at most three relievers.' using errcode = 'check_violation';
    end if;

    -- THE ATTESTATION IS A GATE, not a formality. The whole reliever block is
    -- the requester asserting that the critical work is listed and covered;
    -- without the tick, nobody has asserted anything and the three people below
    -- are being asked to approve a claim that was never made.
    if not coalesce(p_turnover_confirmed, false) then
      raise exception 'Confirm the turn-over before submitting.' using errcode = 'check_violation';
    end if;
  end if;

  -- The same person listed twice is not two approvals. The unique index would
  -- refuse it, but as a constraint name.
  if v_count <> (
    select count(distinct e.value ->> 'reliever_id') from jsonb_array_elements(v_relievers) e
  ) then
    raise exception 'That person is already listed as a reliever.' using errcode = 'check_violation';
  end if;

  -- One task, one reliever. Two people "covering" the same task is nobody
  -- covering it, and the coverage badge would have to name two.
  if (
    select count(*) from jsonb_array_elements(v_relievers) e,
         jsonb_array_elements_text(e.value -> 'task_ids') t
  ) <> (
    select count(distinct t.value) from jsonb_array_elements(v_relievers) e,
         jsonb_array_elements_text(e.value -> 'task_ids') t
  ) then
    raise exception 'Each task can only go to one reliever.' using errcode = 'check_violation';
  end if;

  insert into vizserve_pms_internal_requests (
    request_type, requester_id, department_id, reason,
    start_date, end_date, work_date, correction_at, amount, overtime_minutes,
    leave_type_id, start_half, end_half,
    approval_stage, turnover_confirmed_at
  ) values (
    p_request_type, v_user, v_department, v_reason,
    p_start_date, p_end_date, p_work_date, v_correction, p_amount, p_overtime_minutes,
    case when p_request_type = 'LEAVE' then p_leave_type_id else null end,
    -- Coerced to null for every other type: the constraint would refuse a stray
    -- value, but refusing a request because the client sent a field it had no
    -- business sending is a worse error message than ignoring it.
    case when p_request_type = 'LEAVE' then coalesce(p_start_half, 'MORNING') else null end,
    case when p_request_type = 'LEAVE' then coalesce(p_end_half, 'AFTERNOON') else null end,
    -- ⚠️ THE ONE LINE THAT DECIDES THE WHOLE WORKFLOW.
    --
    --   non-leave  -> 0, decided once by any lead, exactly as before
    --   leave      -> 2, team leader then manager
    --   + reliever -> 1, the relievers first
    --
    -- If the chain should ever cover overtime or reimbursement too, THIS is the
    -- expression that changes and nothing else in these four migrations does.
    case
      when p_request_type <> 'LEAVE' then 0
      when coalesce(v_requires_reliever, false) then 1
      else 2
    end,
    case when v_count > 0 then now() else null end
  )
  returning id into v_id;

  -- -------------------------------------------------------------------------
  -- The reliever rows, and the per-person rules.
  --
  -- These run AFTER the insert because the task links need the request id, and
  -- that is safe: a raise below still rolls the request row back with them.
  -- -------------------------------------------------------------------------
  for v_entry in select value as payload from jsonb_array_elements(v_relievers) loop
    v_reliever := nullif(v_entry.payload ->> 'reliever_id', '')::uuid;

    if v_reliever is null then
      raise exception 'Choose a reliever, or remove the empty row.' using errcode = 'check_violation';
    end if;

    -- The rule Amier gave: your own department, and never yourself. Checked
    -- separately from the department test so "you cannot be your own reliever"
    -- is not answered with "pick somebody from your own department", which is
    -- technically true and completely unhelpful.
    if v_reliever = v_user then
      raise exception 'You cannot be your own reliever.' using errcode = 'check_violation';
    end if;

    -- P11-11 — ANY ACTIVE COLLEAGUE, NOT ONLY YOUR OWN DEPARTMENT.
    --
    -- This read `and u.primary_department_id = v_department` and refused with
    -- "Pick a reliever from your own department." Work does not divide that
    -- neatly: the person who can actually hold your accounts for a week is
    -- often the one you already work with across a line, and a rule that says
    -- otherwise gets satisfied by naming somebody who will not do it.
    --
    -- `is_active` is the whole of the check now. The three other rules on this
    -- block are untouched and are the ones doing the real work: at most three
    -- relievers, no duplicates, and one task to one reliever.
    if not exists (
      select 1 from vizserve_pms_users u
       where u.id = v_reliever and u.is_active
    ) then
      raise exception 'That person is not an active account.' using errcode = 'check_violation';
    end if;

    insert into vizserve_pms_internal_request_relievers (request_id, reliever_id)
    values (v_id, v_reliever)
    returning id into v_row_id;

    v_tasks := 0;

    for v_task in
      select value::uuid as task_id from jsonb_array_elements_text(v_entry.payload -> 'task_ids')
    loop
      -- ⚠️ THE AUTHORITY CHECK, and it is `is_on_task` rather than
      -- `assignee_id = v_user`. Since P7-13 a person can be on a task through
      -- vizserve_pms_task_assignees without being the PIC, and that work is
      -- just as much theirs to hand over. Testing the PIC column alone would
      -- silently make half of somebody's workload un-handoverable.
      --
      -- Note this is NOT restricted to the requester's own department. The task
      -- may belong to another team; it is the requester's work either way, and
      -- they are the one delegating it.
      if not vizserve_pms_is_on_task(v_task.task_id, v_user) then
        raise exception 'You are not on one of the tasks you tried to hand over.'
          using errcode = 'check_violation';
      end if;

      if exists (
        select 1 from vizserve_pms_tasks t
         where t.id = v_task.task_id
           and t.status in ('COMPLETED', 'COMPLETED_NO_RESPONSE')
      ) then
        raise exception 'One of those tasks is already finished — it needs no reliever.'
          using errcode = 'check_violation';
      end if;

      insert into vizserve_pms_internal_request_reliever_tasks (reliever_row_id, task_id)
      values (v_row_id, v_task.task_id);

      v_tasks := v_tasks + 1;
    end loop;

    -- A reliever with no work is a name on a form and an approval nobody can
    -- reason about. The point of the stage is that the person taking the tasks
    -- agrees to take THOSE tasks.
    if v_tasks = 0 then
      raise exception 'Give every reliever at least one task.' using errcode = 'check_violation';
    end if;
  end loop;

  -- Six arguments. `v_user` is the ACTOR (fourth), `null` the before-image
  -- (fifth), the payload the after-image (sixth). Repaired in P7-16a; restated
  -- here because this file replaces the whole body.
  perform vizserve_pms_write_audit_log(
    'internal_request', v_id, 'submitted', v_user, null,
    jsonb_build_object(
      'request_type', p_request_type,
      'department_id', v_department,
      -- P9-03. The turn-over is an attestation, so what was attested to is part
      -- of the record and not only the fact that a box was ticked.
      'approval_stage', case
        when p_request_type <> 'LEAVE' then 0
        when coalesce(v_requires_reliever, false) then 1
        else 2
      end,
      'relievers', v_relievers
    )
  );

  -- =========================================================================
  -- WHO HEARS ABOUT IT, which now depends on where the request starts.
  -- =========================================================================
  if v_count > 0 then
    -- Stage 1. THE LEADS ARE NOT TOLD YET, and that is the point: a request
    -- sitting in a lead's queue that they are not yet allowed to decide is
    -- worse than no notification, because the only way to find that out is to
    -- open it and be refused.
    for v_approver in
      select r.reliever_id as user_id
        from vizserve_pms_internal_request_relievers r
       where r.request_id = v_id
    loop
      perform vizserve_pms_notify(
        v_approver.user_id,
        'pending_approval',
        v_name || ' asked you to cover their work',
        v_reason,
        'internal_request',
        v_id,
        '/approvals/' || v_id::text
      );
    end loop;
  else
    -- ⚠️ THE BLOCK P7-16b EXISTS FOR — reproduced verbatim. Rewriting a
    -- function body is how it was lost twice: the type must be
    -- 'pending_approval' (nothing else is in the enum), the recipient
    -- `md.user_id`, and the title "<type> request from <name>".
    --
    -- Everyone who leads the requester's department hears about it. Not one
    -- nominated approver: a queue with a single named owner stalls the moment
    -- that person is on leave, which for a leave-request module is not a corner
    -- case.
    --
    -- The notification says "leave request from X" and NOT which kind. The type
    -- is on the request for the lead who opens it; it does not belong in a title
    -- that may surface on a lock screen. Same instinct as P7-10.
    --
    -- This is now the stage-0 AND stage-2 path — non-reliever leave lands with
    -- the leads exactly as it always did. Only the third stage is new to them,
    -- and they never see it.
    for v_approver in
      select md.user_id
        from vizserve_pms_user_managed_departments md
        join vizserve_pms_users u on u.id = md.user_id
       where md.department_id = v_department
         and u.is_active
         and u.id <> v_user
    loop
      perform vizserve_pms_notify(
        v_approver.user_id,
        'pending_approval',
        replace(p_request_type::text, '_', ' ') || ' request from ' || v_name,
        v_reason,
        'internal_request',
        v_id,
        '/approvals/' || v_id::text
      );
    end loop;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;
