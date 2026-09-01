-- ---------------------------------------------------------------------------
-- REVERTS P7-58 (20260901120000). Request visibility goes back to leads only.
--
-- P7-58 widened the requests SELECT policy so a PIC could read the brief their
-- own task came from. It was applied to the live project by mistake and the
-- decision is to go back: the client never sees who at VizServe holds their
-- task — the Gate 3 payload deliberately returns no PIC name, no department and
-- no internal ids (see the note above `vizserve_pms_read_token` in
-- 20260804100000_p4_client_approval.sql) — and the relationship stays anonymous
-- in both directions. The client deals with the firm, not with a person.
--
-- A FORWARD MIGRATION, not a deleted file. 20260901120000 is already recorded in
-- the remote's `schema_migrations`, so removing it locally would leave the two
-- histories disagreeing and the next `db push` arguing about it. The way back is
-- another migration.
--
-- CONSEQUENCE, RECORDED SO IT IS NOT REDISCOVERED AS A BUG: a member PIC opening
-- a client task sees "Not visible to you" against Request, Client and Client
-- wants, and gets no "From the request" panel — no client wording, no form
-- answers, no attached reference images. That is the intended state, not a
-- display fault. The task's own title and brief are what they work from.
-- ---------------------------------------------------------------------------

drop policy "requests readable in department scope" on vizserve_pms_requests;

-- Byte-for-byte the P1 policy (20260729100300_p1_rls_policies.sql).
create policy "requests readable in department scope"
  on vizserve_pms_requests for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and vizserve_pms_manages_department(f.department_id)
    )
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
  );

-- Dropped last: both policies above referenced it until this point.
drop function if exists vizserve_pms_works_on_request(uuid);
