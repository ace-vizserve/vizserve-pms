-- ---------------------------------------------------------------------------
-- P7-66 Phase 9 — A PICTURE IS NOT A QUESTION, AND IT NEEDS A SOURCE.
--
-- 20260902170000 added the labels. Two constraints go with them, and they are
-- the same two facts 20260902155000 established for 'section', extended to the
-- media types rather than restated for each.
--
-- ⚠️ WHY NOT JUST EXTEND `vizserve_pms_form_fields_section_asks_nothing`. It is
-- APPLIED. Redefining a live constraint to cover three types would drop and
-- recreate it, which revalidates the whole table and briefly leaves sections
-- unguarded inside the transaction — for no gain over a second constraint that
-- says its own thing. Two constraints, each named for what it guards.
--
-- --- 1. NEVER REQUIRED ------------------------------------------------------
--
-- `vizserve_pms_submit_request` walks the active fields and refuses a submission
-- when `is_required` and the value is blank. A display field has no input, so
-- its key is never in the payload and the value is always blank — a required one
-- makes the form PERMANENTLY UNSUBMITTABLE, with "Team photo is required."
-- against a picture and no control on the page that could satisfy it.
--
-- The builder writes `required: false` for these types, but CLAUDE.md is
-- explicit that the front end will be bypassed. Making the row impossible is
-- what lets the required-field loop stay free of type clauses.
--
-- --- 2. IT NEEDS A SOURCE ---------------------------------------------------
--
-- `options[0]` is the URL — see the long note in 20260902170000 for why it is
-- there rather than in a column of its own. An image field with an empty
-- `options` is a field that renders nothing: a blank gap in the middle of a form
-- that looks like a rendering fault rather than an unfinished field.
--
-- This mirrors `vizserve_pms_form_fields_select_has_options`, which refuses an
-- option-less select for the same reason — an unanswerable question — and
-- `unsavableReason` in the builder gives the same rule a sentence somebody can
-- act on BEFORE the save is attempted, exactly as it does for a choice field.
--
-- ⚠️ IT CHECKS FOR AN ENTRY, NOT FOR A URL. Postgres is not going to parse a
-- YouTube link, and a regex here would be a second, weaker copy of the check the
-- editor already makes — one that would refuse a save on a URL shape nobody
-- anticipated, from a screen that had already accepted it.
--
-- ⚠️ DROPPED BY NAME BEFORE ADDING, per 20260902140000: a guard that makes a
-- file re-runnable also protects an object that is already there and WRONG.
--
-- PRE-FLIGHT — if either returns rows, fix them before applying. There should be
-- none: nothing has been able to write these types until now.
--
--   select id, form_id, field_key, is_required from vizserve_pms_form_fields
--    where field_type in ('image', 'youtube') and is_required;
--
--   select id, form_id, field_key, options from vizserve_pms_form_fields
--    where field_type in ('image', 'youtube') and jsonb_array_length(options) = 0;
--
-- POST-FLIGHT (expect two rows):
--
--   select conname, pg_get_constraintdef(oid)
--     from pg_constraint
--    where conrelid = 'vizserve_pms_form_fields'::regclass
--      and conname in (
--        'vizserve_pms_form_fields_media_asks_nothing',
--        'vizserve_pms_form_fields_media_has_a_source'
--      );
-- ---------------------------------------------------------------------------

alter table vizserve_pms_form_fields
  drop constraint if exists vizserve_pms_form_fields_media_asks_nothing;

alter table vizserve_pms_form_fields
  add constraint vizserve_pms_form_fields_media_asks_nothing
  check (field_type not in ('image', 'youtube') or not is_required);

comment on constraint vizserve_pms_form_fields_media_asks_nothing
  on vizserve_pms_form_fields is
  'P7-66 Phase 9. An image and a video are shown, not answered: no input, so '
  'the key is never in a submission payload and vizserve_pms_submit_request '
  'reads it as blank. Marked required, it would refuse every submission with an '
  'error no control on the page can satisfy. Same rule as '
  'vizserve_pms_form_fields_section_asks_nothing, for the same reason.';

alter table vizserve_pms_form_fields
  drop constraint if exists vizserve_pms_form_fields_media_has_a_source;

alter table vizserve_pms_form_fields
  add constraint vizserve_pms_form_fields_media_has_a_source
  check (
    field_type not in ('image', 'youtube')
    or jsonb_array_length(options) > 0
  );

comment on constraint vizserve_pms_form_fields_media_has_a_source
  on vizserve_pms_form_fields is
  'P7-66 Phase 9. options[0] is the URL. A media field with none renders a blank '
  'gap in the middle of a form, which reads as a rendering fault rather than an '
  'unfinished field. Mirrors vizserve_pms_form_fields_select_has_options. It '
  'checks for an ENTRY, not for a URL: parsing a link is the editor''s job, and '
  'a regex here would be a weaker second copy that refuses saves on shapes '
  'nobody anticipated.';
