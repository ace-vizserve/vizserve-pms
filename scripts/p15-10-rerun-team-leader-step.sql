-- P15-10 — RE-RUN THE TEAM LEADER STEP ON FOUR LEAVE REQUESTS (5 Oct 2026).
--
-- Before P15-10, led departments were not tied to the Team Leader role, and
-- four leave requests had their Team Leader step signed by somebody who does
-- not lead that department. All four were then final-approved by Joel as
-- Manager:
--
--   846a92af  Ace Guevarra       VizBytes  TL step: Joel, 16 Sep   → Amier
--   a1374b5b  Kurt Arciga        VizBytes  TL step: Joel, 16 Sep   → Amier
--   bf844d93  Kurt Arciga        VizBytes  TL step: Joel, 25 Sep   → Amier
--   77de5017  Raechelle Mallari  VizBooks  TL step: Amier, 29 Sep  → Joel
--
-- Each goes back to PENDING_REVIEW at stage 2. The right Team Leader signs it,
-- then the Manager signs it again — the same chain every request takes now.
-- The old approval rows stay: they are history, and the audit entry written
-- here says why the chain ran twice.
--
-- ONE STATEMENT that returns what it changed, rather than a DO block: a DO
-- block reports "Success. No rows returned" whether it moved four requests or
-- none, and the first run of this file did exactly that. The Team Leaders are
-- read from the RETURNING row, not vizserve_pms_internal_stage_approvers — every
-- part of one statement sees the table as it was before the update, so that
-- function would still answer "the Manager".
--
-- Guarded on status = 'APPROVED' and approval_stage = 3, so a second run
-- returns zero rows and changes nothing.
--
-- ⚠️ PROD DATA. Run as `postgres` in the SQL editor. Expect four rows.

with moved as (
  update vizserve_pms_internal_requests q
     set status          = 'PENDING_REVIEW',
         approval_stage  = 2,
         reviewed_by     = null,
         reviewed_at     = null,
         decision_reason = null
   where q.id in (
           '846a92af-a6bb-4911-a279-76c989fe68c9',
           'a1374b5b-1d6e-40dc-8d35-32c6853be2a4',
           'bf844d93-aac2-4822-a8a6-73fcb3072df6',
           '77de5017-cd66-463e-9308-c68dda25597e'
         )
     and q.status = 'APPROVED'
     and q.approval_stage = 3
  returning q.id, q.request_type, q.requester_id, q.department_id, q.status, q.approval_stage
),
info as (
  select m.*, u.full_name as requester,
         initcap(replace(lower(m.request_type::text), '_', ' ')) as label
    from moved m
    join vizserve_pms_users u on u.id = m.requester_id
),
audited as (
  select i.id,
         vizserve_pms_write_audit_log(
           'internal_request', i.id, 'rerouted', null,
           jsonb_build_object('status', 'APPROVED', 'approval_stage', 3),
           jsonb_build_object(
             'status', 'PENDING_REVIEW', 'to_stage', 2,
             'reason', 'P15-10: the Team Leader step was signed by somebody who does not lead this department'
           )
         ) as ok
    from info i
),
told_lead as (
  select i.id, tl as lead_id,
         vizserve_pms_notify(
           tl, 'pending_approval',
           i.label || ' request from ' || coalesce(i.requester, 'a colleague'),
           'Sent back for your sign-off: it was approved without its Team Leader.',
           'internal_request', i.id, '/approvals/' || i.id::text
         ) as n
    from info i,
         vizserve_pms_team_leaders_of(i.department_id, i.requester_id) tl
),
told_requester as (
  select i.id,
         vizserve_pms_notify(
           i.requester_id, 'internal_decision',
           i.label || ' request reopened for your Team Leader',
           'It was approved without your Team Leader''s sign-off. Nothing for you to do.',
           'internal_request', i.id, '/approvals/' || i.id::text
         ) as n
    from info i
)
select i.id, i.requester, i.status, i.approval_stage,
       (select string_agg(w.full_name, ', ')
          from told_lead t join vizserve_pms_users w on w.id = t.lead_id
         where t.id = i.id)                                       as waiting_on,
       (select count(*) from audited a where a.id = i.id)         as audit_rows,
       (select count(*) from told_requester r where r.id = i.id)  as requester_told
  from info i;
