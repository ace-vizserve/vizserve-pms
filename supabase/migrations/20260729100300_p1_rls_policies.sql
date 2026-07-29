-- Phase 1 RLS.
--
-- The public surfaces (form rendering, submission) do NOT appear here: they go
-- through SECURITY DEFINER functions and `anon` never touches a table. That is
-- the whole design — see docs/02-data-model.md §Public access.

alter table vizserve_pms_forms                     enable row level security;
alter table vizserve_pms_form_fields               enable row level security;
alter table vizserve_pms_requests                  enable row level security;
alter table vizserve_pms_request_attachments       enable row level security;
alter table vizserve_pms_reference_counters        enable row level security;
alter table vizserve_pms_public_submission_log     enable row level security;
alter table vizserve_pms_public_submission_limits  enable row level security;

revoke all on vizserve_pms_forms                    from anon;
revoke all on vizserve_pms_form_fields              from anon;
revoke all on vizserve_pms_requests                 from anon;
revoke all on vizserve_pms_request_attachments      from anon;
revoke all on vizserve_pms_reference_counters       from anon;
revoke all on vizserve_pms_public_submission_log    from anon;
revoke all on vizserve_pms_public_submission_limits from anon;

-- ---------------------------------------------------------------------------
-- Forms — a TL manages forms for the departments they lead (docs/01 §2).
-- ---------------------------------------------------------------------------
create policy "forms readable in scope"
  on vizserve_pms_forms for select to authenticated
  using (vizserve_pms_manages_department(department_id));

-- A form with no department yet is being drafted; only its author and admins
-- see it, otherwise an unrouted draft would be invisible even to the person
-- creating it.
create policy "forms readable by author while unrouted"
  on vizserve_pms_forms for select to authenticated
  using (department_id is null and created_by = auth.uid());

create policy "forms insertable by team leaders"
  on vizserve_pms_forms for insert to authenticated
  with check (
    vizserve_pms_has_role('team_leader')
    and (department_id is null or vizserve_pms_manages_department(department_id))
  );

create policy "forms updatable in scope"
  on vizserve_pms_forms for update to authenticated
  using (
    vizserve_pms_manages_department(department_id)
    or (department_id is null and created_by = auth.uid())
  )
  with check (department_id is null or vizserve_pms_manages_department(department_id));

create policy "forms deletable by admin"
  on vizserve_pms_forms for delete to authenticated
  using (vizserve_pms_is_admin());

-- ---------------------------------------------------------------------------
-- Form fields — inherit the parent form's scope.
-- ---------------------------------------------------------------------------
create policy "form fields follow their form"
  on vizserve_pms_form_fields for all to authenticated
  using (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and (
           vizserve_pms_manages_department(f.department_id)
           or (f.department_id is null and f.created_by = auth.uid())
         )
    )
  )
  with check (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and (
           vizserve_pms_manages_department(f.department_id)
           or (f.department_id is null and f.created_by = auth.uid())
         )
    )
  );

-- ---------------------------------------------------------------------------
-- Requests — visible to whoever leads the owning form's department.
--
-- "A submitted request appears in the correct TL's queue and NOWHERE ELSE" is a
-- Phase 1 exit criterion, asserted at the API layer. This policy is what makes
-- it true; the app-side filter is a convenience on top.
--
-- No INSERT policy: requests are created only by vizserve_pms_submit_request().
-- ---------------------------------------------------------------------------
create policy "requests readable in department scope"
  on vizserve_pms_requests for select to authenticated
  using (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and vizserve_pms_manages_department(f.department_id)
    )
  );

-- Gate 1 (Phase 2) writes through here.
create policy "requests updatable in department scope"
  on vizserve_pms_requests for update to authenticated
  using (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and vizserve_pms_manages_department(f.department_id)
    )
  )
  with check (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and vizserve_pms_manages_department(f.department_id)
    )
  );

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

-- ---------------------------------------------------------------------------
-- Operational tables — admin only. The submission log holds IP addresses.
-- ---------------------------------------------------------------------------
create policy "reference counters admin only"
  on vizserve_pms_reference_counters for select to authenticated
  using (vizserve_pms_is_admin());

create policy "submission log admin only"
  on vizserve_pms_public_submission_log for select to authenticated
  using (vizserve_pms_is_admin());

create policy "submission limits readable by team leaders"
  on vizserve_pms_public_submission_limits for select to authenticated
  using (vizserve_pms_has_role('team_leader'));

create policy "submission limits writable by admin"
  on vizserve_pms_public_submission_limits for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());
