-- ---------------------------------------------------------------------------
-- P7-66 — AN INTERNAL FORM CAN BE ANONYMOUS, AND THE CREATOR DECIDES.
--
-- Amier, 2 Sep 2026. 20260902100000_p7_66_form_purpose.sql split forms into
-- CLIENT_REQUEST and EMPLOYEE_ENGAGEMENT. An internal form is not only a pulse
-- survey — it is a sign-up sheet, a kudos nomination, an incident report, an IT
-- request — and some of those only work if the person answering is not named.
-- Whether a given form is anonymous is therefore the CREATOR'S decision, per
-- form, and this column is where it is recorded.
--
-- ⚠️⚠️ APPLIED TO LIVE PRODUCTION ON 2 SEP 2026, BY HAND, and therefore not to
-- be edited: this file is now the record of what was run. Anything further
-- needs a NEW file. It is not in `supabase_migrations.schema_migrations`, like
-- every P7 migration, so the CLI still believes it is pending.
--
-- ⚠️ IT WENT BEFORE 20260902110000_p7_66_form_responses.sql, which is why it is
-- timestamped earlier despite being written later. That file's INSERT policy
-- reads `f.is_anonymous`, so the other order fails with `column f.is_anonymous
-- does not exist` (42703). Filename order is apply order.
--
-- ⚠️ ANONYMOUS MEANS THE NAME IS NEVER WRITTEN. It does not mean the name is
-- hidden from a screen, filtered out of a query, or omitted from an export. A
-- name that exists in the row is a name that leaks — through a future screen
-- nobody thought about, through `select *`, through a support session, through
-- an admin with SQL access. So on an anonymous form
-- `vizserve_pms_form_responses.submitted_by` is NULL, and it is the responses
-- file's INSERT policy that makes that unbypassable rather than a convention
-- the application is trusted to follow.
--
-- ⚠️ ANONYMOUS IS NOT THE SAME AS UNAUTHENTICATED. The person still signs in to
-- reach /respond/<slug> — `anon` holds no privileges on any of this, and the
-- policy is `to authenticated`. What changes is only what is RECORDED. That
-- distinction is what lets an anonymous form still be restricted to staff.
--
-- Re-runnable: the column is `if not exists`, the constraint and the trigger are
-- guarded, and the function is `create or replace`.
--
-- Back-out:
--   drop trigger vizserve_pms_forms_anonymity_lock on vizserve_pms_forms;
--   drop function vizserve_pms_form_anonymity_protect();
--   alter table vizserve_pms_forms drop constraint vizserve_pms_forms_anonymous_is_internal;
--   alter table vizserve_pms_forms drop column is_anonymous;
-- The trigger first: it reads the column.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PRE-FLIGHT — run this first, on its own. It only reports.
--
-- --- 1. NOTHING SHOULD ALREADY CARRY THIS NAME. Expected: 0.
--
-- select count(*) from information_schema.columns
--  where table_schema = 'public' and table_name = 'vizserve_pms_forms'
--    and column_name = 'is_anonymous';
--
-- --- 2. THE CONSTRAINT BELOW IS ADDED VALIDATING, so it checks every existing
-- row before Postgres accepts it. The column defaults to false and no client
-- form can therefore violate it, but the count is free and a failure here
-- names no row. Expected: 0 either way.
--
-- select count(*) from vizserve_pms_forms where purpose = 'CLIENT_REQUEST';
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- The column.
--
-- `default false` and `not null`: a form is attributed unless somebody
-- deliberately says otherwise. The safe default is the one where an answer can
-- be traced back — an unintended anonymous form loses information nobody can
-- recover, while an unintended named form is a mistake that can at least be
-- seen and corrected before it is published.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_forms
  add column if not exists is_anonymous boolean not null default false;

comment on column vizserve_pms_forms.is_anonymous is
  'P7-66. When true, vizserve_pms_form_responses.submitted_by is NULL for every '
  'answer to this form — the name is NEVER WRITTEN, not merely hidden. Set by '
  'the form''s creator, only on an internal form, and LOCKED by '
  'vizserve_pms_form_anonymity_protect once the first answer exists: it is a '
  'promise made to the people who answered, and neither direction of the change '
  'can be honoured afterwards.';


