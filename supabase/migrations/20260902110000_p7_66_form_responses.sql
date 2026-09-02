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
-- ⚠️⚠️ APPLIED TO LIVE PRODUCTION ON 2 SEP 2026, BY HAND. THIS FILE NOW
-- DESCRIBES THE DATABASE RATHER THAN PROPOSING IT, so it is not to be edited:
-- a change here changes the record of what was run without changing what is
-- running. Anything further needs a NEW file, applied the same way.
--
-- Like every P7 migration it was pasted into the Supabase SQL editor and is
-- NOT recorded in `supabase_migrations.schema_migrations`, so the CLI still
-- believes it is pending. The pre-flight and the re-runnability notes below are
-- kept as they were written — they are what made the paste safe, and they are
-- what a re-paste on a fresh environment would depend on.
--
-- ⚠️ 20260902105000_p7_66_form_anonymity.sql WENT FIRST, and had to. This
-- file's INSERT policy reads `vizserve_pms_forms.is_anonymous`, which that file
-- adds — the other order fails with `column f.is_anonymous does not exist`
-- (42703), and because the policy is inside a `do $$` guard the failure aborts
-- the file mid-way. Filename order is apply order.
--
-- Re-runnable: the table and the indexes are `if not exists`, the function at
-- the foot is `create or replace`, and ALL THREE policies — the two on the new table and the one on `vizserve_pms_forms` —
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
-- Back-out, AND THE ORDER MATTERS NOW:
--   1. re-run the body of `vizserve_pms_form_field_protect` from
--      20260729100000_p1_01_forms.sql:111 — the version at the foot of this
--      file reads `vizserve_pms_form_responses`, so dropping that table while
--      it stands leaves every field delete and rename failing at 42P01;
--   2. drop policy "published engagement forms readable by staff" on vizserve_pms_forms;
--   3. drop table vizserve_pms_form_responses;
-- Steps 2 and 3 are independent of each other, but the forms policy is the one
-- that widens access, so drop it first if you are backing out under pressure.
-- Step 1 is not optional and is not last.
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
-- ⚠️⚠️ ANONYMITY IS A PER-FORM CHOICE, AND `submitted_by` IS NULLABLE.
--
-- Revised 2 Sep 2026, before this file was ever applied. It previously said
-- anonymity was decided against and `submitted_by` was NOT NULL. That was
-- wrong about the requirement: an internal form is not only a pulse survey, and
-- a kudos nomination, an incident report or a grievance form only works if the
-- person answering is not named. Whether a given form is anonymous is the
-- creator's decision and lives in `vizserve_pms_forms.is_anonymous`
-- (20260902105000_p7_66_form_anonymity.sql). This table follows it.
--
-- WHAT AN ANONYMOUS FORM PROMISES:   no name is written. `submitted_by` is
--                                    NULL, and there is nothing in the row, the
--                                    export or the index that identifies who
--                                    wrote it.
-- WHAT A NAMED FORM PROMISES:        a durable, attributable record of who
--                                    answered what, and when.
-- WHAT NEITHER PROMISES:             that the CHOICE can be revisited. It locks
--                                    on the first answer, in the database.
--
-- ⚠️ NULLABLE IS NOT "OPTIONAL", AND THE POLICY IS WHAT MAKES THAT TRUE. The
-- column being nullable does not mean an application may leave it out when it
-- feels like it: the INSERT policy below reads the FORM'S flag and requires
-- `submitted_by is null` on an anonymous form and `= auth.uid()` on a named
-- one. Neither is a default the caller chooses. A named form cannot receive an
-- unattributed answer and an anonymous form cannot receive an attributed one,
-- and neither can be arranged by a client that lies about which it is sending.
--
-- ⚠️ ANONYMOUS IS NOT UNAUTHENTICATED. The person signs in to reach
-- /respond/<slug>; `anon` holds no privileges here and the policy is `to
-- authenticated`. Only the RECORDING changes. That is what lets an anonymous
-- form still be restricted to active staff.
--
-- ⚠️ TWO THINGS AN ANONYMOUS FORM CANNOT DO, and they are consequences rather
-- than omissions:
--
--   IT CANNOT LIMIT ANYBODY TO ONE ANSWER. Enforcing that means recording who
--   answered, which is the thing being avoided. There is no unique constraint
--   here and there cannot be one; a determined person can answer twenty times.
--   A form that needs one-per-person needs to be a named form.
--
--   IT CANNOT SAY WHO HAS NOT REPLIED YET. Same reason. If that is ever wanted
--   without giving up anonymity it is a SEPARATE ledger — a table recording
--   THAT somebody answered, with no join back to WHAT they answered — and it is
--   its own ticket with its own threat model. Nothing here forecloses it: such
--   a table would be purely additive and would not change a single row written
--   by this one.
--
-- ⚠️ NO SCREEN, EMAIL OR FORM DESCRIPTION MAY DESCRIBE A NAMED FORM AS
-- ANONYMOUS. /respond states which kind it is, on the page, in the person's
-- sight, BEFORE they answer — and it states it either way, because a promise
-- that arrives after the fact is not a promise.
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
-- --- 3. THE INSERT POLICY MUST NOT ALREADY EXIST IN ITS OLD SHAPE ---------
-- The guard around it skips a policy that is already there, and an earlier
-- paste of this file created one whose check was a flat
-- `submitted_by = auth.uid()`. Kept, it refuses every anonymous submission
-- while the form insists on being anonymous. Expected: 0. If it returns 1,
-- read it, then
--   drop policy "form responses insertable by their author" on vizserve_pms_form_responses;
-- and apply this file.
--
-- select count(*) from pg_policies
--  where schemaname = 'public' and tablename = 'vizserve_pms_form_responses'
--    and policyname = 'form responses insertable by their author';
--
-- --- 4. THE ANONYMITY COLUMN MUST BE THERE ALREADY. Expected: 1.
--
-- select count(*) from information_schema.columns
--  where table_schema = 'public' and table_name = 'vizserve_pms_forms'
--    and column_name = 'is_anonymous';
--
-- --- 5. WHAT THE NEW FORMS POLICY WILL EXPOSE, AND TO WHOM -----------------
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
-- a workflow. It is unaffected by the column being nullable — a NULL simply
-- references nothing, which is the whole point on an anonymous form.
--
-- ⚠️ `submitted_by` IS NULLABLE, AND ITS NULL MEANS ONE SPECIFIC THING: the
-- form is anonymous and no name was ever recorded. It does not mean "unknown",
-- "not yet filled in" or "the writer left". The INSERT policy below ties the
-- null to the form's `is_anonymous` flag so the two can never disagree, and
-- that flag is locked once any answer exists
-- (20260902105000_p7_66_form_anonymity.sql). So the meaning of a NULL here is
-- fixed for the life of the row.
-- ---------------------------------------------------------------------------
create table if not exists vizserve_pms_form_responses (
  id           uuid primary key default gen_random_uuid(),
  form_id      uuid not null references vizserve_pms_forms (id) on delete cascade,
  submitted_by uuid references vizserve_pms_users (id) on delete restrict,
  field_values jsonb not null default '{}'::jsonb
    constraint vizserve_pms_form_responses_field_values_is_object
    check (jsonb_typeof(field_values) = 'object'),
  submitted_at timestamptz not null default now()
);

