-- P9-08 — THE STAGE-3 MANAGER COULD DECIDE A HAND-OVER IT COULD NOT SEE.
--
-- P9-04 gave a manager a SELECT policy on `vizserve_pms_internal_requests` at
-- stage 3, so the final approver can open the request. It did not widen
-- `vizserve_pms_may_read_internal_request`, which P9-01 had already written
-- with three clauses — requester, department lead, HR — and which is what the
-- policy on the RELIEVER rows consults.
--
-- A manager who does not lead the requester's department therefore failed all
-- three (and `vizserve_pms_is_admin()` is `owner` since P8-01b, so a plain
-- manager is not caught there either). What they actually saw on
-- `/approvals/[id]`:
--
--   * no reliever card at all — the block is skipped when the array is empty
--   * STAGE 1 MISSING FROM THE RAIL, because it renders only when there are
--     relievers, so a three-stage request presented itself as a two-stage one
--   * "Requested by —", because the users policy is self-or-own-department
--   * nothing from `vizserve_pms_active_task_coverage`, which is
--     `security_invoker` over the same tables
--
-- The DECISION worked throughout — `vizserve_pms_decide_internal_request` is
-- SECURITY DEFINER — so this was never a permission failure. It was the read
-- direction of the failure this project keeps hitting: the layer that reaches a
-- thing lags the thing itself. The manager was asked to approve a hand-over
-- while being shown none of it.
--
-- ⚠️ SCOPE. Both rules below are written to match the P9-04 policy EXACTLY —
-- stage 3, and either still pending or already decided by this manager. A
-- manager does not gain any view of leave that has not reached them, or of
-- leave somebody else signed. Do not loosen either predicate without loosening
-- that policy in the same breath; they are three statements of one rule.

-- ---------------------------------------------------------------------------
-- 1. The read-scope function the reliever policies consult.
--
-- Body restated in full — `create or replace` replaces it. The first three
-- clauses are byte-for-byte the P9-01 original.
-- ---------------------------------------------------------------------------
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
         -- P9-08. The stage-3 manager, mirroring
         -- "internal requests at final approval readable by managers".
         or (
           r.approval_stage = 3
           and (r.status = 'PENDING_REVIEW' or r.reviewed_by = auth.uid())
           and exists (
             select 1 from vizserve_pms_users u
              where u.id = auth.uid() and u.is_active and u.role >= 'manager'
           )
         )
       )
  );
$$;

-- ---------------------------------------------------------------------------
-- 2. The names.
--
-- `vizserve_pms_users` is self-or-own-department (P7-17), so even with the
-- reliever rows now readable the manager would see a list of uuids: the
-- requester rendering "—" and every reliever "A colleague".
--
-- ⚠️ SECURITY DEFINER, AND IT HAS TO BE. This policy asks a question about
-- `vizserve_pms_internal_requests` and its reliever rows, both of which have
-- policies that ask questions about `vizserve_pms_users`. Written as a plain
-- EXISTS that is mutual recursion; the helper reads past it, exactly as
-- `vizserve_pms_is_reliever_on` and `vizserve_pms_may_read_internal_request`
-- already do for each other.
--
-- It answers only "is this person the requester or a named reliever on a
-- request that is, right now, waiting on me as its final approver" — so it
-- exposes a full name and nothing else, about people whose leave this manager
-- is being asked to sign.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_is_stage3_subject(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_users me
     where me.id = auth.uid()
       and me.is_active
       and me.role >= 'manager'
       and exists (
         select 1
           from vizserve_pms_internal_requests r
          where r.approval_stage = 3
            and (r.status = 'PENDING_REVIEW' or r.reviewed_by = auth.uid())
            and (
              r.requester_id = p_user_id
              or exists (
                select 1
                  from vizserve_pms_internal_request_relievers rl
                 where rl.request_id = r.id and rl.reliever_id = p_user_id
              )
            )
       )
  );
$$;

grant execute on function vizserve_pms_is_stage3_subject(uuid) to authenticated;

-- ADDITIVE. Postgres ORs permissive policies on the same command, so P7-17's
-- self-or-own-department policy is untouched and nobody loses a row.
drop policy if exists "users readable to a final approver" on vizserve_pms_users;

create policy "users readable to a final approver"
  on vizserve_pms_users for select to authenticated
  using (vizserve_pms_is_stage3_subject(id));

-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
-- `vizserve_pms_active_task_coverage` stays `security_invoker`, so the "Covered
-- by" badge is still blank for this manager. That is correct: coverage is a
-- statement about a TASK, the manager has no relationship to the task, and the
-- hand-over they are approving is described by the reliever rows above — who is
-- taking what, which they can now see. Widening the task policies to a
-- company-wide role for the sake of a badge would be a far larger change than
-- the one this file is fixing.
-- ---------------------------------------------------------------------------
