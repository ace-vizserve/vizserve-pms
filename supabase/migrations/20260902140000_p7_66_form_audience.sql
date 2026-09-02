-- ---------------------------------------------------------------------------
-- P7-66 Phase 5 — AN INTERNAL FORM IS AN ADMIN INSTRUMENT, AND IT KNOWS WHO IT
-- IS FOR.
--
-- Two changes, shipped together because each is unsafe without the other.
--
-- ⚠️⚠️ WHAT IS BROKEN RIGHT NOW, AND IT IS LIVE.
--
-- `published engagement forms readable by staff` (20260902110000) is
-- COMPANY-WIDE by construction: `purpose = 'INTERNAL' and is_active
-- and vizserve_pms_current_role() is not null`. It has to be, or /respond
-- renders nothing for the person answering. And the responses INSERT policy
-- (20260902130000) checks the purpose, the published flag and the anonymity
-- promise — and NOTHING about who the form is for, because until this file
-- there was nothing to check.
--
-- So today every signed-in colleague can read and answer every published
-- internal form. A VizBytes-only pulse survey is answerable by VizMedia, and
-- nothing anywhere says otherwise.
--
-- ⚠️ NARROWING THE READ ALONE WOULD BE THEATRE. A `select` policy decides what
-- /respond RENDERS; it does not decide what a POST may write. Somebody holding
-- the form id — from a colleague, from a shared link, from having been in the
-- audience last quarter — could insert a response against a form they can no
-- longer see. Both policies move in this file or neither should.
--
-- ---------------------------------------------------------------------------
-- PART A — ONLY AN ADMIN CREATES, EDITS OR READS AN INTERNAL FORM.
--
-- Ace, 2 Sep 2026, on the blocker this resolves: "if the user is not admin then
-- when they create a form only members under the department is they can see."
--
-- The problem it answers: Phase 6 wants to say WHO HAS NOT ANSWERED, and that
-- needs the roster of every targeted department. A team leader cannot read the
-- members of a department they do not lead — `users read managed departments`
-- and `department members visible` both refuse — so the roster would be
-- half-blank on exactly the company-wide survey it is most wanted for.
--
-- ⚠️ THE ALTERNATIVE WAS REJECTED ON PURPOSE. Widening those two policies would
-- have made the WHOLE APP's people data wider — every screen that lists a
-- person reads through them — in order to make one roster work. Restricting
-- internal forms to admins costs nothing instead: an admin already reads every
-- department's members, so Phase 6 needs no new policy at all.
--
-- ⚠️ AND IT IS THE REVERSIBLE DIRECTION. Letting team leaders back in later is a
-- `create policy`; taking the power away after leads have built surveys with it
-- is a data problem. If a TL ever needs one, the safe shape is already known:
-- let them create it but constrain the audience to departments they lead, which
-- is exactly the set whose members they can already read.
--
-- CLIENT FORMS ARE UNTOUCHED. team_leader and above, their own departments,
-- exactly as before. Every rule below is conditioned on the purpose, so a
-- client form takes the same branch it always did.
--
-- ---------------------------------------------------------------------------
-- PART B — THE AUDIENCE. Everyone, or named departments.
--
-- `audience_is_all_departments` is a COLUMN and not merely "zero rows means
-- everyone", and that is the one design decision here worth defending at
-- length.
--
-- ⚠️ ZERO ROWS MUST NOT MEAN EVERYONE. The write is delete-then-insert. If the
-- two halves ever come apart — a crash, a caller that is not
-- `vizserve_pms_set_form_audience`, a department deleted out from under the
-- rows — then "no rows" as a synonym for "the whole company" turns a
-- half-finished NARROWING into a silent WIDENING: a survey scoped to one
-- department quietly goes company-wide and no screen can tell. With the flag,
-- the same accident leaves `false` with no rows, which resolves to NOBODY.
-- Visible, reportable, and wrong in the direction that cannot leak.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, like every P7 migration. It will
-- not be recorded in `supabase_migrations.schema_migrations`.
--
-- Re-runnable. Every policy is DROPPED and re-created rather than guarded by a
-- `pg_policies` existence check — the lesson of 20260902130000, which had to
-- exist at all because A GUARD THAT MAKES A FILE RE-RUNNABLE ALSO PROTECTS AN
-- OBJECT THAT IS ALREADY WRONG. `if not exists` asks the wrong question when the
-- object is there and disagrees with the file.
--
-- ⚠️ THE TWO RENAMED POLICIES EACH NEED **TWO** DROPS, and this is not a detail.
-- Where a policy is renamed, the drop and the create name different objects, so
-- drop-then-create is NOT idempotent on its own: the second run finds nothing to
-- drop and then collides with what the first run created. Both the old name and
-- the new one are dropped before each of those creates. Learned the hard way on
-- 2 Sep 2026, mid-apply:
--
--   42710: policy "form responses readable by admins" ... already exists
--
-- and the reason it mattered is that the abort took the rest of the file with
-- it — including the audience narrowing, which is the point of the file.
--
-- ORDER MATTERS: Part B.1 creates the table and the helper BEFORE any policy
-- calls them, because a `create policy` naming an unknown function fails
-- outright.
--
-- Back-out, in reverse:
--   1. re-create the five Part A policies from 20260729100300 / 20260902110000
--   2. re-create the two Part B policies without vizserve_pms_form_targets_me
--   3. drop function vizserve_pms_set_form_audience(uuid, boolean, uuid[]);
--      drop function vizserve_pms_form_targets_me(uuid);
--   4. drop table vizserve_pms_form_audience_departments;
--      alter table vizserve_pms_forms drop column audience_is_all_departments;
-- Step 1 is the one that restores access; do it first if you are backing out
-- under pressure.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PRE-FLIGHT — run this first, on its own. It only reports.
--
-- --- 1. ⚠️ WHOSE INTERNAL FORMS ARE ABOUT TO BECOME UNREACHABLE TO THEM ------
-- Every INTERNAL form whose creator is not an admin. Expected: 0 rows —
-- 20260902110000 measured zero internal forms on 2 Sep 2026. A non-empty result
-- is not a blocker, but those creators lose the builder on their own form and an
-- admin has to take it over. Know the list first.
--
-- select f.id, f.name, f.created_by, u.full_name, u.role
--   from vizserve_pms_forms f
--   left join vizserve_pms_users u on u.id = f.created_by
--  where f.purpose = 'INTERNAL'
--    and u.role is distinct from 'admin';
--
-- --- 2. THE POLICIES THIS FILE REPLACES MUST BE THE ONES IT EXPECTS ----------
-- Expected: 6 rows. If any definition already mentions `audience` or
-- `is_admin()` on an engagement branch, this file has been applied — it is safe
-- to run again regardless.
--
-- select tablename, policyname, cmd
--   from pg_policies
--  where schemaname = 'public'
--    and policyname in (
--      'forms insertable by team leaders',
--      'forms updatable in scope',
--      'form fields follow their form',
--      'form responses readable by the owning department',
--      'published engagement forms readable by staff',
--      'form responses insertable by their author'
--    );
--
-- --- 3. NOTHING IS LOST. A policy is not data and Part B only adds. These two
-- numbers must be unchanged afterwards.
--
-- select (select count(*) from vizserve_pms_forms)          as forms,
--        (select count(*) from vizserve_pms_form_responses) as responses;
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- PART B.1 — WHERE THE AUDIENCE IS STORED.
-- ---------------------------------------------------------------------------

