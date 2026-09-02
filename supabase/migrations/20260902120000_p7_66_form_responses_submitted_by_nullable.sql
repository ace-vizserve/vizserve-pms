-- ---------------------------------------------------------------------------
-- P7-66 — `submitted_by` MUST BE NULLABLE, AND `create table if not exists`
-- CANNOT HAVE MADE IT SO.
--
-- Amier, 2 Sep 2026. This is a one-line repair with a long note, because the
-- line is only needed in one specific history and there is no way to tell from
-- the repository which history production has.
--
-- ⚠️ WHAT MIGHT BE WRONG. `vizserve_pms_form_responses.submitted_by` shipped
-- `not null` in the first draft of 20260902110000_p7_66_form_responses.sql —
-- anonymity had been decided against at that point. The review that produced
-- f7c9f1e made it nullable, in place, INSIDE the file's
-- `create table if not exists`. That is a no-op against a table that already
-- exists: `if not exists` does not reconcile a shape, it SKIPS.
--
-- And an earlier paste is not hypothetical. That file's own pre-flight step 3
-- exists because a previous paste created the INSERT policy with a flat
-- `submitted_by = auth.uid()` check, and its jsonb index carries a
-- drop-and-recreate guard for the same reason. If the table in production came
-- from that paste, the column is STILL `not null` — and every anonymous
-- submission dies at the insert with
--
--   23502  null value in column "submitted_by" ... violates not-null constraint
--
-- on a form whose INSERT policy is simultaneously demanding that the value BE
-- null. Nothing in the application can work around that, the two migration
-- files are now applied and not to be edited, and the failure appears only when
-- the first person answers the first anonymous form.
--
-- ⚠️ IF THE COLUMN IS ALREADY NULLABLE THIS FILE DOES NOTHING, and that is the
-- point of shipping it rather than asking. `alter column ... drop not null` on
-- a column that has no not-null constraint is accepted and changes nothing —
-- so the cost of applying it needlessly is zero, and the cost of NOT applying
-- it when it was needed is a feature that silently cannot be used. Run the
-- pre-flight first anyway; knowing which of the two happened is worth the ten
-- seconds, and step 2 checks the other half of the same paste.
--
-- ⚠️ THE NULL IS NOT "UNKNOWN" HERE. It means one thing — this form's
-- `is_anonymous` is set and no name was ever written — and the INSERT policy is
-- what ties the two together so they cannot disagree. Dropping the constraint
-- does not loosen anything: the policy is stricter than `not null` ever was,
-- because it also refuses a null on a NAMED form.
--
-- ⚠️⚠️ APPLIED TO LIVE PRODUCTION ON 2 SEP 2026, BY HAND, and therefore not to
-- be edited: this file is now the record of what was run. Anything further needs
-- a NEW file. Like every P7 migration it is not recorded in
-- `supabase_migrations.schema_migrations`, so the CLI still believes it is
-- pending.
--
-- Re-runnable: `drop not null` is idempotent.
--
-- Back-out: none, and deliberately. Restoring `not null` would break every
-- anonymous form that had answered in the meantime — and if there are none, the
-- constraint is buying nothing the INSERT policy is not already enforcing.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PRE-FLIGHT — run this first, on its own. It only reports.
--
-- --- 1. IS THE COLUMN NULLABLE? -------------------------------------------
-- Expected: `YES`. A `NO` means the earlier paste is what production has, this
-- file is doing real work, and anonymity has never been usable.
--
-- select column_name, is_nullable, data_type
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'vizserve_pms_form_responses'
--    and column_name = 'submitted_by';
--
-- --- 2. AND IS THE INSERT POLICY THE ANONYMITY-AWARE ONE? ------------------
-- The other half of the same question, because both come from the same paste.
-- READ THE `with_check` TEXT. It must contain `is_anonymous`. If it is a flat
-- `submitted_by = auth.uid()`, it is the stale one — drop it and re-apply
-- 20260902110000_p7_66_form_responses.sql, whose guard skips a policy that is
-- already there:
--   drop policy "form responses insertable by their author" on vizserve_pms_form_responses;
--
-- select policyname, cmd, with_check
--   from pg_policies
--  where schemaname = 'public'
--    and tablename = 'vizserve_pms_form_responses'
--    and policyname = 'form responses insertable by their author';
--
-- --- 3. NOTHING SHOULD BE ABOUT TO BE ORPHANED. Expected: 0 either way, and
-- it stays 0 — this file adds no rows and changes no row. Free to run, and it
-- is the number that says whether anything has been answered yet at all.
--
-- select count(*) from vizserve_pms_form_responses;
-- ===========================================================================


alter table vizserve_pms_form_responses
  alter column submitted_by drop not null;


-- ---------------------------------------------------------------------------
-- Restated so the column's own documentation is right whichever paste it came
-- from. `comment on` is a replace, not an append, so this is safe to re-run and
-- safe if the text is already exactly this.
-- ---------------------------------------------------------------------------
comment on column vizserve_pms_form_responses.submitted_by is
  'Who answered, or NULL on a form whose is_anonymous flag is set — in which '
  'case no name was EVER written, rather than being hidden. Which of the two '
  'applies is decided by vizserve_pms_forms.is_anonymous and enforced by the '
  'INSERT policy, and that flag locks on the first answer. A NULL here never '
  'means "unknown", and NOTHING may read it as "the submitter is unavailable": '
  'a screen decides whether to show a person column from the FORM''s flag, '
  'never from whether one row''s value is null.';
