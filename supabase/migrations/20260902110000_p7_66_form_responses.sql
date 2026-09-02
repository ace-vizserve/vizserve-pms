-- ---------------------------------------------------------------------------
-- P7-66 Phase 4b — WHERE A STAFF ANSWER LANDS.
--
-- Amier, 2 Sep 2026. 20260902100000_p7_66_form_purpose.sql gave a form a
-- `purpose`. An EMPLOYEE_ENGAGEMENT form is filled in by signed-in staff and
-- its answers are COLLECTED, not approved — no client, no reference number, no
-- Gate 1, no task. It therefore never produces a `vizserve_pms_requests` row,
-- and until this table exists its answers have nowhere to go at all.
--
-- This is that table, and nothing else. A client form's submissions are still
-- `vizserve_pms_requests` and are still read at /requests; the two are
-- deliberately separate, for the same reason Internal Approvals and Client
-- Forms are separate (CLAUDE.md): different auth models, different lifecycles.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, pasting this file as it stands
-- at that moment. THIS FILE IS UNAPPLIED AS SHIPPED. Every P7 migration landed
-- that way and none is recorded in `supabase_migrations.schema_migrations`.
-- RUN THE PRE-FLIGHT BLOCK BELOW FIRST.
--
-- Re-runnable: the table and the indexes are `if not exists`, and ALL THREE
-- policies — the two on the new table and the one on `vizserve_pms_forms` —
-- are wrapped in a `pg_policies` guard. There is no `create policy if not
-- exists`, so a bare `create policy` aborts the whole file at 42710 on a
-- second paste; two of these were bare, which meant a re-run stopped BEFORE
-- the SELECT policy and before the forms policy and left the table
-- insert-only. Applied by hand, a half-applied file is the worst outcome
-- available, so the guard is on all three or it is on none.
--
-- ⚠️ THE APPLICATION CODE IS AHEAD OF THIS FILE, and in one place that matters
-- more than a broken screen — see the SECURITY NOTE below. Until this runs:
--   - `/respond` and `/respond/<slug>` fail with
--     `relation "vizserve_pms_form_responses" does not exist` (42P01), and so
--     does the Responses section of /forms/[id];
--   - `countFormSubmissions` (app/(app)/forms/submission-count.ts) FAILS
--     CLOSED. It counts both tables and refuses the save if either count
--     errors, so until this file is applied a purpose or reference-prefix
--     change is REFUSED with the Postgres sentence rather than silently
--     allowed against a count of zero. Every other save on that card is
--     unaffected — the count is only read when one of those two fields
--     actually changed. /forms/[id] skips the responses count on a
--     CLIENT_REQUEST form, so the four live client forms keep loading.
-- 42P01 is a MISSING RELATION and never a grant or an RLS problem, whatever
-- the message looks like at 5pm.
--
-- Back-out:
--   drop policy "published engagement forms readable by staff" on vizserve_pms_forms;
--   drop table vizserve_pms_form_responses;
-- in that order is not required — they are independent — but the forms policy
-- is the one that widens access, so drop it first if you are backing out under
-- pressure.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- ⚠️⚠️ SECURITY NOTE — WHY THIS FILE AND app/(app)/forms/actions.ts SHIP
-- TOGETHER, AND MUST NOT BE SPLIT.
--
-- `updateFormSettings` locks `purpose` once a form has submissions. The lock
-- counted `vizserve_pms_requests` and NOTHING ELSE — and an engagement form
-- never has one. So the moment this table exists, a pulse survey with a
-- thousand staff answers behind it still counts ZERO, the lock never engages,
-- and a team leader can flip the form to CLIENT_REQUEST. The applied CHECK
-- `is_public = (purpose = 'CLIENT_REQUEST')` then sets `is_public` true, and
-- `vizserve_pms_get_public_form` — whose where clause is
-- `slug and is_public and is_active`, and which has never heard of `purpose` —
-- serves the form, its questions and (through the same slug) the whole survey
-- at /request/<slug> to anybody with the URL. No session.
--
-- `countFormSubmissions` (app/(app)/forms/submission-count.ts) counts BOTH
-- tables as of the same commit as this file. THE WINDOW BETWEEN THIS TABLE
-- EXISTING AND THAT COUNT KNOWING ABOUT IT IS THE WHOLE VULNERABILITY. Do not
-- apply this migration from a branch that does not carry that change; do not
-- revert that change while this table exists.
-- `tests/unit/form-purpose-lock.test.ts` is the test of it.
--
-- ⚠️ AND IT COUNTS AS THE SERVICE ROLE, WHICH IS THE SECOND HALF OF THE SAME
-- FIX. Counting through the caller's client reopened the identical hole by a
-- different door: the SELECT policy on `vizserve_pms_requests`, and the one on
-- this table, are both `vizserve_pms_manages_department(form.department_id)` —
-- and that is FALSE for a team leader on an UNROUTED form (`department_id is
-- null`), which `assertCanEditForm` explicitly lets its author edit. A failing
-- POLICY RETURNS ZERO ROWS AND NO ERROR (CLAUDE.md), so the count came back
-- zero, the fail-closed branch never fired, the lock never engaged, and the
-- survey went public exactly as described above. A SECURITY CHECK MUST NOT
-- READ THROUGH A POLICY THAT CAN LEGITIMATELY EXCLUDE THE READER. Authority is
-- established before the count; the count is a data question.
-- ===========================================================================