-- ---------------------------------------------------------------------------
-- ⚠️ ANONYMITY IS MEANINGLESS ON A CLIENT FORM, AND ALLOWING IT WOULD BE WORSE
-- THAN MEANINGLESS.
--
-- /request/<slug> has no session at all — a client types their own name and
-- email into the form, and those are ordinary answers on the request, not an
-- identity the platform captured. There is nothing to withhold. A client form
-- flagged anonymous would therefore promise something it does not deliver: the
-- name is right there in `requester_name`, because the client typed it.
--
-- The constraint is one-directional on purpose. It says "anonymous implies
-- internal", not "internal implies anonymous" — an internal form is free to be
-- either.
--
-- Guarded rather than plain `add constraint`: there is no
-- `add constraint if not exists`, and a second paste would abort the file at
-- 42710 before the trigger below is created, leaving the column with no lock
-- on it — which is the one half-applied state that matters here.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conname = 'vizserve_pms_forms_anonymous_is_internal'
       and conrelid = 'vizserve_pms_forms'::regclass
  ) then
    alter table vizserve_pms_forms
      add constraint vizserve_pms_forms_anonymous_is_internal
      check (not (is_anonymous and purpose = 'CLIENT_REQUEST'));
  end if;
end
$$;


-- ---------------------------------------------------------------------------
-- ⚠️⚠️ THE LOCK, AND IT IS IN THE DATABASE BECAUSE IT IS A PROMISE.
--
-- Every other lock in this schema protects DATA — a reference number a client
-- quotes, a field_key an answer is filed under. This one protects something
-- said to a person before they typed:
--
--   ANONYMOUS → NAMED.  Thirty people answered a survey because it said their
--   name would not be recorded. Flipping the flag does not retroactively name
--   those answers — `submitted_by` is already NULL and nothing can recover it —
--   but it silently changes the promise for the thirty-first, on a form the
--   first thirty are still looking at. The Responses page would then show a
--   mixture, with no way to tell which rows were collected under which promise.
--
--   NAMED → ANONYMOUS.  Worse, and this is the one that reads as a feature.
--   Thirty answers already carry a name. Turning the flag on hides the column
--   from the screen and changes nothing at all in the table: the names are
--   still there, still exported, still readable by anyone with SQL. The form
--   would say "anonymous" over data that is not. THAT IS THE FAILURE THIS
--   TRIGGER EXISTS TO PREVENT, and it is exactly the shape a UI-only lock lets
--   through.
--
-- So the flag is settled before the first answer and never afterwards. There is
-- no supported path to change it later, deliberately: the honest way to run a
-- differently-promised form is a new form.
--
-- ⚠️ `security definer`, FOR THE REASON `vizserve_pms_form_field_protect` IS.
-- The guard counts `vizserve_pms_form_responses`, whose SELECT policy is
-- `vizserve_pms_manages_department(f.department_id)` — FALSE for a team leader
-- when `department_id is null`. A failing policy returns ZERO ROWS AND NO ERROR
-- (CLAUDE.md), so under the caller's own RLS this guard would find no answers on
-- an unrouted form and permit the change on precisely the form its author can
-- still edit. A SECURITY CHECK MUST NOT READ THROUGH A POLICY THAT CAN
-- LEGITIMATELY EXCLUDE THE READER.
--
-- Definer grants this function nothing worth abusing: it is a trigger that reads
-- one count and either raises or returns, it hands no row to any caller, it
-- takes no argument but the row being written, and its `search_path` is pinned.
-- Its only effect is to refuse more often.
--
-- ⚠️ IT DOES NOT FIRE ON EVERY UPDATE. `when (old.is_anonymous is distinct from
-- new.is_anonymous)` keeps the count off the path of ordinary settings saves —
-- renaming a form, changing its SLA, publishing it. Those UPDATE the row and
-- must not pay for a count, nor be refused by it.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_form_anonymity_protect()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if exists (
    select 1
      from vizserve_pms_form_responses r
     where r.form_id = old.id
  ) then
    raise exception
      'Whether "%" is anonymous cannot change once it has answers — % already came in under the promise it is making now. Build a new form instead.',
      old.name,
      (select count(*) from vizserve_pms_form_responses r where r.form_id = old.id)
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

comment on function vizserve_pms_form_anonymity_protect() is
  'P7-66. Refuses a change to vizserve_pms_forms.is_anonymous once any answer '
  'exists for the form, in either direction. Anonymity is a promise made before '
  'somebody answers; named→anonymous would relabel data that still carries '
  'names, and anonymous→named would change the promise under people already '
  'looking at the form. SECURITY DEFINER so the caller''s own RLS on '
  'vizserve_pms_form_responses cannot blind the count on an unrouted form.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'vizserve_pms_forms_anonymity_lock'
       and tgrelid = 'vizserve_pms_forms'::regclass
  ) then
    create trigger vizserve_pms_forms_anonymity_lock
      before update on vizserve_pms_forms
      for each row
      when (old.is_anonymous is distinct from new.is_anonymous)
      execute function vizserve_pms_form_anonymity_protect();
  end if;
end
$$;
