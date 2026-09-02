-- ---------------------------------------------------------------------------
-- P7-66 Phase 8 — A FORM CAN BE A QUIZ, AND POSTGRES DOES THE MARKING.
--
-- Three decisions, settled 2 Sep 2026, and the schema here is the shape of them:
--
--   INTERNAL ONLY. A client request is a work request, not something to be
--   graded, and the Responses tab — the only place a score is ever read — does
--   not exist on a client form. The CHECK below makes `is_quiz` on a
--   CLIENT_REQUEST unreachable rather than merely unoffered.
--
--   CHOICE FIELDS ONLY. A correct answer is a subset of `options`, which the
--   builder already validates and `vizserve_pms_form_fields_select_has_options`
--   already refuses to leave empty. Marking is then exact by construction. Free
--   text was rejected on purpose: "Manila", "manila " and "Manilla" are one
--   right answer and two wrong ones, and every trimming and casing rule invented
--   to paper over that gets reported as a bug.
--
--   THE RESPONDENT SEES NOTHING. The success panel is unchanged. A score shown
--   to somebody who cannot edit or withdraw their answer is an invitation to
--   submit a second one, and `vizserve_pms_form_responses` is APPEND-ONLY.
--
-- ⚠️ WHY THIS CANNOT LIVE IN THE SCHEMA JSONB. `reconcileFormSchema` rebuilds
-- the schema from `vizserve_pms_form_fields` ROWS on every load and the rows
-- win, so an attribute that exists only in the blob is wiped by the next open.
-- Hence real columns.
--
-- ⚠️ AND WHY GRADING IS NOT A BUILDER ATTRIBUTE. The obvious route — add
-- `correctAnswer` and `points` to `fieldAttributes` and project them in
-- `vizserve_pms_save_form_schema` — means REPLACING that function, which is the
-- only thing in this schema permitted to DELETE a field row and the one place
-- the R5 guard is allowed to speak. Re-pasting 250 lines of it to add two
-- columns is a transcription risk taken for no gain.
--
-- So grading follows the `vizserve_pms_set_form_audience` precedent instead:
-- ONE dedicated writer, called when the control changes, and
-- `save_form_schema` never mentions the columns — its UPDATE lists the columns
-- it sets by name, so a field surviving a save keeps its grading untouched. The
-- two writers cannot fight because they write disjoint columns.
--
-- ⚠️ THE MARKING IS A TRIGGER, NOT THE ACTION. `/respond` inserts a response
-- through PostgREST directly — there is no submit function to put this in — so
-- the score would otherwise be computed in a browser and sent. A BEFORE INSERT
-- trigger both computes it and makes a sent one impossible: whatever the client
-- puts in `score`, this overwrites it. CLAUDE.md: rules live in the database,
-- the front end will be bypassed.
--
-- PRE-FLIGHT — expected 0, 0, 0. Non-zero on the first means this file has
-- already run; it is written to be re-runnable, so read the constraint
-- definitions before re-applying.
--
--   select count(*) from information_schema.columns
--    where table_name = 'vizserve_pms_forms' and column_name = 'is_quiz';
--   select count(*) from information_schema.columns
--    where table_name = 'vizserve_pms_form_fields' and column_name = 'correct_answer';
--   select count(*) from information_schema.columns
--    where table_name = 'vizserve_pms_form_responses' and column_name = 'score';
--
-- POST-FLIGHT — expect 4 constraint rows, 1 trigger, 1 function:
--
--   select conname from pg_constraint
--    where conname in (
--      'vizserve_pms_forms_quiz_is_internal',
--      'vizserve_pms_form_fields_grading_is_a_choice',
--      'vizserve_pms_form_fields_correct_answer_is_array',
--      'vizserve_pms_form_fields_points_positive'
--    );
--   select tgname from pg_trigger where tgname = 'vizserve_pms_form_responses_score';
--   select proname from pg_proc where proname = 'vizserve_pms_set_field_grading';
-- ---------------------------------------------------------------------------