-- ===========================================================================
-- ⚠️⚠️ ANONYMITY — DECIDED, AND THE ANSWER IS NO.
--
-- `submitted_by` is NOT NULL. Every row in this table names the person who
-- wrote it, and the SELECT policy below hands that name, beside their answers,
-- to an admin and to the team leader of the owning department.
--
-- WHAT THIS TABLE PROMISES:   a durable, attributable record of who answered
--                             what, and when.
-- WHAT IT DOES NOT PROMISE:   anonymity, pseudonymity, aggregation-only
--                             reading, or unlinkability of any kind.
--
-- That is a real consideration for the likeliest content — a pulse survey —
-- and it is being written down rather than solved, deliberately. A pulse survey
-- people believe is anonymous, run on a table that names them, is far worse
-- than one everybody knows is attributed: the first is a broken promise and the
-- second is merely a design constraint people can answer around. So:
--
--   ⚠️ NO SCREEN, EMAIL OR FORM DESCRIPTION BUILT ON THIS TABLE MAY DESCRIBE
--   ITSELF AS ANONYMOUS. /respond says so on the page, in the person's sight,
--   before they answer.
--
-- Anonymity is NOT a flag that can be added here later. Dropping the name means
-- either giving up "has this person already answered / been asked" entirely, or
-- keeping a separate ledger of who responded with no join back to the answers —
-- a different table, a different set of policies, and a decision about what
-- happens when an admin needs to chase the eight people who have not replied.
-- If it is ever wanted, it is its own ticket with its own threat model, and
-- this table stays as it is for the forms that want a name on the answer
-- (kudos nominations, sign-ups, anything with a follow-up).
-- ===========================================================================


-- ===========================================================================
-- PRE-FLIGHT — RUN THIS FIRST, ON ITS OWN. Nothing here is destructive; it
-- only reports. Do not apply the file until the first two return zero.
--
-- --- 1. THE TABLE MUST NOT ALREADY EXIST WITH A DIFFERENT SHAPE ------------
-- `create table if not exists` is silent about a table that is already there
-- and wrong, which is the one way this file can appear to succeed and leave
-- the app broken. Expected: 0.
--
-- select count(*) from information_schema.tables
--  where table_schema = 'public' and table_name = 'vizserve_pms_form_responses';
--
-- --- 2. THE FORMS POLICY NAME MUST BE FREE --------------------------------
-- Expected: 0. A non-zero result means somebody has already added a policy of
-- this name; read it before this file replaces it.
--
-- select count(*) from pg_policies
--  where schemaname = 'public' and tablename = 'vizserve_pms_forms'
--    and policyname = 'published engagement forms readable by staff';
--
-- --- 3. WHAT THE NEW FORMS POLICY WILL EXPOSE, AND TO WHOM -----------------
-- This file widens SELECT on `vizserve_pms_forms` so that every active staff
-- member can read PUBLISHED ENGAGEMENT FORMS — they have to, or /respond has
-- nothing to render. It exposes no client form and no draft. Measured 2 Sep
-- 2026 the answer is 0 rows, because no engagement form exists yet.
--
-- select id, name, slug, department_id, is_active
--   from vizserve_pms_forms
--  where purpose = 'EMPLOYEE_ENGAGEMENT' and is_active
--  order by created_at;
--
-- READ THE LIST. Anything on it becomes readable by every signed-in colleague
-- the moment this file is applied — which is the intent, and is worth seeing
-- once rather than assuming. Readable, not editable, and not their ANSWERS:
-- see the policy note at the foot of this file.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The table.
--
-- `field_values` is jsonb keyed by `field_key`, the SAME storage shape as
-- `vizserve_pms_requests.field_values` (§1 of the P7-66 plan: the library keys
-- values by entity id, the database keys them by field key, and
-- lib/form-builder/values.ts is the only thing that crosses between them).
-- Keeping the two identical is what lets one set of entity declarations
-- validate a client submission and a staff response with no branch.
--
-- No `updated_at`, and no update or delete policy: A SUBMITTED RESPONSE IS A
-- RECORD. Somebody who answered a survey wrongly submits again — which is why
-- there is no unique constraint on (form_id, submitted_by); see the note on
-- that below.
--
-- `on delete cascade` on `form_id`: a form is deletable by an admin
-- (`forms deletable by admin`, 20260729100300_p1_rls_policies.sql:52), and
-- answers to a form that no longer exists are unreadable — there is no schema
-- left to say what the keys in `field_values` mean.
--
-- `on delete restrict` on `submitted_by`, matching every other authored row in
-- this schema: `vizserve_pms_users` is never hard-deleted (users are
-- deactivated), so this is a guard against a delete nobody intends rather than
-- a workflow.
-- ---------------------------------------------------------------------------
create table if not exists vizserve_pms_form_responses (
  id           uuid primary key default gen_random_uuid(),
  form_id      uuid not null references vizserve_pms_forms (id) on delete cascade,
  submitted_by uuid not null references vizserve_pms_users (id) on delete restrict,
  field_values jsonb not null default '{}'::jsonb
    constraint vizserve_pms_form_responses_field_values_is_object
    check (jsonb_typeof(field_values) = 'object'),
  submitted_at timestamptz not null default now()
);

