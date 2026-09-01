-- ---------------------------------------------------------------------------
-- P7-58 — THE PERSON DOING THE WORK CAN READ THE REQUEST IT CAME FROM.
--
-- THE BUG, as it reached a user: a PIC opens their own client task and the
-- detail page says
--
--     Request        Not visible to you
--     Client         —
--     Client wants   No date given
--
-- ...and the "From the request" panel — the client's own wording, their answers
-- to the form, the reference images they attached — does not render at all.
--
-- It is not a display fault. `requests readable in department scope` (P1) tests
-- `vizserve_pms_manages_department(f.department_id)` and NOTHING ELSE, so the
-- request row is readable only by the department's LEADS. A `member` holding the
-- task cannot read it, the page's query returns no row, and every field sourced
-- from it renders as absent.
--
-- The result is that the one screen the work is actually done on could not tell
-- the person doing it who asked, what they asked for, or when they need it —
-- while the task's own title and brief, derived from that same request, were
-- right there. They had to ask a lead.
--
-- ⚠️ THIS IS NOT A CONFIDENTIALITY FEATURE. There is no confidentiality flag on
-- `vizserve_pms_requests`, and nothing anywhere sets one. A design that draws a
-- padlock here would be inventing a policy nobody wrote to explain a policy gap.
--
-- ---------------------------------------------------------------------------
-- WHAT CHANGES, AND WHAT DELIBERATELY DOES NOT.
--
--   SELECT on requests               widened: leads, OR anyone holding a seat on
--                                    a task born from this request.
--   SELECT on request_attachments    the same, because the brief's reference
--                                    images are half of what the request says.
--   UPDATE on requests               UNCHANGED. Gate 1 is a lead's decision.
--                                    Reading the brief is not approving it, and
--                                    widening SELECT and UPDATE in one migration
--                                    is how a reader becomes an approver by
--                                    accident (the same reasoning P7-17 records
--                                    for tasks).
--   The submission log               UNCHANGED. It holds IP addresses and stays
--                                    admin-only.
--
-- A SEAT, not department membership. P7-17 lets anyone in a department SEE the
-- department's tasks; that is a queue, and it does not follow that everyone in
-- the department should read every client's brief. The test here is the same one
-- `vizserve_pms_is_on_task` asks: are you the PIC, the QA reviewer, or a second
-- assignee on a task that came from this request.
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER, exactly like `vizserve_pms_is_on_task` and for the same two
-- reasons: it must not be re-filtered by the tasks SELECT policy while deciding
-- the requests one, and a policy that joins a policied table pays for that join
-- on every row. `stable`, so it is evaluated once per statement per argument.
create or replace function vizserve_pms_works_on_request(p_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_tasks t
     where t.request_id = p_request_id
       and (
         t.assignee_id = auth.uid()
         or t.qa_assignee_id = auth.uid()
         or exists (
           select 1
             from vizserve_pms_task_assignees a
            where a.task_id = t.id
              and a.user_id = auth.uid()
         )
       )
  );
$$;

grant execute on function vizserve_pms_works_on_request(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- The two SELECT policies.
-- ---------------------------------------------------------------------------
drop policy "requests readable in department scope" on vizserve_pms_requests;

create policy "requests readable in department scope"
  on vizserve_pms_requests for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and vizserve_pms_manages_department(f.department_id)
    )
    -- P7-58. Without this line the person the work was handed to cannot read
    -- the brief they are working from.
    or vizserve_pms_works_on_request(id)
  );

drop policy "request attachments follow their request" on vizserve_pms_request_attachments;

create policy "request attachments follow their request"
  on vizserve_pms_request_attachments for select to authenticated
  using (
    exists (
      select 1
        from vizserve_pms_requests r
        join vizserve_pms_forms f on f.id = r.form_id
       where r.id = request_id
         and vizserve_pms_manages_department(f.department_id)
    )
    -- The files the client attached to the brief. A brief with three reference
    -- images reached the person doing the work as a title and a sentence.
    or vizserve_pms_works_on_request(request_id)
  );
