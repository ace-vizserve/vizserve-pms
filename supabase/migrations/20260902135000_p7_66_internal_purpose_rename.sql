-- ---------------------------------------------------------------------------
-- P7-66 — `EMPLOYEE_ENGAGEMENT` BECOMES `INTERNAL`.
--
-- Ace, 2 Sep 2026: "why are using engagement word? the internal form is
-- INTERNAL? the internal form is not always about employee engagement."
--
-- ⚠️ THE NAME WAS NEVER RIGHT, AND THE FLAW IS STRUCTURAL RATHER THAN COSMETIC.
--
-- Its sibling is `CLIENT_REQUEST`, which names WHO FILLS THE FORM IN.
-- `EMPLOYEE_ENGAGEMENT` names WHAT THE FORM IS ABOUT. Two different axes in one
-- two-value enum — so the column answered a different question depending on
-- which value you were looking at, and the answer to "what is `purpose`?" had no
-- single sentence.
--
-- It was named after the first thing anybody imagined building with it, a pulse
-- survey, and the code has been outgrowing it ever since: an IT request, a
-- facilities booking, a training feedback form, an HR intake are all internal
-- and none of them is engagement. The audience feature landing in 20260902140000
-- makes the mismatch worse still — "who should answer" is a question about
-- PEOPLE, and it reads as nonsense hung off a topic.
--
-- Every comment in the repo already said "internal form" while the code said
-- EMPLOYEE_ENGAGEMENT. This closes that gap in the direction the prose had
-- already chosen.
--
-- ⚠️ `CLIENT_REQUEST` IS DELIBERATELY LEFT ALONE. It is accurate on the same
-- axis — a request, from a client — it is the value on four live forms, and
-- renaming it would be churn bought with risk for no gain.
--
-- ---------------------------------------------------------------------------
-- ⚠️ WHY THIS IS CHEAP, WHICH IS NOT OBVIOUS AND IS THE REASON IT IS BEING DONE
-- NOW RATHER THAN "LATER".
--
-- `alter type … rename value` changes ONE ROW of `pg_enum.enumlabel`. It is not
-- a table rewrite and it is not a data migration:
--
--   STORED ROWS need no update. A value in a column is stored as the enum
--   value's OID, not as text, so every existing row keeps pointing at the same
--   value under its new name.
--
--   POLICIES AND CHECK CONSTRAINTS need no update, for the same reason. Their
--   expressions hold a Const carrying that OID; `pg_get_expr` simply renders the
--   new label afterwards. Nothing has to be dropped and re-created — which is
--   what makes this safe to do in front of 20260902140000 rather than after it.
--
--   IT IS TRANSACTION-SAFE, unlike `alter type … add value`, which cannot be
--   used in the same transaction that creates it. Nothing here needs to be split
--   out or run separately.
--
-- ⚠️ THE ONE THING THAT DOES NOT FOLLOW AUTOMATICALLY IS APPLICATION CODE, and
-- it ships in the same commit: every TypeScript comparison against the string
-- moves in lockstep. A deploy carrying the code without this migration compares
-- `purpose === "INTERNAL"` against rows that still say EMPLOYEE_ENGAGEMENT, and
-- every one of those comparisons is false — which does not throw, it merely
-- decides that no form is internal. The builder would show a Responses tab on
-- nothing, /respond would list nothing, and the two audience policies in
-- 20260902140000 would match nothing. Silent, and wrong in the closed direction.
--
-- SO THE ORDER IS: THIS FILE, THEN 20260902140000, THEN THE CODE. All three, or
-- none of them.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, like every P7 migration. It will
-- not be recorded in `supabase_migrations.schema_migrations`.
--
-- ⚠️ THE EARLIER FILES ARE NOT EDITED, AND MUST NOT BE. 20260902100000 (which
-- created the enum), 110000, 120000 and 130000 are all applied, so they are the
-- record of what was run and they go on saying EMPLOYEE_ENGAGEMENT for ever.
-- This file is the record of the change. Reading them in order tells the truth;
-- editing them to match today would not.
--
-- Re-runnable: guarded, because `rename value` raises 42710 if the new name is
-- already taken and 22023 if the old one is gone. A rename is the one operation
-- here that genuinely cannot be expressed as drop-then-create.
--
-- Back-out:
--   alter type vizserve_pms_form_purpose rename value 'INTERNAL' to 'EMPLOYEE_ENGAGEMENT';
-- and revert the application code with it. There is no data to restore.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PRE-FLIGHT — run this first, on its own. It only reports.
--
-- --- 1. THE VALUE MUST STILL BE THERE UNDER ITS OLD NAME. Expected: two rows,
-- `CLIENT_REQUEST` and `EMPLOYEE_ENGAGEMENT`. If you see `INTERNAL`, this file
-- has been applied and there is nothing to do.
--
-- select e.enumlabel, e.enumsortorder
--   from pg_enum e
--   join pg_type t on t.oid = e.enumtypid
--  where t.typname = 'vizserve_pms_form_purpose'
--  order by e.enumsortorder;
--
-- --- 2. HOW MANY ROWS ARE ABOUT TO BE RE-LABELLED. Not a risk — it is the same
-- rows either way — but the number should be unchanged afterwards under the new
-- name, and that is the check worth having on the record.
--
-- select purpose, count(*) from vizserve_pms_forms group by purpose;
--
-- --- 3. EVERYTHING THAT MENTIONS THE VALUE AND WILL FOLLOW IT AUTOMATICALLY.
-- Listed so the claim above can be VERIFIED rather than believed: re-run this
-- after the rename and every one of these should read INTERNAL, with nothing
-- dropped and nothing re-created.
--
-- select tablename, policyname,
--        coalesce(qual, '') || ' ' || coalesce(with_check, '') as definition
--   from pg_policies
--  where schemaname = 'public'
--    and (coalesce(qual, '') || coalesce(with_check, '')) like '%EMPLOYEE_ENGAGEMENT%';
--
-- select conrelid::regclass as table_name, conname,
--        pg_get_constraintdef(oid) as definition
--   from pg_constraint
--  where pg_get_constraintdef(oid) like '%EMPLOYEE_ENGAGEMENT%';
-- ===========================================================================