-- --- 1. THE FLAG -----------------------------------------------------------

alter table vizserve_pms_forms
  add column if not exists is_quiz boolean not null default false;

comment on column vizserve_pms_forms.is_quiz is
  'P7-66 Phase 8. Internal forms only. When true the Responses tab shows a '
  'score per answer and the question editor offers a correct answer on choice '
  'fields. The respondent is told nothing.';

-- Dropped by name before adding, per 20260902140000: a guard that makes a file
-- re-runnable also protects an object that is already there and WRONG.
alter table vizserve_pms_forms
  drop constraint if exists vizserve_pms_forms_quiz_is_internal;

alter table vizserve_pms_forms
  add constraint vizserve_pms_forms_quiz_is_internal
  check (not is_quiz or purpose = 'INTERNAL');

comment on constraint vizserve_pms_forms_quiz_is_internal on vizserve_pms_forms is
  'P7-66 Phase 8. Only an internal form can be a quiz. A client request is a '
  'work request, and its submissions are read in /requests, which has nowhere '
  'to put a score.';

-- --- 2. THE ANSWER KEY -----------------------------------------------------

alter table vizserve_pms_form_fields
  add column if not exists correct_answer jsonb;

alter table vizserve_pms_form_fields
  add column if not exists points integer not null default 1;

comment on column vizserve_pms_form_fields.correct_answer is
  'P7-66 Phase 8. ALWAYS AN ARRAY of option strings, even for a select, where '
  'it holds exactly one. One shape means one marking rule: a select is right '
  'when its answer is IN the array, a multiselect when its set EQUALS it. NULL '
  'means this question is not marked, which is the only state a non-choice '
  'field may have.';

comment on column vizserve_pms_form_fields.points is
  'P7-66 Phase 8. What a correct answer is worth. Always set — it is the '
  'default 1 on every field ever created — but it only means anything where '
  'correct_answer is not null.';

alter table vizserve_pms_form_fields
  drop constraint if exists vizserve_pms_form_fields_grading_is_a_choice;
alter table vizserve_pms_form_fields
  drop constraint if exists vizserve_pms_form_fields_correct_answer_is_array;
alter table vizserve_pms_form_fields
  drop constraint if exists vizserve_pms_form_fields_points_positive;

/*
 * ⚠️ ONLY A CHOICE FIELD CAN BE MARKED, AND THIS IS WHERE THAT IS TRUE.
 *
 * Not the settings screen and not the editor — both of those are the front end,
 * which CLAUDE.md says will be bypassed. A correct answer on a `text` field
 * would be marked by nothing (the trigger below only knows two types) and would
 * sit in the table looking like a rule somebody could rely on.
 */
alter table vizserve_pms_form_fields
  add constraint vizserve_pms_form_fields_grading_is_a_choice
  check (correct_answer is null or field_type in ('select', 'multiselect'));

/*
 * `jsonb_array_length` in the trigger below needs an array or it errors at
 * runtime, on an INSERT, for the person answering. This is the difference
 * between a refused edit and a refused submission.
 *
 * Note `jsonb_typeof(null::jsonb)` is NULL, not 'null', so the `is null` branch
 * is doing real work — without it every ungraded field would fail this check.
 */
alter table vizserve_pms_form_fields
  add constraint vizserve_pms_form_fields_correct_answer_is_array
  check (correct_answer is null or jsonb_typeof(correct_answer) = 'array');

-- A question worth nothing is not a question the quiz is asking. Zero would
-- also make `max_score` disagree with the number of graded questions.
alter table vizserve_pms_form_fields
  add constraint vizserve_pms_form_fields_points_positive
  check (points > 0);

-- --- 3. WHAT THE MARKING PRODUCED ------------------------------------------

alter table vizserve_pms_form_responses
  add column if not exists score integer;

alter table vizserve_pms_form_responses
  add column if not exists max_score integer;