comment on table vizserve_pms_form_responses is
  'P7-66 Phase 4b. One staff answer to one EMPLOYEE_ENGAGEMENT form. '
  'NOT ANONYMOUS — submitted_by names the person and the SELECT policy shows '
  'that name beside their answers to an admin and to the team leader of the '
  'owning department. Nothing built on this table may call itself anonymous. '
  'A client form''s submissions are vizserve_pms_requests, never this. '
  'Append-only: no update policy, no delete policy — a submitted response is a '
  'record.';

comment on column vizserve_pms_form_responses.field_values is
  'The answers, keyed by vizserve_pms_form_fields.field_key — the SAME shape '
  'as vizserve_pms_requests.field_values, so one set of entity declarations '
  '(lib/form-builder/entities.ts) validates both. Archived fields keep their '
  'keys here: a key whose field was later archived is still a real answer, '
  'which is why the Responses table renders a column for it.';

comment on column vizserve_pms_form_responses.submitted_by is
  'Who answered. NOT NULL and never anonymised. See the table comment.';


-- ---------------------------------------------------------------------------
-- Indexes.
--
-- `(form_id, submitted_at desc)` is the Responses table's only query: one
-- form, newest first, paged. It also serves `count(*) where form_id = ?`,
-- which is the purpose lock's second count.
--
-- `gin (field_values)` is for the answer searching this screen does not do yet.
-- Added now rather than later because it is cheap on an empty table and
-- because the roadmap's item 5 — moving the field_key immutability guard onto
-- the jsonb — has to ask "does any response hold this key?", which is exactly
-- what a GIN index on jsonb answers.
-- ---------------------------------------------------------------------------
create index if not exists vizserve_pms_form_responses_form_submitted_idx
  on vizserve_pms_form_responses (form_id, submitted_at desc);

create index if not exists vizserve_pms_form_responses_values_idx
  on vizserve_pms_form_responses using gin (field_values);


-- ---------------------------------------------------------------------------
-- RLS and grants.
--
-- The block below is the shape of
-- 20260825140000_p7_46_calendar_events.sql:103-118, with ONE deliberate
-- difference: THE GRANT IS WRITTEN OUT.
--
-- `20260729110000_p0_06_grants.sql` sets ALTER DEFAULT PRIVILEGES so a table
-- created later inherits `select, insert, update, delete` for `authenticated`
-- — but ONLY for tables created by the same role that ran that file. This
-- migration is pasted into the SQL editor by hand, which is not obviously that
-- role, and "permission denied for table vizserve_pms_form_responses" on a
-- brand-new table is the single most expensive twenty minutes in this repo's
-- history (CLAUDE.md: a failing POLICY returns zero rows; a missing GRANT
-- returns permission denied — never confuse the two). So it is stated.
--
-- ⚠️ ONLY `select, insert`. Update and delete are withheld at the PRIVILEGE
-- level as well as by having no policy, so append-only holds even if somebody
-- later adds a permissive `for all` policy by reflex. Two locks, because the
-- cheap one costs a line.
--
-- `service_role` needs nothing here: it holds `all privileges on all tables`
-- from the same file and bypasses policies (but not privileges).
-- ---------------------------------------------------------------------------
alter table vizserve_pms_form_responses enable row level security;