-- ⚠️ DEFAULT TRUE, WHICH IS THE BEHAVIOUR EVERY EXISTING FORM ALREADY HAS.
-- Adding a column must not narrow a live form as a side effect of running a
-- migration: today every published internal form is answerable company-wide, so
-- `true` is the value that changes nothing on the way in. It is meaningless on
-- a CLIENT_REQUEST form and never read for one — every policy that consults it
-- is already gated on `purpose = 'INTERNAL'`.
alter table vizserve_pms_forms
  add column if not exists audience_is_all_departments boolean not null default true;

comment on column vizserve_pms_forms.audience_is_all_departments is
  'P7-66. INTERNAL only. True: every active staff member may answer. '
  'False: only the departments in vizserve_pms_form_audience_departments may. A '
  'COLUMN rather than "zero rows means everyone" so that a half-finished '
  'narrowing resolves to nobody rather than silently widening to the company.';

-- Shaped exactly like `vizserve_pms_user_managed_departments`, which is the one
-- other many-to-many between a thing and a set of departments in this schema.
-- (`p7_45_leave_type_applicability` is not a precedent — that one is gender.)
create table if not exists vizserve_pms_form_audience_departments (
  form_id       uuid not null references vizserve_pms_forms (id) on delete cascade,
  department_id uuid not null references vizserve_pms_departments (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (form_id, department_id)
);

comment on table vizserve_pms_form_audience_departments is
  'P7-66. Which departments an INTERNAL form is for. Read only when '
  'vizserve_pms_forms.audience_is_all_departments is false. A department deleted '
  'elsewhere cascades away here, which can leave a form false with no rows — '
  'that resolves to NOBODY, which is the intended fail-closed direction.';

-- The forward lookup ("which departments is this form for?") rides the primary
-- key. This is the reverse one: `vizserve_pms_form_targets_me` asks whether MY
-- department is in a form's audience, and Phase 6 will ask a department for its
-- members.
create index if not exists vizserve_pms_form_audience_departments_department_idx
  on vizserve_pms_form_audience_departments (department_id);


-- ---------------------------------------------------------------------------
-- PRIVILEGES — stated, never inherited. The long version is in 20260902110000:
-- `20260729110000_p0_06_grants.sql` sets ALTER DEFAULT PRIVILEGES, but only for
-- tables created by the role that ran it, and this file is pasted into the SQL
-- editor by hand. A failing POLICY returns zero rows; a missing GRANT returns
-- `permission denied for table …`. Never confuse the two.
--
-- `revoke all` first, because A POSITIVE GRANT WITHHOLDS NOTHING: if the
-- defaults did reach this table, it shipped updatable and deletable by every
-- signed-in user. Only a REVOKE subtracts, and it is idempotent either way.
--
-- ⚠️ NO `update` PRIVILEGE, DELIBERATELY. Both meaningful columns are the
-- primary key, so there is no such thing as editing one of these rows — only
-- deleting it and inserting another, which is exactly what
-- `vizserve_pms_set_form_audience` does. Granting update would grant a verb the
-- table has no use for.
--
-- `select` is granted because the BUILDER reads the audience back to draw its
-- checkboxes. The policy below is what makes that admin-only; the grant only
-- makes the question askable at all.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_form_audience_departments enable row level security;

revoke all on vizserve_pms_form_audience_departments from anon;
revoke all on vizserve_pms_form_audience_departments from authenticated;

grant select, insert, delete on vizserve_pms_form_audience_departments to authenticated;
grant all privileges on vizserve_pms_form_audience_departments to service_role;


-- ⚠️ ONE POLICY, `for all`, ADMIN ONLY — matching Part A. An internal form is an
-- admin instrument end to end, so there is no reader of its audience who is not
-- an admin, and no writer either.
--
-- ⚠️ THE PERSON ANSWERING NEEDS NO POLICY HERE AT ALL, and must not have one.
-- They never read this table: `vizserve_pms_form_targets_me` is SECURITY
-- DEFINER and answers the question on their behalf. A member holding `select`
-- over every form's audience would hold a list of which departments are being
-- surveyed about what, which is not theirs to have.
drop policy if exists "form audience readable and writable by admins"
  on vizserve_pms_form_audience_departments;

create policy "form audience readable and writable by admins"
  on vizserve_pms_form_audience_departments for all to authenticated
  using (vizserve_pms_is_admin())
  with check (vizserve_pms_is_admin());


-- ---------------------------------------------------------------------------
-- PART B.2 — "AM I IN THIS FORM'S AUDIENCE?"
--
-- ⚠️ SECURITY DEFINER FOR TWO REASONS, AND BOTH ARE REQUIRED.
--
--   1. IT IS CALLED FROM A POLICY ON `vizserve_pms_forms` AND READS
--      `vizserve_pms_forms`. As INVOKER that re-enters the very policy being
--      evaluated. DEFINER runs as the owner, which is not subject to the
--      policies, exactly as `vizserve_pms_current_role()` reads
--      `vizserve_pms_users` from inside that table's own policies.
--   2. THE CALLER HAS NO PRIVILEGE ON THE AUDIENCE TABLE, and should not. See
--      the policy above.
--
-- ⚠️ IT SAYS NOTHING ABOUT PURPOSE, PUBLICATION OR ANONYMITY, and must not be
-- read as a general "may I answer this form". Every caller ANDs it with
-- `purpose = 'INTERNAL' and is_active` itself, so this function has
-- exactly one job and the other conditions stay visible at the call site where
-- somebody auditing a policy will actually read them.
--
-- ⚠️ AN UNKNOWN FORM ANSWERS FALSE, not true. `exists` over no rows is false,
-- which is the fail-closed answer for an id that does not resolve.
--
-- ⚠️ MEMBERSHIP IS `primary_department_id` — WHERE SOMEBODY WORKS, not what they
-- lead. `vizserve_pms_user_managed_departments` is the wrong set here (D15): a
-- team leader can perfectly well lead VizBytes while working in VizMedia, and
-- the question this answers is "should this person be answering", which is
-- about their own team. It follows that an admin outside the audience cannot
-- answer either — correct, they are not the audience, and the builder has a
-- preview pane for checking the form without submitting to it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_form_targets_me(p_form_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
      from vizserve_pms_forms f
     where f.id = p_form_id
       and (
         f.audience_is_all_departments
         or exists (
           select 1
             from vizserve_pms_form_audience_departments a
             join vizserve_pms_users u on u.id = auth.uid()
            where a.form_id = f.id
              and a.department_id = u.primary_department_id
         )
       )
  )
$$;

comment on function vizserve_pms_form_targets_me(uuid) is
  'P7-66. Is the caller in this form (audience)? True when the form is open to '
  'all departments, or when the caller primary_department_id is one of the '
  'targeted departments. Says NOTHING about purpose, publication or anonymity — '
  'callers AND those in themselves. SECURITY DEFINER because it is called from a '
  'policy on the same table it reads, and because the caller holds no privilege '
  'on the audience table.';

grant execute on function vizserve_pms_form_targets_me(uuid) to authenticated;


-- ---------------------------------------------------------------------------
-- PART B.3 — SETTING THE AUDIENCE, ATOMICALLY.
--
-- ⚠️ THIS EXISTS BECAUSE DELETE-THEN-INSERT ACROSS TWO POSTGREST CALLS IS NOT A
-- TRANSACTION. A server action that deleted the old rows and then inserted the
-- new ones would, on a failure between the two, leave `false` with no rows —
-- a form nobody can answer — and on a differently-timed failure could leave a
-- narrowed form flagged `true`. One function, one transaction, one outcome.
--
-- ⚠️ SECURITY INVOKER, and that is the same reasoning as
-- `vizserve_pms_save_form_schema`: the RLS policies on `vizserve_pms_forms` and
-- on the audience table ARE the authorization, so this is no wider a door than
-- writing the rows directly. `forms updatable in scope` refuses a non-admin on
-- an engagement form after Part A, and the audience policy refuses one outright.
-- Nothing here needs to re-check who is calling, and re-checking would create a
-- second authority that can disagree with the first.
--
-- ⚠️ IT DOES CHECK THE PURPOSE, because no policy can. An audience on a
-- CLIENT_REQUEST form is not a permissions question — it is a meaningless row,
-- since a client has no account and no department. Refused here rather than
-- stored and ignored.
--
-- ⚠️ AND IT REFUSES "SPECIFIC DEPARTMENTS: NONE". A form flagged `false` with an
-- empty list is answerable by nobody. That state is reachable by ACCIDENT (a
-- cascade from a deleted department) and the read side treats it correctly as
-- nobody — but it must not be reachable by REQUEST, because nothing on the
-- screen would explain why a published survey rejects everyone.
--
-- Distinct ids only: `array_agg(distinct …)` is not needed because the primary
-- key would raise on a repeat, but a caller sending the same department twice
-- means one department, not an error. `select distinct` says so.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_set_form_audience(
  p_form_id         uuid,
  p_all             boolean,
  p_department_ids  uuid[]
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_purpose vizserve_pms_form_purpose;
begin
  if p_all is null then
    raise exception 'An audience must say whether it is every department or a list.'
      using errcode = 'invalid_parameter_value';
  end if;

  /*
   * ⚠️ READ THROUGH THE CALLER'S OWN POLICIES. If they cannot see the form, this
   * finds nothing and the function refuses — which is the same answer the UPDATE
   * below would give, arrived at before anything is written.
   */
  select f.purpose into v_purpose
    from vizserve_pms_forms f
   where f.id = p_form_id;

  if v_purpose is null then
    raise exception 'That form does not exist, or is not yours to edit.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_purpose <> 'INTERNAL' then
    raise exception 'Only an internal form has an audience. A client form is answered by a client, who has no department.'
      using errcode = 'invalid_parameter_value';
  end if;

  if not p_all and coalesce(array_length(p_department_ids, 1), 0) = 0 then
    raise exception 'Choose at least one department, or open the form to everyone.'
      using errcode = 'invalid_parameter_value';
  end if;

  update vizserve_pms_forms
     set audience_is_all_departments = p_all
   where id = p_form_id;

  /*
   * REPLACED WHOLESALE, not merged. The caller sends the audience it wants, and
   * working out which rows are new is the kind of arithmetic that goes wrong
   * quietly. Inside one transaction there is no window where the old rows are
   * gone and the new ones are not.
   */
  delete from vizserve_pms_form_audience_departments
   where form_id = p_form_id;

  -- Nothing to insert when the form is open to everyone: the flag carries that
  -- state, and rows alongside `true` would be a second, contradictory record of
  -- the same fact.
  if not p_all then
    insert into vizserve_pms_form_audience_departments (form_id, department_id)
    select distinct p_form_id, d
      from unnest(p_department_ids) as d
     where d is not null;
  end if;
end;
$$;

comment on function vizserve_pms_set_form_audience(uuid, boolean, uuid[]) is
  'P7-66. Replaces an INTERNAL form audience in one transaction: sets '
  'audience_is_all_departments and rewrites vizserve_pms_form_audience_departments. '
  'Exists because delete-then-insert over two PostgREST calls is not atomic and a '
  'failure between them changes who may answer. SECURITY INVOKER: the RLS policies '
  'are the authorization. Refuses a client form and refuses "specific departments: '
  'none". Raises rather than returning; success is the absence of an error.';

grant execute on function vizserve_pms_set_form_audience(uuid, boolean, uuid[]) to authenticated;


-- ===========================================================================
-- PART A — THE FIVE NARROWINGS.
--
-- Every one is `drop` then `create`, unguarded. See the header: a re-runnability
-- guard also protects an object that is already wrong.
-- ===========================================================================

-- --- A.1 — WHO MAY CREATE ONE ----------------------------------------------
--
-- The client branch is the original rule, untouched: team_leader or above, and
-- a department they lead (or none yet, which is an unrouted draft).
--
-- ⚠️ THE ENGAGEMENT BRANCH DOES NOT REPEAT THE DEPARTMENT TEST, because
-- `vizserve_pms_is_admin()` already reaches every department —
-- `vizserve_pms_manages_department` returns true for an admin whatever it is
-- passed. Repeating it would suggest an admin could be refused a department,
-- which is not a rule this system has.
drop policy if exists "forms insertable by team leaders" on vizserve_pms_forms;

create policy "forms insertable by team leaders"
  on vizserve_pms_forms for insert to authenticated
  with check (
    case
      when purpose = 'INTERNAL' then vizserve_pms_is_admin()
      else
        vizserve_pms_has_role('team_leader')
        and (department_id is null or vizserve_pms_manages_department(department_id))
    end
  );


-- --- A.2 — WHO MAY EDIT ONE -------------------------------------------------
--
-- ⚠️ BOTH `using` AND `with check`, AND FOR DIFFERENT REASONS. `using` decides
-- which rows may be updated at all; `with check` decides what they may become.
-- A rule stated only in `using` would let an admin-only engagement form be
-- edited INTO something else, and a rule only in `with check` would let a team
-- leader open the row and be refused at the end.
--
-- ⚠️ THE PURPOSE IS TESTED ON BOTH THE OLD AND THE NEW ROW, which is what stops
-- the conversion loophole: a team leader cannot take a CLIENT_REQUEST form they
-- legitimately manage and update it into an INTERNAL one. The
-- `purpose` lock in `updateFormSettings` refuses that too, but the front end
-- will be bypassed.
drop policy if exists "forms updatable in scope" on vizserve_pms_forms;

create policy "forms updatable in scope"
  on vizserve_pms_forms for update to authenticated
  using (
    case
      when purpose = 'INTERNAL' then vizserve_pms_is_admin()
      else
        vizserve_pms_manages_department(department_id)
        or (department_id is null and created_by = auth.uid())
    end
  )
  with check (
    case
      when purpose = 'INTERNAL' then vizserve_pms_is_admin()
      else department_id is null or vizserve_pms_manages_department(department_id)
    end
  );


-- --- A.3 — WHO MAY EDIT ITS QUESTIONS ---------------------------------------
--
-- ⚠️ WITHOUT THIS, A.2 IS DECORATIVE. `vizserve_pms_save_form_schema` is
-- SECURITY INVOKER and writes `vizserve_pms_form_fields` directly — so a team
-- leader locked out of the form ROW could still rewrite every question on it
-- through the builder, and the form row itself would never be touched.
--
-- The field policy has always been "inherit the parent form's scope"; it now
-- inherits the narrowed one.
drop policy if exists "form fields follow their form" on vizserve_pms_form_fields;

create policy "form fields follow their form"
  on vizserve_pms_form_fields for all to authenticated
  using (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and case
               when f.purpose = 'INTERNAL' then vizserve_pms_is_admin()
               else
                 vizserve_pms_manages_department(f.department_id)
                 or (f.department_id is null and f.created_by = auth.uid())
             end
    )
  )
  with check (
    exists (
      select 1 from vizserve_pms_forms f
       where f.id = form_id
         and case
               when f.purpose = 'INTERNAL' then vizserve_pms_is_admin()
               else
                 vizserve_pms_manages_department(f.department_id)
                 or (f.department_id is null and f.created_by = auth.uid())
             end
    )
  );


-- --- A.4 — WHO MAY READ THE ANSWERS -----------------------------------------
--
-- Was: an admin, or the lead of the department that owns the form. Now: an
-- admin. Ace, choosing between the three shapes on offer: everything admin only.
--
-- ⚠️ THIS IS THE ONE NARROWING THAT TAKES SOMETHING AWAY FROM SOMEBODY WHO HAD
-- IT. The other four close a door nobody has walked through — there are no
-- engagement forms yet. This one says a department lead no longer reads their
-- own team's survey results, which is a real capability and a deliberate
-- trade: an internal form is an admin instrument end to end, and a lead who can
-- read the answers but not the questions is a half-product that has to be
-- explained every time somebody meets it.
--
-- `manages_department` is gone rather than being narrowed, because for an admin
-- it is already true for every department — keeping it would be a condition
-- that never changes an answer.
-- ⚠️ TWO DROPS, AND THE SECOND ONE IS WHY THIS FILE IS ACTUALLY RE-RUNNABLE.
--
-- This policy is RENAMED, so the drop and the create name different things —
-- and a rename breaks the drop-then-create pattern the rest of the file relies
-- on. Run once, the old name is gone and the new one exists; run TWICE, the
-- first drop finds nothing, the create collides with its own previous run, and
-- the whole file aborts:
--
--   42710: policy "form responses readable by admins" for table
--          "vizserve_pms_form_responses" already exists
--
-- Which is a genuine failure, not a harmless one: the abort happens PART WAY
-- THROUGH, so anything below this line never runs. The audience narrowing in
-- Part B.4 is below this line.
--
-- The first drop must name the OLD policy, because that is what is in
-- production; the second must name the NEW one, because that is what a previous
-- run of this file left behind. Both, or the file converges only on a database
-- it has never touched.
drop policy if exists "form responses readable by the owning department"
  on vizserve_pms_form_responses;

drop policy if exists "form responses readable by admins"
  on vizserve_pms_form_responses;

create policy "form responses readable by admins"
  on vizserve_pms_form_responses for select to authenticated
  using (vizserve_pms_is_admin());


-- ===========================================================================
-- PART B.4 — THE TWO AUDIENCE NARROWINGS.
--
-- ⚠️ THESE TWO SHIP TOGETHER OR NOT AT ALL. See the header: the read decides
-- what /respond renders, the insert decides what may be written, and a form
-- somebody can no longer SEE is still a form they can POST to.
-- ===========================================================================

-- --- B.4.1 — WHAT /respond RENDERS ------------------------------------------
--
-- The first three conditions are 20260902110000 verbatim. The fourth is new.
--
-- ⚠️ THIS POLICY IS WHY AN ADMIN STILL SEES EVERY FORM: policies are OR'd, and
-- `forms readable in scope` already gives an admin every row. Narrowing this one
-- takes nothing away from the builder — it only stops a MEMBER seeing a form
-- that is not addressed to them.
--
-- ⚠️ IT IS ALSO RENAMED, AND THE DROP AND THE CREATE THEREFORE USE DIFFERENT
-- NAMES. The old one said "engagement", which 20260902135000 has just finished
-- arguing is the wrong word — an internal form is not always about engagement.
-- The name is free to fix HERE and nowhere else, because this is the one file
-- that was already dropping and re-creating the policy for its own reasons; a
-- rename on its own would have been a drop and a create bought for nothing.
--
-- ⚠️ THE DROP MUST NAME THE OLD POLICY, which is what exists in production. A
-- drop of the new name would find nothing, succeed silently (`if exists`), and
-- leave the ORIGINAL company-wide policy standing beside the narrowed one —
-- and policies are OR'd, so the audience check would be bypassed by the very
-- policy it was written to replace. That is the whole failure this file exists
-- to avoid, reintroduced by a tidy-up.
drop policy if exists "published engagement forms readable by staff"
  on vizserve_pms_forms;

-- Belt and braces: if this file has already run once under the new name, drop
-- that too, so the create below is always the only one standing.
drop policy if exists "published internal forms readable by their audience"
  on vizserve_pms_forms;

create policy "published internal forms readable by their audience"
  on vizserve_pms_forms for select to authenticated
  using (
    purpose = 'INTERNAL'
    and is_active
    and vizserve_pms_current_role() is not null
    and vizserve_pms_form_targets_me(id)
  );


-- --- B.4.2 — WHAT MAY BE WRITTEN --------------------------------------------
--
-- 20260902130000's policy with one condition added. Everything else is
-- unchanged and its reasoning still stands, restated in short:
--
--   `purpose`      a client form's submissions are `vizserve_pms_requests`.
--   `is_active`    a draft is not answerable.
--   the `case`     an anonymous form may not carry a name; a named one must
--                  carry the caller's own. Both halves are refusals, which is
--                  why it is one expression rather than two policies OR'd — an
--                  OR would permit whichever branch the caller could satisfy.
--   the audience   NEW. Being able to name a form id is not being invited to it.
drop policy if exists "form responses insertable by their author"
  on vizserve_pms_form_responses;

create policy "form responses insertable by their author"
  on vizserve_pms_form_responses for insert to authenticated
  with check (
    exists (
      select 1
        from vizserve_pms_forms f
       where f.id = form_id
         and f.purpose = 'INTERNAL'
         and f.is_active
         and vizserve_pms_form_targets_me(f.id)
         and case
               when f.is_anonymous then submitted_by is null
               else submitted_by = auth.uid()
             end
    )
  );


-- ===========================================================================
-- POST-FLIGHT — confirm the narrowings landed.
--
-- --- 1. All six policies exist and mention what they should. Expected: the two
-- audience ones contain `form_targets_me`, and the four Part A ones contain
-- `is_admin`.
--
-- select tablename, policyname, cmd,
--        coalesce(qual, '') || ' ' || coalesce(with_check, '') as definition
--   from pg_policies
--  where schemaname = 'public'
--    and policyname in (
--      'forms insertable by team leaders',
--      'forms updatable in scope',
--      'form fields follow their form',
--      'form responses readable by admins',
--      'published internal forms readable by their audience',
--      'form responses insertable by their author'
--    );
--
-- --- 2. ⚠️ THE TWO RENAMED-AWAY POLICIES MUST BE GONE, NOT MERELY SUPERSEDED.
-- Policies are OR'd, so either one left standing silently undoes this file: the
-- old responses policy would keep handing department leads the answers A.4 took
-- away, and the old forms policy would keep showing every internal form to every
-- colleague, audience or no audience. Expected: 0 and 0.
--
-- select count(*) from pg_policies
--  where schemaname = 'public'
--    and tablename = 'vizserve_pms_form_responses'
--    and policyname = 'form responses readable by the owning department';
--
-- select count(*) from pg_policies
--  where schemaname = 'public'
--    and tablename = 'vizserve_pms_forms'
--    and policyname = 'published engagement forms readable by staff';
--
-- --- 3. Every existing form is still open to everyone, so nothing narrowed by
-- surprise. Expected: every row true.
--
-- select id, name, audience_is_all_departments from vizserve_pms_forms;
--
-- --- 4. THE END-TO-END PROOF, which none of the above gives. Set a form to one
-- department, then sign in as somebody outside it and open /respond — the form
-- must not be listed, /respond/<slug> must 404, and a POST must be refused at
-- 42501. Signing in as somebody inside it must work unchanged.
-- ===========================================================================
