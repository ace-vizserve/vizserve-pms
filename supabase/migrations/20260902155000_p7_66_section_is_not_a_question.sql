-- ---------------------------------------------------------------------------
-- P7-66 Phase 7 — A SECTION IS NOT A QUESTION, AND THE DATABASE SAYS SO.
--
-- 20260902150000 added the enum label. This is the rule that goes with it, and
-- it is deliberately ONE CONSTRAINT rather than a rewrite of anything.
--
-- ⚠️ WHAT ALREADY WORKS, AND MUST NOT BE "FIXED".
--
-- Two things a reader will expect to find changed here are already correct by
-- construction, and touching them would only add a second place to get it
-- wrong:
--
--   `vizserve_pms_form_field_protect` (20260902110000) refuses a delete and a
--   key rename when `field_values ? field_key`. A section is never written to
--   `field_values` by anybody, so that test is false for every section and a
--   section is freely deletable and renamable. No filter needed: the guard asks
--   "does this key hold an answer", which is the right question for a section
--   too — and the answer is always no.
--
--   `vizserve_pms_get_public_form` (20260803100000) already emits every active
--   field ordered by `sort_order` with its `field_type`. Sections flow through
--   to the renderer unchanged, which is exactly what a paged form needs: the
--   page breaks arrive in the same ordered list as the questions, so the client
--   splits on them rather than being told about them separately.
--
-- ⚠️ WHAT THIS FIXES IS THE ONE STATE THAT WOULD BREAK A FORM.
--
-- `vizserve_pms_submit_request` walks the active fields and, for each,
--
--     if v_field.is_required and vizserve_pms_jsonb_value_is_blank(v_value)
--       -> "<label> is required."
--
-- A section has no input, so its key is never in the payload and `v_value` is
-- always null — blank. So a section marked `is_required` makes the form
-- PERMANENTLY UNSUBMITTABLE, refusing every submission with "Your details is
-- required." and no control on the page to satisfy it. The builder will not
-- create that row; a `curl`, a fixture or a hand-edited row can, and CLAUDE.md
-- is explicit that the front end will be bypassed.
--
-- The constraint makes the state unreachable, which is why the loop in
-- `submit_request` needs no `field_type <> 'section'` clause: a section is now
-- provably skipped by the `continue` two lines further down, on the same path
-- an unanswered optional field takes. One rule, enforced once, rather than the
-- same exclusion repeated in every function that reads the table.
--
-- `options` is in the same constraint for the same reason: a section is not a
-- choice, and `[]` is what every non-choice field already stores.
--
-- ⚠️ DROPPED FIRST, BOTH TIMES. Per 20260902140000: a guard that makes a file
-- re-runnable also protects an object that is already wrong, so this drops the
-- constraint by name before adding it rather than using `if not exists`. Re-run
-- the file and you get the constraint as written here, not whatever was there.
--
-- PRE-FLIGHT — if this returns rows, the constraint will fail. Fix them first;
-- there should be none, because nothing has been able to write a section yet:
--
--   select id, form_id, field_key, is_required, options
--     from vizserve_pms_form_fields
--    where field_type = 'section'
--      and (is_required or coalesce(array_length(options, 1), 0) > 0);
--
-- POST-FLIGHT (expect one row):
--
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'vizserve_pms_form_fields'::regclass
--      and conname = 'vizserve_pms_form_fields_section_asks_nothing';
-- ---------------------------------------------------------------------------

alter table vizserve_pms_form_fields
  drop constraint if exists vizserve_pms_form_fields_section_asks_nothing;

alter table vizserve_pms_form_fields
  add constraint vizserve_pms_form_fields_section_asks_nothing
  check (
    field_type <> 'section'
    or (not is_required and coalesce(array_length(options, 1), 0) = 0)
  );

comment on constraint vizserve_pms_form_fields_section_asks_nothing
  on vizserve_pms_form_fields is
  'P7-66 Phase 7. A section is a page break, not a question: it has no input, '
  'so its field_key is never in a submission payload and vizserve_pms_submit_request '
  'would read it as blank. Marked required, it would refuse every submission '
  'with an error no control on the page can satisfy. This makes that row '
  'impossible, which is why the required-field loop needs no section clause.';