revoke all on vizserve_pms_form_responses from anon;

grant select, insert on vizserve_pms_form_responses to authenticated;
grant all privileges on vizserve_pms_form_responses to service_role;


-- --- INSERT: your own row, on a form that is actually taking answers -------
--
-- Three conditions, and each one is load-bearing:
--
--   `submitted_by = auth.uid()`  nobody files an answer under a colleague's
--                                name. This is the whole integrity of the
--                                table — an attributed record that anyone can
--                                attribute to anyone else is not a record.
--   `purpose = 'EMPLOYEE_ENGAGEMENT'`  a client request has a lifecycle
--                                (reference number, Gate 1, SLA) that this
--                                table does not participate in. A response
--                                against a client form would be an answer
--                                nothing reads.
--   `f.is_active`                an unpublished form is not taking answers.
--                                The same test /respond applies, restated
--                                where it cannot be bypassed.
--
-- The EXISTS reads `vizserve_pms_forms` as the caller, so it is itself subject
-- to that table's SELECT policies — and the staff policy at the bottom of this
-- file is what makes the row visible to a member. The two agree by
-- construction: you may answer exactly the forms you can see at /respond.
-- Stated because a policy whose subquery is silently filtered by another
-- policy is the kind of thing that reads as working and returns zero rows.
--
-- Guarded so the file is re-runnable — see the header. There is no
-- `create policy if not exists`, and a bare `create policy` on a second paste
-- aborts at 42710 before anything below it runs.
do $$
begin
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'vizserve_pms_form_responses'
       and policyname = 'form responses insertable by their author'
  ) then
    create policy "form responses insertable by their author"
      on vizserve_pms_form_responses for insert to authenticated
      with check (
        submitted_by = auth.uid()
        and exists (
          select 1
            from vizserve_pms_forms f
           where f.id = form_id
             and f.purpose = 'EMPLOYEE_ENGAGEMENT'
             and f.is_active
        )
      );
  end if;
end
$$;

-- --- SELECT: the admin, and the lead of the department that owns the form --
--
-- `vizserve_pms_manages_department` IS admin-or-lead in one call
-- (20260729090100_p0_05_authorization_functions.sql:75) — it returns true for
-- an admin whatever it is passed, and for a team leader only for a department
-- they actually lead. So there is no separate admin clause to keep in step.
--
-- ⚠️ THE AUTHOR CANNOT READ THEIR OWN RESPONSE BACK. That is deliberate and it
-- has one consequence the application must respect: an insert may NOT use
-- `.select()`, because PostgREST applies the SELECT policy to the returned row
-- and the write would appear to fail on a row that was written. See
-- app/(app)/respond/actions.ts, which inserts and returns nothing.
--
-- The alternative — a "responses readable by their author" policy — was
-- considered and left out. Nothing on /respond needs it: the page confirms the
-- submission from the action's own result, and there is no "my answers" screen
-- to build it for. A read nobody uses is a read that can leak later.
--
-- ⚠️ AN UNROUTED FORM (`department_id is null`) IS ADMIN-ONLY, because
-- `vizserve_pms_manages_department(null)` is true for an admin and false for a
-- lead. Nothing stops a team leader publishing an engagement form before
-- choosing its department, and if they do, they will not see its answers. The
-- Responses section on /forms/[id] says so rather than showing an empty table.
--
-- Guarded, for the same reason as the INSERT policy above. THIS is the one a
-- half-applied re-run used to skip, which would have left the table
-- insert-only: answers going in and nobody able to read them.
do $$
begin
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'vizserve_pms_form_responses'
       and policyname = 'form responses readable by the owning department'
  ) then
    create policy "form responses readable by the owning department"
      on vizserve_pms_form_responses for select to authenticated
      using (
        exists (
          select 1
            from vizserve_pms_forms f
           where f.id = form_id
             and vizserve_pms_manages_department(f.department_id)
        )
      );
  end if;
end
$$;

