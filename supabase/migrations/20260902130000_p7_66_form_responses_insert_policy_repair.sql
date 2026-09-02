-- ---------------------------------------------------------------------------
-- P7-66 — THE INSERT POLICY IN PRODUCTION IS THE PRE-ANONYMITY ONE, AND IT
-- REFUSES EVERY ANONYMOUS ANSWER.
--
-- Amier, 2 Sep 2026. Measured, not suspected — this is what
-- `20260902120000`'s pre-flight step 2 returned from the live database:
--
--   ((submitted_by = auth.uid()) AND (EXISTS ( SELECT 1
--      FROM vizserve_pms_forms f
--     WHERE ((f.id = vizserve_pms_form_responses.form_id)
--       AND (f.purpose = 'EMPLOYEE_ENGAGEMENT') AND f.is_active))))
--
-- No `is_anonymous` anywhere in it. So on a form whose `is_anonymous` is set,
-- `submitFormResponse` writes `submitted_by = null` — as it must, because the
-- promise on /respond/<slug> is that no name is recorded — and this policy
-- evaluates `null = auth.uid()`, which is NULL rather than true. A `with check`
-- that is not TRUE refuses the row:
--
--   42501  new row violates row-level security policy for table
--          "vizserve_pms_form_responses"
--
-- ⚠️ WHAT IS AND IS NOT AT RISK. No anonymous answer can have been stored, so
-- there is no data to repair and nothing to migrate: the failure is a refusal,
-- not a corruption. What IS broken is the feature — any form marked anonymous
-- rejects every colleague who tries to answer it, at the moment they press Send.
--
-- ⚠️⚠️ WHY THE FIX IS A NEW FILE AND NOT A RE-PASTE, AND THE LESSON IN IT.
--
-- 20260902110000_p7_66_form_responses.sql already contains the correct policy.
-- It cannot deliver it. Every policy in that file is wrapped in a `pg_policies`
-- existence guard so the file is re-runnable — there is no `create policy if not
-- exists`, and a bare `create policy` aborts the whole file at 42710 on a second
-- paste. That guard did its job and, in doing it, skipped the create and left
-- the WRONG policy standing.
--
-- A GUARD THAT MAKES A FILE RE-RUNNABLE ALSO PROTECTS AN OBJECT THAT IS ALREADY
-- WRONG. `if not exists` asks the wrong question when the object exists and
-- disagrees with the file. Re-pasting that file a third time would change
-- nothing, for the same reason it changed nothing the second time.
--
-- So this drops first and then creates. `drop policy if exists` followed by an
-- unguarded `create policy` is idempotent in the way that actually matters here:
-- re-running it converges on the policy written below, whatever was there before.
--
-- ⚠️⚠️ APPLIED TO LIVE PRODUCTION ON 2 SEP 2026, BY HAND, and therefore not to
-- be edited: this file is now the record of what was run. Anything further needs
-- a NEW file. Like every P7 migration it is not recorded in
-- `supabase_migrations.schema_migrations`, so the CLI still believes it is
-- pending.
--
-- 20260902120000 went first, on the same day. It makes `submitted_by` nullable,
-- and without it an anonymous insert fails at 23502 before this policy is ever
-- consulted.
--
-- Back-out:
--   drop policy "form responses insertable by their author"
--     on vizserve_pms_form_responses;
-- and re-create the flat version above. There is no reason to: the policy below
-- is strictly stricter — it refuses a null on a NAMED form, which the flat one
-- also refused, AND refuses a name on an ANONYMOUS one, which the flat one
-- required.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PRE-FLIGHT — run this first, on its own. It only reports.
--
-- --- 1. CONFIRM WHAT IS THERE NOW. Expected: one row whose `with_check` does
-- NOT mention `is_anonymous`. If it already does, this file has been applied
-- and there is nothing to do — it is safe to run again regardless.
--
-- select policyname, cmd, with_check
--   from pg_policies
--  where schemaname = 'public'
--    and tablename = 'vizserve_pms_form_responses'
--    and policyname = 'form responses insertable by their author';
--
-- --- 2. THE COLUMN MUST ALREADY BE NULLABLE. Expected: `YES`. A `NO` means
-- 20260902120000 has not been applied and this file will not fix anything on
-- its own — the insert would fail at 23502 before reaching the policy.
--
-- select is_nullable
--   from information_schema.columns
--  where table_schema = 'public'
--    and table_name = 'vizserve_pms_form_responses'
--    and column_name = 'submitted_by';
--
-- --- 3. NOTHING IS LOST BY THE DROP. A policy is not data. This is here only
-- so the number is on the record: it should be unchanged afterwards.
--
-- select count(*) from vizserve_pms_form_responses;
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- ⚠️ THE IDENTITY RULE IS DECIDED BY THE FORM, NEVER BY THE CALLER.
--
-- Three conditions, and each is load-bearing:
--
--   `f.purpose = 'EMPLOYEE_ENGAGEMENT'`  a client form's submissions are
--   `vizserve_pms_requests`, with a reference number, a Gate 1 route and an SLA
--   clock. An answer filed here against a client form would have none of them.
--
--   `f.is_active`  a draft is not answerable. This is what stops somebody
--   posting to a form that has been taken off the air.
--
--   the `case`  on an anonymous form a name may NOT be attached, even by
--   somebody attaching their own; on a named one it must be, and it must be
--   theirs. Both halves are refusals, which is why this is one expression
--   rather than two policies OR'd together — an OR would permit whichever
--   branch the caller could satisfy.
--
-- ⚠️ `to authenticated` EITHER WAY. Anonymous is about what is RECORDED, not
-- about who may reach the form. The person still signs in; `anon` holds no
-- privileges on this table at all. That distinction is what lets an anonymous
-- form still be restricted to staff.
--
-- ⚠️ THIS IS THE ENFORCEMENT, NOT THE APPLICATION. `submitFormResponse` reads
-- `is_anonymous` off the form and writes `null` or `auth.uid()` accordingly, and
-- the browser echoes back the promise it displayed so a mid-fill change is
-- refused rather than written. Both are readable refusals in front of this one.
-- The front end will be bypassed.
-- ---------------------------------------------------------------------------
drop policy if exists "form responses insertable by their author"
  on vizserve_pms_form_responses;

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


-- ===========================================================================
-- POST-FLIGHT — confirm the repair landed.
--
-- Expected: one row whose `with_check` now contains `is_anonymous`.
--
-- select policyname, with_check
--   from pg_policies
--  where schemaname = 'public'
--    and tablename = 'vizserve_pms_form_responses'
--    and policyname = 'form responses insertable by their author';
--
-- Then answer an anonymous form at /respond/<slug> and confirm the row lands
-- with `submitted_by` null. That is the only end-to-end proof, and it is the one
-- the pre-flight above could not give.
-- ===========================================================================
