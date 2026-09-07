-- ============================================================================
-- P11-01 — the approval history is readable by everyone who can read the
--          request it belongs to.
--
-- ⚠️ WHAT WAS BROKEN, in one sentence: `vizserve_pms_approvals` has recorded
-- every internal decision AND ITS REASON since Phase 5, and no screen has ever
-- read one of those rows.
--
-- The consequence surfaced in the 7 Sep demo. A leave request now takes two or
-- three signatures (P9-04). When it reaches the stage-3 manager, the page shows
-- them:
--
--     Relievers      Done
--     Team leader    Done
--     Manager        Waiting
--
-- and that is all. Not who the team leader was, not when they signed, not what
-- they wrote. A manager is asked for a final signature on a decision they cannot
-- see. `reviewed_by` / `reviewed_at` do not help either — P9-04 writes them only
-- on the TERMINAL transition, so while the request sits at stage 3 they are
-- still null. The intermediate history exists in exactly one place, which is the
-- table nothing reads.
--
-- Reading it needs two grants, because two policies stand in the way.
--
-- ----------------------------------------------------------------------------
-- THE AUDIENCE RULE, STATED ONCE: IF YOU CAN READ THE REQUEST, YOU CAN READ ITS
-- HISTORY.
--
-- Not "approvers only". The requester needs the reason most of all — a rejection
-- with no visible cause gets refiled unchanged and rejected again. A reliever
-- who reorganised their week around covering somebody needs to know the leave
-- was later refused. This is a forty-person internal tool, not a system with
-- opposing parties, and a timeline with holes in it is a smaller version of the
-- bug it was built to fix.
--
-- Stating it as ONE rule is also what keeps this migration small: both grants
-- below defer to `vizserve_pms_may_read_internal_request`, which already encodes
-- requester / department lead / HR / stage-3 manager. Nothing new is invented
-- here, and a future change to who may see a request carries its history along
-- automatically.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. THE DECISION ROWS.
--
-- The P2-00 policy is `approver_id = auth.uid() or manages_department(...)`, and
-- `department_id` on the row is the REQUESTER'S department (p9_04:326). So a
-- manager who leads no department is neither the approver nor a manager of that
-- department, and gets zero rows.
--
-- ⚠️ THE NEW CLAUSE IS GUARDED ON `entity_type = 'internal_request'` AND THAT
-- GUARD IS THE POINT. Client requests and timesheet weeks share this table and
-- must be bit-for-bit unchanged — `tests/db/approval-engine.test.ts:618` pins
-- the negative case that an out-of-scope team leader sees an empty list rather
-- than an error. Without the guard, `may_read_internal_request` would be called
-- with a client request's id, find no internal request by that id, and return
-- false — correct by luck rather than by design. The guard makes it correct on
-- purpose, and stops the function being called at all for two thirds of the
-- table.
-- ---------------------------------------------------------------------------
drop policy if exists "approvals readable in scope" on vizserve_pms_approvals;

create policy "approvals readable in scope"
  on vizserve_pms_approvals for select to authenticated
  using (
    approver_id = auth.uid()
    or vizserve_pms_manages_department(department_id)
    -- P11-01. Everyone who can read the request can read its decisions.
    or (
      entity_type = 'internal_request'
      and vizserve_pms_may_read_internal_request(entity_id)
    )
  );


-- ---------------------------------------------------------------------------
-- 2. THE APPROVER'S NAME.
--
-- A decision row carries an `approver_id`, not a name. P7-17 scopes
-- `vizserve_pms_users` to yourself and your own department, so the stage-3
-- manager can now read the row and still renders "Team leader · 6 Sep ·" with a
-- blank where the person should be — which is worse than the adverb it replaced,
-- because it looks like a rendering fault rather than a missing feature.
--
-- P9-08 already opened a keyhole of exactly this kind
-- (`vizserve_pms_is_stage3_subject`), but only for the REQUESTER and the named
-- RELIEVERS. Prior approvers were not in its list, because at the time nothing
-- displayed them.
--
-- ⚠️ SECURITY DEFINER, LIKE ITS SIBLING, AND FOR THE SAME REASON. Written as a
-- plain EXISTS in a policy on `vizserve_pms_users`, this recurses: the users
-- policy calls a subquery that reads `vizserve_pms_users`, which runs the users
-- policy. The definer boundary is what stops that, exactly as it does for
-- `vizserve_pms_is_reliever_on` and `vizserve_pms_is_stage3_subject` (p9_01,
-- p9_08).
--
-- ⚠️ IT EXPOSES A FULL NAME AND NOTHING ELSE, about somebody who has already put
-- their signature on a request this caller is entitled to read. That is
-- narrower than it first sounds: `may_read_internal_request` is the gate, so a
-- name only becomes visible once the request itself is.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_decided_on_readable_internal_request(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_approvals a
     where a.approver_id = p_user_id
       and a.entity_type = 'internal_request'
       and vizserve_pms_may_read_internal_request(a.entity_id)
  );
$$;

grant execute on function vizserve_pms_decided_on_readable_internal_request(uuid) to authenticated;

comment on function vizserve_pms_decided_on_readable_internal_request(uuid) is
  'P11-01. True when this person has decided on an internal request the caller may read. '
  'Backs the users SELECT policy that lets an approval timeline show a name instead of a role.';

-- ADDITIVE. Postgres ORs permissive policies on the same command, so P7-17's
-- self-or-own-department policy and P9-08's final-approver policy are both
-- untouched and nobody loses a row.
drop policy if exists "users readable as a prior approver" on vizserve_pms_users;

create policy "users readable as a prior approver"
  on vizserve_pms_users for select to authenticated
  using (vizserve_pms_decided_on_readable_internal_request(id));


-- ============================================================================
-- WHAT THIS DELIBERATELY DOES NOT DO.
--
-- It does not widen `vizserve_pms_audit_logs`. Reliever decisions are audited
-- there rather than in `vizserve_pms_approvals` (p9_04), and the reliever rows
-- themselves already carry decision, decided_at and reason — which the page
-- reads and renders. The audit log stays owner-only.
--
-- It does not touch `vizserve_pms_active_task_coverage`, which stays
-- security_invoker for the reasons P9-08 gives.
--
-- And it adds no INSERT path anywhere. `vizserve_pms_record_decision` is still
-- the only way a row reaches `vizserve_pms_approvals`, so nobody can forge a
-- decision they did not make — this migration is about reading, only.
-- ============================================================================
