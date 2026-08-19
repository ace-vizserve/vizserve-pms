-- ---------------------------------------------------------------------------
-- P7-22 — the person doing the work can see what the client sent.
--
-- THE BUG, and it is a policy one rather than a screen one.
--
-- `vizserve_pms_request_attachments` has a single SELECT policy, written in
-- Phase 1 before tasks existed:
--
--   "request attachments follow their request"
--     using ( ... vizserve_pms_manages_department(f.department_id) )
--
-- Department LEADS, and nobody else. That was right when the only screen
-- reading these files was the Gate 1 review, which is a lead's screen. It
-- stopped being right the moment the approval created a task and handed it to a
-- member: the brief, the reference images and the spec document the client
-- attached to the form were unreadable by the one person who needed them, and
-- the task page could not show them at all.
--
-- Reported as "the answered form of the client is being neglected and cannot be
-- seen anywhere", which is exactly what it looks like from the inside.
--
-- WHAT THIS DOES NOT DO: it does not widen who can see a REQUEST. The Gate 1
-- queue stays a lead's screen. The only thing added is that once a request has
-- become a task, the files travel with the task and follow the task's own
-- audience.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it
-- stands at that moment.
-- ---------------------------------------------------------------------------

-- ⚠️ THE NAME MUST MATCH EXACTLY, and P7-17 records why this matters more in
-- the other direction: a DROP that silently matches nothing leaves the old
-- policy alive BESIDE the new one, and two permissive policies are OR-ed — so
-- the result is wider than either was meant to be. This name is copied
-- character for character from 20260729100300_p1_rls_policies.sql:119.
drop policy if exists "request attachments follow their request"
  on vizserve_pms_request_attachments;

create policy "request attachments follow their request"
  on vizserve_pms_request_attachments for select to authenticated
  using (
    -- UNCHANGED, verbatim from Phase 1. A lead of the form's department reads
    -- these at Gate 1, before any task exists to inherit them.
    exists (
      select 1
        from vizserve_pms_requests r
        join vizserve_pms_forms f on f.id = r.form_id
       where r.id = request_id
         and vizserve_pms_manages_department(f.department_id)
    )
    -- NEW. Anybody who can see the TASK this request became.
    --
    -- The clauses are a deliberate copy of
    -- "tasks readable by participants and department leads" (P7-17) rather than
    -- a subselect against `vizserve_pms_tasks` that leans on that policy. RLS
    -- does NOT apply to a table referenced inside another table's policy — the
    -- subquery would run unfiltered — so "you can see the task" has to be
    -- stated, not borrowed. Restating it means the two must be kept in step by
    -- hand, and this comment is the note saying so.
    --
    -- `is_personal` is not tested here and does not need to be: a task with a
    -- `request_id` is client work by definition, and `taskCategory` treats a
    -- request as winning over the personal flag. There is no personal task with
    -- request attachments to leak.
    or exists (
      select 1
        from vizserve_pms_tasks t
       where t.request_id = vizserve_pms_request_attachments.request_id
         and (
           t.assignee_id = auth.uid()
           or t.qa_assignee_id = auth.uid()
           or vizserve_pms_manages_department(t.department_id)
           or vizserve_pms_is_on_task(t.id, auth.uid())
           -- P7-17's department clause. Client work is shared work: the same
           -- people who can read the task can read what came in with it.
           or t.department_id = vizserve_pms_my_department()
         )
    )
  );

comment on policy "request attachments follow their request"
  on vizserve_pms_request_attachments is
  'P1-09, widened by P7-22. Readable by a lead of the form''s department, and '
  'by anyone who can see the task the request became. Mirrors the task SELECT '
  'policy clause for clause — keep the two in step.';