comment on table vizserve_pms_form_responses is
  'P7-66 Phase 4b. One staff answer to one EMPLOYEE_ENGAGEMENT form. '
  'ATTRIBUTED OR ANONYMOUS PER FORM, decided by vizserve_pms_forms.is_anonymous '
  'and enforced by the INSERT policy: on a named form submitted_by is the '
  'author and the SELECT policy shows that name beside their answers to an '
  'admin and to the team leader of the owning department; on an anonymous form '
  'submitted_by is NULL and no name was ever written. The flag locks on the '
  'first answer, so a row''s promise cannot change under it. A screen may '
  'describe a form as anonymous ONLY when that flag is set. '
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
  'Who answered, or NULL on a form whose is_anonymous flag is set — in which '
  'case no name was EVER written, rather than being hidden. Which of the two '
  'applies is decided by vizserve_pms_forms.is_anonymous and enforced by the '
  'INSERT policy, and that flag locks on the first answer. A NULL here never '
  'means "unknown".';


-- ---------------------------------------------------------------------------
-- Indexes.
--
-- `(form_id, submitted_at desc)` is the Responses table's only query: one
-- form, newest first, paged. It also serves `count(*) where form_id = ?`,
-- which is the purpose lock's second count.
--
-- `gin (field_values jsonb_path_ops)` is for the answer searching this screen
-- does not do yet. Added now rather than later because it is cheap on an empty
-- table.
--
-- ⚠️ THE OPCLASS IS NOT A DETAIL, AND THE DEFAULT ONE LOSES ANSWERS.
-- `jsonb_ops` indexes every key AND EVERY VALUE as its own index entry, and a
-- GIN entry cannot exceed roughly 2700 bytes. One textarea answer longer than
-- that fails the INSERT outright with "index row size ... exceeds maximum" and
-- THE WHOLE RESPONSE IS LOST — somebody's survey answer, refused for being
-- long, with a message about an index. Nothing in `lib/form-builder/entities.ts`
-- caps a textarea, so this is reached by typing rather than by attack.
--
-- `jsonb_path_ops` stores a HASH of each path/value pair instead, so every
-- entry is fixed-size and no answer is too long to index. It is also smaller
-- and faster for the containment queries a search would actually run.
--
-- ⚠️ WHAT IT COSTS, stated because it is the only argument the other way:
-- `jsonb_path_ops` serves containment (`@>`) ONLY. It does not serve
-- key-existence (`?`), which is what the R5 guard below asks. So that guard
-- scans instead — and that is fine, because it always asks about ONE form and
-- `vizserve_pms_form_responses_form_submitted_idx` narrows to that form first.
-- An index that can refuse a write is not worth a planner improvement.
-- ---------------------------------------------------------------------------
create index if not exists vizserve_pms_form_responses_form_submitted_idx
  on vizserve_pms_form_responses (form_id, submitted_at desc);