-- NO UPDATE POLICY AND NO DELETE POLICY, and their absence is the design.
-- Postgres denies what no policy permits, so this is enforcement rather than
-- omission — but it reads as an oversight to the next person, hence the line.
-- A response that was wrong is answered again; the record of both stands.


-- ---------------------------------------------------------------------------
-- ⚠️ THE FORM ITSELF HAS TO BE READABLE, OR /respond RENDERS NOTHING.
--
-- Every existing SELECT policy on `vizserve_pms_forms`
-- (20260729100300_p1_rls_policies.sql:26-35) is `manages_department` or
-- "the author, while unrouted" — both team-leader-and-up. A MEMBER CANNOT READ
-- A FORM ROW AT ALL today, which was correct while forms were a builder screen
-- and their public face went through the SECURITY DEFINER
-- `vizserve_pms_get_public_form`. An engagement form has no such function: it
-- is read by a signed-in person through ordinary RLS, so the policy has to
-- exist.
--
-- Narrow on purpose, and each clause earns its place:
--   `purpose = 'EMPLOYEE_ENGAGEMENT'`  NO CLIENT FORM IS WIDENED BY THIS FILE.
--                                      A client form's questions stay visible
--                                      only to the department that owns it,
--                                      exactly as before.
--   `is_active`                        a draft is nobody's business but its
--                                      author's until it is published.
--   `vizserve_pms_current_role() is not null`  an ACTIVE user with a role row.
--                                      The same test the events calendar uses
--                                      for "everybody signed in", and it is
--                                      what keeps a deactivated account out.
--
-- ⚠️⚠️ THIS IS THE *FILL-IN* READ, AND IT IS NOT THE BUILDER'S SCOPE.
--
-- Policies are OR'd, so this only ever ADDS visibility — which is exactly the
-- problem it has to be read with. After it, a team leader of VizMedia can
-- SELECT VizBytes' published engagement forms, because they too are staff and
-- may answer that survey. Right for /respond. WRONG for /forms, which listed
-- those forms as theirs to edit, and for /forms/[id], which rendered the whole
-- question schema in an editor.
--
-- ⚠️ AND NO POLICY CAN FIX THAT, because the two readers do not differ in WHICH
-- ROWS THEY MAY SEE — they differ in WHICH QUESTION THEY ARE ASKING, and a
-- row-level policy is never told that:
--
--   FILLING IN     any active staff member, any published engagement form.
--                  This policy. A member holds no other policy on this table,
--                  so without it /respond renders nothing at all.
--   ADMINISTERING  admin, or the lead of the owning department, or the author
--                  of a form with no department yet. The four P1 policies
--                  (20260729100300_p1_rls_policies.sql:26-53), unchanged.
--
-- So the administrative scope moved to the two builder call sites, in
-- `administersForm` (app/(app)/forms/administers.ts) — the same two clauses
-- `assertCanEditForm` already enforced on every WRITE, so a form the builder
-- lists is a form the builder can save. That is a deliberate exception to
-- CLAUDE.md's "list queries carry no department filter": the filter is not a
-- restatement of this policy, it is the half of the question this policy
-- cannot express. The exception is argued in that file rather than assumed.
--
-- ⚠️ WHAT IS STILL NARROW HERE, and each clause is load-bearing: nothing
-- unpublished, nothing belonging to a client, and nobody deactivated. Writes
-- are untouched — `forms updatable in scope` never widened — so a lead reading
-- another department's engagement form cannot change a character of it.
--
-- ⚠️ THIS ALSO WIDENS THE `schema` COLUMN — the questions — to every colleague.
-- That is the point: they are about to answer them. It is worth saying out loud
-- because `schema` is a jsonb blob rather than a column somebody thinks about,
-- and a client form's schema is NOT included by this policy.
--
-- ⚠️ WHAT THIS POLICY DOES *NOT* WIDEN: the answers. Those are
-- `vizserve_pms_form_responses`, whose SELECT policy above is admin-or-lead of
-- the owning department. Seeing a survey is not seeing what anyone said.
--
-- Guarded so the file is re-runnable: there is no `create policy if not
-- exists`.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_policies
     where schemaname = 'public'
       and tablename = 'vizserve_pms_forms'
       and policyname = 'published engagement forms readable by staff'
  ) then
    create policy "published engagement forms readable by staff"
      on vizserve_pms_forms for select to authenticated
      using (
        purpose = 'EMPLOYEE_ENGAGEMENT'
        and is_active
        and vizserve_pms_current_role() is not null
      );
  end if;
end
$$;