comment on column vizserve_pms_form_responses.score is
  'P7-66 Phase 8. Written by the vizserve_pms_form_responses_score trigger and '
  'by nothing else — a value sent by a client is overwritten. NULL on a '
  'response to a form that was not a quiz WHEN IT WAS ANSWERED, which is why it '
  'is stored rather than computed on read: turning a live form into a quiz must '
  'not retrospectively mark answers given before there was an answer key.';

comment on column vizserve_pms_form_responses.max_score is
  'P7-66 Phase 8. The total available AT THE MOMENT OF ANSWERING. Stored for the '
  'same reason as score: editing the answer key later must not silently change '
  'what an old answer was out of.';

-- --- 4. THE MARKING --------------------------------------------------------

create or replace function vizserve_pms_form_response_score()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_is_quiz boolean;
  v_score   integer := 0;
  v_max     integer := 0;
  v_field   record;
  v_value   jsonb;
begin
  /*
   * ⚠️ SECURITY DEFINER, for the same reason `vizserve_pms_form_field_protect`
   * is. This reads `vizserve_pms_form_fields` as part of an INSERT run by the
   * person answering, and a failing policy returns ZERO ROWS RATHER THAN AN
   * ERROR — so as `security invoker` a policy change would silently start
   * scoring every submission 0 out of 0, with nothing anywhere saying so.
   *
   * It reads; it never returns a row to the caller. The only thing it can do to
   * the outside world is set two integers on the row being inserted.
   */
  select f.is_quiz into v_is_quiz
    from vizserve_pms_forms f
   where f.id = new.form_id;

  /*
   * NOT A QUIZ: BOTH COLUMNS NULL, INCLUDING ANYTHING THE CLIENT SENT.
   * `/respond` inserts through PostgREST, so `score` is a writable column as far
   * as the API is concerned. This is what makes it not one.
   */
  if not coalesce(v_is_quiz, false) then
    new.score := null;
    new.max_score := null;
    return new;
  end if;

  for v_field in
    select ff.field_key, ff.field_type, ff.correct_answer, ff.points
      from vizserve_pms_form_fields ff
     where ff.form_id = new.form_id
       and ff.is_active
       and ff.correct_answer is not null
  loop
    -- ARCHIVED QUESTIONS ARE NOT MARKED and are not in the total. An archived
    -- question is not on the form, so nobody was asked it — counting it would
    -- mark everybody down for a question that was never put to them.
    v_max := v_max + v_field.points;

    v_value := new.field_values -> v_field.field_key;

    if v_value is null then
      continue;
    end if;

    if v_field.field_type = 'select' then
      /*
       * The answer is a single string; `correct_answer` is an array. `?` asks
       * whether the array CONTAINS that string, which also lets an answer key
       * hold two acceptable options for one select — the trigger needs no
       * change for that, and the builder simply does not offer it yet.
       *
       * `jsonb_typeof` guarded: `?` on a non-string operand is not an error but
       * is never true, and being explicit says the shape is known.
       */
      if jsonb_typeof(v_value) = 'string' and v_field.correct_answer ? (v_value #>> '{}') then
        v_score := v_score + v_field.points;
      end if;

    elsif v_field.field_type = 'multiselect' then
      /*
       * ⚠️ CONTAINMENT BOTH WAYS, WHICH IS SET EQUALITY. `<@` alone would mark
       * an empty selection correct on every question, since `[] <@ anything` is
       * true. Ticking every box would pass a one-way check in the other
       * direction. Both, so the answer must be exactly the key — no partial
       * credit, which is the rule the points column already implies.
       */
      if jsonb_typeof(v_value) = 'array'
         and v_value <@ v_field.correct_answer
         and v_field.correct_answer <@ v_value then
        v_score := v_score + v_field.points;
      end if;
    end if;
  end loop;

  new.score := v_score;
  new.max_score := v_max;

  return new;
end;
$$;

comment on function vizserve_pms_form_response_score() is
  'P7-66 Phase 8. Marks a quiz answer at INSERT. The only writer of '
  'vizserve_pms_form_responses.score and .max_score — a score sent by a client '
  'is discarded. Both are NULL when the form was not a quiz at the moment of '
  'answering, so making a live form a quiz never retrospectively marks answers '
  'given before there was an answer key.';

drop trigger if exists vizserve_pms_form_responses_score on vizserve_pms_form_responses;

create trigger vizserve_pms_form_responses_score
  before insert on vizserve_pms_form_responses
  for each row
  execute function vizserve_pms_form_response_score();

-- --- 5. THE ONE WRITER OF AN ANSWER KEY ------------------------------------

create or replace function vizserve_pms_set_field_grading(
  p_form_id        uuid,
  p_field_id       uuid,
  p_correct_answer jsonb,
  p_points         integer
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  v_purpose    vizserve_pms_form_purpose;
  v_field_type vizserve_pms_field_type;
  v_options    jsonb;
begin
  /*
   * ⚠️ SECURITY INVOKER, AND THE READ IS THE PERMISSION CHECK. Exactly as
   * `vizserve_pms_set_form_audience` does it: if the caller cannot see the form
   * under `forms updatable in scope`, this finds nothing and refuses before
   * anything is written — and the message does not distinguish "not yours" from
   * "does not exist", so it cannot be used to probe which forms exist.
   */
  select f.purpose into v_purpose
    from vizserve_pms_forms f
   where f.id = p_form_id;

  if v_purpose is null then
    raise exception 'That form does not exist, or is not yours to edit.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_purpose <> 'INTERNAL' then
    raise exception 'Only an internal form can be a quiz.'
      using errcode = 'invalid_parameter_value';
  end if;

  select ff.field_type, ff.options into v_field_type, v_options
    from vizserve_pms_form_fields ff
   where ff.id = p_field_id and ff.form_id = p_form_id;

  if v_field_type is null then
    raise exception 'That question is not on this form.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_points is null or p_points < 1 then
    raise exception 'A question must be worth at least one point.'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_correct_answer is not null then
    if v_field_type not in ('select', 'multiselect') then
      raise exception 'Only Choose one and Choose many can have a correct answer.'
        using errcode = 'invalid_parameter_value';
    end if;

    if jsonb_typeof(p_correct_answer) <> 'array' or jsonb_array_length(p_correct_answer) = 0 then
      raise exception 'Pick at least one correct option.'
        using errcode = 'invalid_parameter_value';
    end if;

    /*
     * ⚠️ THE KEY MUST BE MADE OF THIS QUESTION'S OWN OPTIONS.
     *
     * Otherwise renaming an option leaves an answer key pointing at a string
     * nobody can pick any more — a question every respondent gets wrong, that
     * looks correctly configured on the screen that configures it, and whose
     * only symptom is everybody scoring one lower than they should.
     *
     * Checked HERE rather than as a table constraint because a constraint
     * cannot see it: `options` and `correct_answer` are the same row, so a
     * CHECK could enforce it on write — but renaming an option is an UPDATE of
     * `options` by `save_form_schema`, and a CHECK would refuse THAT save with
     * a message about grading, on a form the person was only editing.
     */
    if not (p_correct_answer <@ v_options) then
      raise exception 'A correct answer must be one of the options offered.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  update vizserve_pms_form_fields
     set correct_answer = p_correct_answer,
         points = p_points
   where id = p_field_id and form_id = p_form_id;
end;
$$;

comment on function vizserve_pms_set_field_grading(uuid, uuid, jsonb, integer) is
  'P7-66 Phase 8. The ONLY supported writer of correct_answer and points. '
  'vizserve_pms_save_form_schema names the columns it sets and does not name '
  'these two, so the builder autosave and this function write disjoint columns '
  'and cannot fight. Refuses a key that is not a subset of the question''s own '
  'options — the failure that is otherwise invisible, because a stale key looks '
  'correct on screen and only shows up as everybody scoring one lower.';

grant execute on function vizserve_pms_set_field_grading(uuid, uuid, jsonb, integer)
  to authenticated;