-- ⚠️ `create index if not exists` IS SILENT ABOUT AN INDEX THAT ALREADY
-- EXISTS WITH THE WRONG OPCLASS, which in a file documented as re-runnable is
-- the one way the fix above can appear to apply and not have. An earlier copy
-- of this file created this index with the default `jsonb_ops`; a paste of the
-- new copy over it would leave `jsonb_ops` in place and the long-answer INSERT
-- failure exactly where it was, with the migration reporting success.
--
-- So the wrong one is dropped first, and ONLY the wrong one — the guard reads
-- the opclass rather than dropping unconditionally, so a re-run of the correct
-- file does not churn an index it is happy with.
do $$
begin
  if exists (
    select 1
      from pg_index ix
      join pg_class i on i.oid = ix.indexrelid
      join pg_opclass oc on oc.oid = ix.indclass[0]
      join pg_namespace n on n.oid = i.relnamespace
     where n.nspname = 'public'
       and i.relname = 'vizserve_pms_form_responses_values_idx'
       and oc.opcname <> 'jsonb_path_ops'
  ) then
    drop index public.vizserve_pms_form_responses_values_idx;
  end if;
end
$$;

create index if not exists vizserve_pms_form_responses_values_idx
  on vizserve_pms_form_responses using gin (field_values jsonb_path_ops);


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
-- ⚠️ A POSITIVE GRANT WITHHOLDS NOTHING, AND THIS BLOCK USED TO PRETEND IT
-- DID. It read `grant select, insert ... to authenticated` and claimed two
-- locks on append-only. It had one — the missing policy. A GRANT is additive:
-- naming two privileges does not take the other two away, and the other two
-- are exactly what `20260729110000_p0_06_grants.sql`'s ALTER DEFAULT
-- PRIVILEGES hands `authenticated` on every table created afterwards
-- (`select, insert, update, delete`). Which is the SAME case the written-out
-- grant exists to survive: if the defaults applied, this table shipped
-- updatable and deletable by every signed-in user, one permissive `for all`
-- policy away from being both. Only a REVOKE subtracts.
--
-- So the privileges are reset to nothing and then stated. `revoke all` is
-- right whether the defaults reached this table or not, it is idempotent, and
-- it is the only line here that does not depend on knowing which role pasted
-- the file.
--
-- ⚠️ INSERT IS COLUMN-LEVEL, AND THAT IS A SECOND FIX, NOT TIDINESS. A
-- table-wide insert privilege lets the caller name EVERY column, and the
-- policy's `with check` below constrains only `submitted_by` and the form — so
-- any staff member could POST their own `submitted_at` and pin their row to
-- the top of the `submitted_at desc` Responses table, or choose their own
-- `id`. No policy can say "this column was not supplied"; a privilege can, and
-- privileges are checked BEFORE policies. The three columns named are exactly
-- the three `app/(app)/respond/actions.ts` inserts. `id` and `submitted_at`
-- are left to their defaults because when a row was written is the database's
-- statement about it, not the client's.
--
-- ⚠️ AND A COLUMN GRANT IS NOT A RESTRICTION ON A TABLE GRANT. Where both
-- exist the table-level one wins outright, so the `revoke all` above is what
-- makes the column list mean anything at all. The two lines are one fix.
--
-- Update and delete are now withheld at the PRIVILEGE level as well as by
-- having no policy — the two locks the file originally claimed. A submitted
-- response is a record.
--
-- `service_role` needs nothing here: it holds `all privileges on all tables`
-- from the same file and bypasses policies (but not privileges). Stated
-- anyway, for the same reason `authenticated` is — and it must come after the
-- revokes, which name `authenticated` only and leave it untouched.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_form_responses enable row level security;