do $$
begin
  if exists (
    select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
     where t.typname = 'vizserve_pms_form_purpose'
       and e.enumlabel = 'EMPLOYEE_ENGAGEMENT'
  ) then
    alter type vizserve_pms_form_purpose rename value 'EMPLOYEE_ENGAGEMENT' to 'INTERNAL';
  end if;
end
$$;


-- ⚠️ THE COLUMN COMMENT IS RE-STATED, because it named the old value and a
-- comment that lies about an enum is worse than no comment: it is the first
-- thing somebody reads when they are trying to work out what the column means.
comment on column vizserve_pms_forms.purpose is
  'P7-66. WHO FILLS THE FORM IN, which is the axis this enum is on. '
  'CLIENT_REQUEST: an external client, no account, at /request/<slug>; the '
  'submission mints a vizserve_pms_requests row with a reference number and a '
  'Gate 1 route. INTERNAL: a signed-in colleague at /respond/<slug>; the '
  'submission is a row of answers with no reference, no email and no lifecycle. '
  'is_public is derived from this by vizserve_pms_forms_purpose_matches_public. '
  'Renamed from EMPLOYEE_ENGAGEMENT on 2 Sep 2026 — an internal form is not '
  'always about engagement, and the old name described a topic while its sibling '
  'described an audience.';


-- ===========================================================================
-- POST-FLIGHT — confirm the rename landed and nothing else moved.
--
-- --- 1. Expected: `CLIENT_REQUEST` and `INTERNAL`, in the same sort order as
-- before. The order matters: it is the enum's declaration order, and nothing
-- about a rename should change it.
--
-- select e.enumlabel, e.enumsortorder
--   from pg_enum e
--   join pg_type t on t.oid = e.enumtypid
--  where t.typname = 'vizserve_pms_form_purpose'
--  order by e.enumsortorder;
--
-- --- 2. The SAME counts as pre-flight step 2, under the new name. Expected: the
-- EMPLOYEE_ENGAGEMENT row is now the INTERNAL row, with an identical count, and
-- CLIENT_REQUEST is untouched.
--
-- select purpose, count(*) from vizserve_pms_forms group by purpose;
--
-- --- 3. ⚠️ THE CLAIM THAT POLICIES AND CHECKS FOLLOWED. Expected: 0 rows from
-- the first query (nothing still says the old name) and the same policies and
-- constraints as pre-flight step 3 from the second, now reading INTERNAL.
--
-- select count(*) from pg_policies
--  where schemaname = 'public'
--    and (coalesce(qual, '') || coalesce(with_check, '')) like '%EMPLOYEE_ENGAGEMENT%';
--
-- select tablename, policyname,
--        coalesce(qual, '') || ' ' || coalesce(with_check, '') as definition
--   from pg_policies
--  where schemaname = 'public'
--    and (coalesce(qual, '') || coalesce(with_check, '')) like '%INTERNAL%';
--
-- --- 4. Then apply 20260902140000, which is written against the NEW name.
-- ===========================================================================