revoke all on vizserve_pms_form_responses from anon;
revoke all on vizserve_pms_form_responses from authenticated;

grant select on vizserve_pms_form_responses to authenticated;
grant insert (form_id, submitted_by, field_values)
  on vizserve_pms_form_responses to authenticated;

grant all privileges on vizserve_pms_form_responses to service_role;


-- --- INSERT: one answer, shaped by what the form promised ------------------
--
-- Three conditions, and each one is load-bearing:
--
--   the identity rule            decided by the FORM, not by the caller — see
--                                below. This is the whole integrity of the
--                                table.
--   `purpose = 'EMPLOYEE_ENGAGEMENT'`  a client request has a lifecycle
--                                (reference number, Gate 1, SLA) that this
--                                table does not participate in. A response
--                                against a client form would be an answer
--                                nothing reads.
--   `f.is_active`                an unpublished form is not taking answers.
--                                The same test /respond applies, restated
--                                where it cannot be bypassed.
--
-- ⚠️⚠️ THE IDENTITY RULE READS THE FORM, WHICH IS WHY IT IS INSIDE THE
-- EXISTS.
--
-- This used to be a flat `submitted_by = auth.uid()`. That single expression
-- was doing two jobs — "nobody files an answer under a colleague's name" and
-- "every row has an author" — and the second one is exactly what an anonymous
-- form must not do. Making the column nullable without changing this policy
-- would have been the worst of both: the app could write a NULL on any form,
-- and a named form's guarantee would rest on the application remembering to
-- send the id.
--
-- So the rule is a CASE over the form's own flag, evaluated in the same
-- subquery that already reads the form:
--
--   is_anonymous  →  `submitted_by is null`.   A name may not be attached even
--                    if the caller sends one. Somebody POSTing their own uuid
--                    to an anonymous form is refused, not silently accepted.
--   otherwise     →  `submitted_by = auth.uid()`.  Unchanged, and still the
--                    thing that stops an answer being filed under a colleague.
--
-- Neither branch is a default the caller selects. THE FORM DECIDES, the
-- database checks, and `vizserve_pms_forms.is_anonymous` is locked once any
-- answer exists — so the shape of every row on a form is settled before its
-- first answer and cannot be changed underneath the rows already written.
--
-- The EXISTS reads `vizserve_pms_forms` as the caller, so it is itself subject
-- to that table's SELECT policies — and the staff policy at the bottom of this
-- file is what makes the row visible to a member. The two agree by
-- construction: you may answer exactly the forms you can see at /respond.
-- Stated because a policy whose subquery is silently filtered by another
-- policy is the kind of thing that reads as working and returns zero rows.
--
-- ⚠️ `to authenticated` EITHER WAY. Anonymous is about what is RECORDED, not
-- about who may reach the form: the person is signed in, `anon` holds no
-- privileges on this table at all, and an anonymous form is still restricted to
-- active staff by the policy on `vizserve_pms_forms`.
--
-- Guarded so the file is re-runnable — see the header. There is no
-- `create policy if not exists`, and a bare `create policy` on a second paste
-- aborts at 42710 before anything below it runs.
--
-- ⚠️ IF THIS POLICY ALREADY EXISTS FROM AN EARLIER PASTE OF THIS FILE, THE
-- GUARD SKIPS IT AND YOU KEEP THE OLD `submitted_by = auth.uid()` VERSION,
-- under which every anonymous submission is refused. The pre-flight below
-- checks for it; drop the policy and re-run if it reports one.
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
        exists (
          select 1
            from vizserve_pms_forms f
           where f.id = form_id
             and f.purpose = 'EMPLOYEE_ENGAGEMENT'
             and f.is_active
             and case
                   when f.is_anonymous then submitted_by is null
                   else submitted_by = auth.uid()
                 end
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
-- ⚠️ AND ON AN ANONYMOUS FORM IT IS NOT MERELY DELIBERATE, IT IS STRUCTURAL.
-- There is no author to match against: `submitted_by` is NULL, so no policy
-- could return "your own" rows even if one were wanted. A "my answers" screen
-- is impossible on an anonymous form, by construction rather than by choice —
-- which is the same fact, seen from the other side, as nobody else being able
-- to attribute them either.
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


-- ---------------------------------------------------------------------------
-- ⚠️⚠️ R5 NOW COVERS ENGAGEMENT FORMS, AND UNTIL THIS BLOCK IT DID NOT.
--
-- `vizserve_pms_form_field_protect` (20260729100000_p1_01_forms.sql:111) is the
-- guard that makes `field_key` immutable and a field undeletable once somebody
-- has answered it. It counts `vizserve_pms_requests` AND NOTHING ELSE.
--
-- An engagement form never produces a request. So the moment the table above
-- exists, a pulse survey with two hundred answers behind it has a guard that
-- finds NO DATA TO PROTECT: renaming a question's key succeeds, deleting the
-- question succeeds, and every answer already given survives in
-- `field_values` under a key no field claims any more. Unlabelled orphan
-- columns in the Responses table, and no way back — nothing records what the
-- key used to be. This is the same failure D20/R5 exists to prevent, arriving
-- through the door the new table opened.
--
-- The fix is one more EXISTS. It is the whole of roadmap item 5's REQUESTS-
-- side twin applied to responses, and it belongs in this file rather than a
-- later one because the hole opens when the table does.
--
-- ⚠️ SHIPS WITH THE TABLE OR NOT AT ALL, for the same reason the purpose lock
-- does: the window between the table existing and the guard knowing about it
-- IS the vulnerability.
--
-- ⚠️⚠️ AND IT IS NOW `security definer`, WHICH IS THE OTHER HALF OF THE FIX.
--
-- The guard was `security invoker`, so its two EXISTS ran under the CALLER's
-- RLS. Both relevant policies are `vizserve_pms_manages_department(
-- f.department_id)`, and that is FALSE for a team leader when
-- `department_id is null`. A failing policy returns ZERO ROWS AND NO ERROR
-- (CLAUDE.md) — so on an unrouted form the guard finds no answers, concludes
-- there is nothing to protect, and permits the rename or the delete.
--
-- The applied file (20260901150000_p7_66_form_schema.sql:293-304) argued this
-- was unreachable: an unrouted form cannot be ACTIVE
-- (`vizserve_pms_forms_active_requires_department`), so nobody can have
-- submitted to it. That argument does not survive the form being unrouted
-- AFTERWARDS. `updateFormSettings` locks `purpose` and `reference_prefix` once
-- a form has submissions and NOTHING ELSE — so a lead may unpublish a survey
-- with two hundred answers behind it, clear its department, and keep editing
-- it through the unrouted-author carve-out
-- (`forms readable by author while unrouted`). At that point the guard is
-- blind and every key is renameable.
--
-- ⚠️ DEFINER GRANTS THIS FUNCTION NOTHING IT COULD ABUSE. It is a trigger
-- that reads two tables and either raises or returns; it exposes no row to any
-- caller, takes no argument but the row being written, and has a pinned
-- `search_path`. Its whole effect is to REFUSE more often. That is the
-- difference between it and `vizserve_pms_save_form_schema`, which is invoker
-- precisely because definer there would replace RLS with a hand-copied
-- department check — there is nothing to hand-copy here.
--
-- A SECURITY CHECK MUST NOT READ THROUGH A POLICY THAT CAN LEGITIMATELY
-- EXCLUDE THE READER. That is the same sentence the SECURITY NOTE at the top
-- of this file makes about `countFormSubmissions`, which was moved to the
-- service role for the identical reason on the identical policy. The count was
-- fixed and the trigger was not; now both are.
--
-- ⚠️ THE DELETE MESSAGE CHANGED, because it named the wrong thing. "has data
-- on existing requests" is a sentence about a table the person editing a staff
-- survey has never heard of. Both branches now say `submissions`, which is the
-- word the builder screen uses for both kinds.
--
-- `create or replace` on a function an APPLIED migration created: the trigger
-- in 20260729100100_p1_02_requests.sql:77 binds the NAME, so it picks this up
-- with no trigger change. 20260729100000_p1_01_forms.sql is not edited — it
-- describes the database as it was.
--
-- Back-out: re-run the function body from 20260729100000_p1_01_forms.sql:111.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_form_field_protect()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_has_data boolean;
begin
  -- Either table. A client form only ever has the first, an engagement form
  -- only ever the second, and the guard does not need to know which it is
  -- looking at — which is the point: it cannot be wrong about the purpose.
  select
    exists (
      select 1
        from vizserve_pms_requests r
       where r.form_id = coalesce(old.form_id, new.form_id)
         and r.field_values ? coalesce(old.field_key, new.field_key)
    )
    or exists (
      select 1
        from vizserve_pms_form_responses fr
       where fr.form_id = coalesce(old.form_id, new.form_id)
         and fr.field_values ? coalesce(old.field_key, new.field_key)
    )
  into v_has_data;

  if tg_op = 'DELETE' then
    if v_has_data then
      raise exception
        'Field "%" has answers on existing submissions and cannot be deleted. Set is_active = false instead.',
        old.field_key
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' and new.field_key is distinct from old.field_key and v_has_data then
    raise exception
      'field_key "%" is immutable once the form has submissions. Change the label instead.',
      old.field_key
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function vizserve_pms_form_field_protect() is
  'R5. Refuses a field_key rename and a field delete once an answer exists '
  'under that key — in vizserve_pms_requests (client forms) OR '
  'vizserve_pms_form_responses (engagement forms). Both, since P7-66 Phase 4b: '
  'counting requests alone left every engagement form unguarded. '
  'SECURITY DEFINER so the check cannot be blinded by the caller''s own RLS on '
  'an unrouted form, where manages_department(null) is false for a lead and a '
  'failing policy returns zero rows rather than an error. It refuses; it never '
  'returns a row to anybody.';
