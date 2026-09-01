-- ---------------------------------------------------------------------------
-- P7-66 — THE FORM'S SCHEMA, AS ONE JSONB BLOB, WITH THE ROWS KEPT IN STEP.
--
-- Amier, 1 Sep 2026. `@coltorapps/builder` builds and interprets a form from a
-- single `{ entities, root }` document (lib/form-builder/). This adds the column
-- that document lives in, fills it from the field rows that are authoritative
-- today, and adds the ONE function allowed to write it — which also PROJECTS it
-- back into `vizserve_pms_form_fields`, so nothing that reads rows breaks.
--
-- ⚠️ THE ROWS ARE NOT DROPPED, AND THE PROJECTION IS NOT A COURTESY. It is what
-- keeps the R5 guarantees in Postgres. `vizserve_pms_form_field_protect`
-- (20260729100000_p1_01_forms.sql:111) fires on the projected rows, so renaming
-- a `field_key` that has submissions behind it, or removing a field that has
-- them, still raises and rolls back the WHOLE save — jsonb column included. Move
-- the field list into a blob with no projection and that guard becomes a comment
-- in a TypeScript file, which is not what "rules live in the database" means.
--
-- ⚠️ APPLY BY HAND, in the Supabase SQL editor, and paste this file as it stands
-- at that moment. Every P7 migration landed that way and none is recorded in
-- `supabase_migrations.schema_migrations`. RUN THE PRE-FLIGHT BLOCK BELOW FIRST.
--
-- This file is re-runnable: the column is added `if not exists`, the constraint
-- is created only if absent, the backfill touches only forms still carrying the
-- default empty schema, and the function is `create or replace`.
--
-- Back-out: `alter table vizserve_pms_forms drop column schema;` and
-- `drop function vizserve_pms_save_form_schema(uuid, jsonb);`. Nothing reads
-- either yet — Phase 1 wires nothing up.
-- ---------------------------------------------------------------------------


-- ===========================================================================
-- PRE-FLIGHT — RUN THESE FIRST, ON THEIR OWN. DO NOT APPLY THIS FILE UNTIL
-- EVERY ONE OF THEM RETURNS ZERO.
--
-- The backfill below is a mechanical projection: whatever is in the rows ends
-- up in the blob. The blob is then read back by `parseFormSchema`
-- (lib/form-builder/schema.ts), which IS the library's own `validateSchema` —
-- and that is STRICTER than the CHECK constraints on `vizserve_pms_form_fields`
-- in exactly two places. A row that trips one of them backfills happily and then
-- makes its form UNOPENABLE in the Phase 2 builder, with `FormSchemaError` and
-- nothing else to go on. Cheap to find now, expensive to find then.
--
-- Nothing here is destructive; each query only reports.
-- ===========================================================================
--
-- --- 1. A LABEL THAT IS BLANK OR ONLY WHITESPACE ---------------------------
-- `labelAttribute` refuses it (`Give the field a label.`); the column does not —
-- `label` is `text not null` with no CHECK, so `''` has always been storable.
--
-- select count(*) from vizserve_pms_form_fields where label ~ '^[[:space:]]*$';
--
-- ⚠️ A REGEX, NOT `btrim(label) = ''`, AND THE DIFFERENCE IS REAL.
-- `btrim(text)` with no second argument strips SPACES ONLY, so a label of a
-- single TAB is left untouched and the `btrim` form reports nothing — while
-- `labelAttribute` uses JavaScript `.trim()`, which strips tabs and refuses the
-- field. That is a pre-flight clearing a form the parser will not open, which is
-- the one way a pre-flight can be worse than none. Pinned in
-- tests/unit/form-schema.test.ts.
--
-- Residual, named: JS `.trim()` also strips non-breaking space and a handful of
-- other Unicode blanks that `[[:space:]]` does not. A label made only of those
-- would still slip through. Nothing in this data has ever contained one, and
-- there is no clean Postgres class for it — so it is a known gap rather than a
-- solved problem.
--
-- If the count is not zero, list them and give each one a label before applying:
--
-- select f.slug, f.name as form_name, ff.id, ff.field_key, ff.is_active
--   from vizserve_pms_form_fields ff
--   join vizserve_pms_forms f on f.id = ff.form_id
--  where ff.label ~ '^[[:space:]]*$'
--  order by f.slug, ff.sort_order;
--
-- FIX: `update vizserve_pms_form_fields set label = '<something>' where id = '…';`
-- Use the `field_key` as the label if there is nothing better — it is display
-- text, it changes no stored answer, and the R5 trigger does not guard it.
-- Archived fields count too: they are carried into the schema, not dropped.
--
-- --- 2. AN OPTION THAT IS NOT A NON-EMPTY STRING ---------------------------
-- `optionsAttribute` is `z.array(z.string().min(1))`. The column only checks
-- `jsonb_typeof(options) = 'array'`, so `[""]`, `[1, 2]` and `[{"a":1}]` all
-- pass it and all fail the parser.
--
-- select count(*) from vizserve_pms_form_fields ff
--  where exists (
--    select 1 from jsonb_array_elements(ff.options) as o
--     where jsonb_typeof(o) <> 'string' or (o #>> '{}') = ''
--  );
--
-- ⚠️ EXACT EMPTY, NOT `btrim(...) = ''`. `"  "` is a legal option and must stay
-- one: `selectEntity` builds `z.enum(options)` from this list, so trimming or
-- refusing a padded option moves the accepted set away from the stored set and
-- historical answers stop validating. See the note above `optionsAttribute`.
--
-- select f.slug, ff.field_key, ff.field_type, ff.options
--   from vizserve_pms_form_fields ff
--   join vizserve_pms_forms f on f.id = ff.form_id
--  where exists (
--    select 1 from jsonb_array_elements(ff.options) as o
--     where jsonb_typeof(o) <> 'string' or (o #>> '{}') = ''
--  );
--
-- FIX: rewrite that field's `options` to an array of non-empty strings. If the
-- field has submissions behind it, keep every value anyone has already chosen —
-- dropping one makes their stored answer unvalidatable.
--
-- --- 3–5. THE THREE THE COLUMN ALREADY GUARANTEES --------------------------
-- All three are inline CHECKs / a UNIQUE on the table, so all three must return
-- zero by construction. They are here because "by construction" is a claim about
-- a constraint that could have been dropped in the SQL editor at some point, and
-- the cost of checking is one query each.
--
-- -- 3. a key the pattern would refuse (`FIELD_KEY_PATTERN`)
-- select count(*) from vizserve_pms_form_fields where field_key !~ '^[a-z][a-z0-9_]*$';
--
-- -- 4. two fields on one form sharing a key (one silently overwrites the other)
-- select form_id, field_key, count(*) from vizserve_pms_form_fields
--  group by form_id, field_key having count(*) > 1;
--
-- -- 5. a select nobody could answer
-- select count(*) from vizserve_pms_form_fields
--  where field_type in ('select', 'multiselect') and jsonb_array_length(options) = 0;
--
-- --- 6. WHAT THE BACKFILL WILL TOUCH ----------------------------------------
-- Sanity, not a gate. Every form gets a row written, including the ones with no
-- fields (they get the empty schema they already have).
--
-- select count(*) as forms, (select count(*) from vizserve_pms_form_fields) as fields
--   from vizserve_pms_forms;
--
-- ⚠️ The backfill bumps `vizserve_pms_forms.updated_at` on every form, because
-- `vizserve_pms_forms_updated_at` is a BEFORE UPDATE trigger and there is no way
-- to write the column without firing it. `/forms` sorts by `created_at`, so no
-- screen reorders; nothing else reads a form's `updated_at`. Stated because a
-- whole-table timestamp bump should never be a surprise found afterwards.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. The column.
--
-- NOT NULL WITH A DEFAULT, so there is no "a form whose schema has not been
-- written yet" state for a reader to branch on. `emptyFormSchema()` in
-- lib/form-builder/builder.ts produces exactly this value.
--
-- The CHECK is deliberately the weakest one that is still worth having. jsonb
-- cannot express `{ entities, root }`, and a half-copy of the library's rules in
-- SQL is the thing lib/form-builder/schema.ts was rewritten to eliminate — "ONE
-- VALIDATOR, NOT TWO", because the two drift and every place they disagree is a
-- silent drop on the public submit path. So the shape is checked by
-- `parseFormSchema` on read, and all this refuses is the blob that would crash
-- it before it got started: a scalar, an array, a `null`.
-- ---------------------------------------------------------------------------
alter table vizserve_pms_forms
  add column if not exists schema jsonb not null default '{"entities": {}, "root": []}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'vizserve_pms_forms'::regclass
       and conname = 'vizserve_pms_forms_schema_is_object'
  ) then
    alter table vizserve_pms_forms
      add constraint vizserve_pms_forms_schema_is_object
      check (jsonb_typeof(schema) = 'object');
  end if;
end;
$$;

comment on column vizserve_pms_forms.schema is
  'P7-66. The form as @coltorapps/builder sees it: { entities, root }, entity id '
  '= vizserve_pms_form_fields.id so the round trip is stable and attachments and '
  'joins keep pointing at the same rows. WRITTEN ONLY BY '
  'vizserve_pms_save_form_schema(), which projects it back into '
  'vizserve_pms_form_fields in the same transaction — that projection is what '
  'keeps the R5 guard (vizserve_pms_form_field_protect) enforcing field_key '
  'immutability and the no-hard-delete rule in Postgres rather than in the UI. '
  'Read it with parseFormSchema() (lib/form-builder/schema.ts), never raw: the '
  'attribute defaults are applied there.';


-- ---------------------------------------------------------------------------
-- 2. Backfill.
--
-- The SQL twin of `schemaFromFields` (lib/form-builder/schema.ts). Every
-- attribute name below is the one `attributes.ts` declares, and the entity
-- object carries NOTHING BUT `type` AND `attributes` — no `id`. The id is the
-- RECORD KEY. `SchemaEntity` in the shipped `.d.ts` is
-- `{ type, attributes, parentId?, children? }`; the docs site shows an `id`
-- inside the object and the docs site is wrong.
--
-- ⚠️ Writing one anyway is TOLERATED, not refused — measured, not assumed:
-- `validateSchema` accepts an entity carrying an extra `id` and silently drops
-- it from the normalised output. So an `id` here would not break a form; it
-- would sit in the column as a fact about the blob that no reader ever sees
-- again, and would read to the next person as though it meant something. Left
-- out for that reason rather than under threat of an error.
--
-- ⚠️ ATTRIBUTES ARE THE OPPOSITE CASE — an undeclared one IS refused, with
-- `UnknownEntityAttributeType`, and the form then fails to open. So all SIX are
-- written on every field, `text` fields included: a `text` field has no use for
-- `options`, but every entity in entities.ts DECLARES all six, so writing five
-- would be as wrong as writing seven. `archived` is `not is_active` — there is
-- no `is_active` attribute, and writing one would be exactly the rejection
-- above.
--
-- ⚠️ AN ARCHIVED FIELD IS CARRIED, NEVER DROPPED. Drop it and the very first
-- save would project a field list missing that row, the projection would DELETE
-- it, and the R5 trigger would refuse the write — turning every archived field
-- into a form nobody can save. The row also holds historical answers.
--
-- ⚠️ ORDER BY sort_order, created_at, id — three columns, not one.
-- `moveField` in app/(app)/forms/actions.ts notes in passing that "seeded and
-- hand-edited forms often share sort_order values", so ties are real live data,
-- and `jsonb_agg` over a tie is otherwise free to order them differently on
-- every run. The first two columns are the same tiebreak
-- `vizserve_pms_get_public_form` already renders by, so the backfilled order is
-- the order the public form has been showing; `id` makes it total.
--
-- ⚠️ RE-RUN SAFE, and this is the one line that makes it so. Only a form still
-- carrying the untouched default is filled, so pasting this file twice cannot
-- overwrite a schema someone has since saved through the RPC. jsonb equality
-- normalises whitespace and key order, so the literal matches the default
-- however it was written.
-- ---------------------------------------------------------------------------
update vizserve_pms_forms f
   set schema = (
     select jsonb_build_object(
              'entities',
              coalesce(jsonb_object_agg(x.id::text, x.entity), '{}'::jsonb),
              'root',
              coalesce(
                jsonb_agg(to_jsonb(x.id::text) order by x.sort_order, x.created_at, x.id),
                '[]'::jsonb
              )
            )
       from (
         select ff.id,
                ff.sort_order,
                ff.created_at,
                jsonb_build_object(
                  'type', ff.field_type::text,
                  'attributes', jsonb_build_object(
                    'key',      ff.field_key,
                    'label',    ff.label,
                    'helpText', ff.help_text,
                    'required', ff.is_required,
                    'options',  ff.options,
                    'archived', not ff.is_active
                  )
                ) as entity
           from vizserve_pms_form_fields ff
          where ff.form_id = f.id
       ) x
   )
 where f.schema = '{"entities": {}, "root": []}'::jsonb;


-- ---------------------------------------------------------------------------
-- 3. The only writer.
--
-- ⚠️ WHY AN RPC AND NOT A TRIGGER. A trigger on `vizserve_pms_forms` decomposing
-- jsonb into ordered rows, while `vizserve_pms_form_field_protect` raises and
-- rolls back underneath it, is the hardest thing in this change to reason about
-- or to debug when it goes wrong. One function with one entry point gives the
-- same all-or-nothing guarantee — a function call is a transaction — and can be
-- read top to bottom. It is the only path that writes `schema`, so "the rows and
-- the blob agree" holds for the same reason either way.
--
-- ⚠️ SECURITY INVOKER, DELIBERATELY, AND THIS IS THE LOAD-BEARING CHOICE.
--
-- This function replaces three server actions — `saveField`, `setFieldActive`,
-- `moveField` — which today write `vizserve_pms_form_fields` through the
-- ordinary RLS client. Running as the invoker gives it EXACTLY that reach and
-- not one row more: `forms updatable in scope` decides whether the blob may be
-- written, and `form fields follow their form` decides every insert, update and
-- delete of the projection (it is a `for all` policy, so the DELETE is covered
-- by its USING and the INSERT by its WITH CHECK). Both are in
-- 20260729100300_p1_rls_policies.sql; neither is restated here, because a
-- restatement is a second copy free to drift from the first. "RLS is the
-- enforcement layer" (CLAUDE.md).
--
-- SECURITY DEFINER would bypass both policies and leave a hand-written `if not
-- vizserve_pms_manages_department(...)` as the only thing between a member and
-- any form on the system. Definer is used in this codebase for two reasons and
-- neither applies here: breaking RLS recursion on `vizserve_pms_users` (P0-05),
-- and reaching the database with NO SESSION AT ALL — the public form and the
-- Gate 3 approval page, because `anon` holds no table privileges. Every caller
-- of this function is signed in and already holds the privileges it needs.
--
-- The consequence to name rather than discover: `vizserve_pms_form_field_protect`
-- is not `security definer` either, so its `select … from vizserve_pms_requests`
-- runs under the caller's own RLS. For a routed form the caller leads the
-- department and therefore sees the requests, so the guard sees them too. For an
-- UNROUTED DRAFT (`department_id is null`, visible to its author) a non-admin
-- author sees no requests and the guard finds no data to protect. That is
-- exactly what happens today when `saveField` updates the row directly — this
-- function neither introduces it nor widens it — and such a form cannot be
-- active (`vizserve_pms_forms_active_requires_department`), so it is a draft
-- nobody has submitted to through the front door. Definer would make the guard
-- STRICTER here, and that is the single argument for it; it does not outweigh
-- hand-copying two policies.
--
-- ⚠️ WHAT THIS FUNCTION DOES NOT DO: validate the schema. It checks that the
-- argument is an object and then projects. Everything the database can express
-- is enforced by the columns the projection writes into — the `field_key`
-- pattern, `unique (form_id, field_key)`,
-- `vizserve_pms_form_fields_select_has_options`, `options_is_array`, the enum on
-- `field_type` — and every one of them raises here and rolls back the blob with
-- it. THE PROJECTION IS THE VALIDATOR. The cross-entity rules the columns cannot
-- see are `formBuilder.validateSchema`'s (lib/form-builder/builder.ts), which
-- the builder UI runs before it calls this; re-stating them in SQL would rebuild
-- the two-validators-that-drift problem schema.ts was rewritten to remove. The
-- one rule that is in neither place is "a label must not be blank" — see
-- pre-flight 1; the column has never had that CHECK and adding one to live data
-- is a separate, riskier migration.
--
-- ⚠️ THE WRITE ORDER IS THE WHOLE DESIGN: UPDATE THE FORM, THEN DELETE, THEN
-- UPDATE THE ROWS, THEN INSERT. Each step is justified where it appears.
-- ---------------------------------------------------------------------------
create or replace function vizserve_pms_save_form_schema(
  p_form_id uuid,
  p_schema  jsonb
)
returns void
language plpgsql
volatile
security invoker
set search_path = public, extensions
as $$
declare
  -- The projection, computed ONCE, before anything is written. A jsonb array of
  -- flat row objects, in final order, with `sort_order` already dense.
  v_rows jsonb;
begin
  if p_schema is null or jsonb_typeof(p_schema) <> 'object' then
    raise exception 'A form schema must be a json object.'
      using errcode = 'invalid_parameter_value';
  end if;

  /*
   * -----------------------------------------------------------------------
   * The projection. The SQL twin of `fieldsFromSchema`
   * (lib/form-builder/schema.ts), rule for rule, in the same order:
   *
   *   first_mention   `root: [A, A]` is ONE field. First position wins — the
   *                   same rule `orderedEntities` in values.ts uses, so a form
   *                   read through either side describes the same fields.
   *                   Without it the two mentions became two rows sharing a
   *                   primary key and the insert failed.
   *                   ⚠️ The BLOB is still stored as it arrived, and
   *                   `parseFormSchema` refuses a duplicate `root` id outright
   *                   (`DuplicateRootId`) — so a caller who managed to send one
   *                   would get consistent rows and an unopenable form. The
   *                   builder store cannot produce it, and this function is the
   *                   twin of a projection that is required to be safe standing
   *                   alone, so the rule stays; it is named here so nobody reads
   *                   the de-duplication as a promise the blob is readable.
   *   resolved        an id in `root` with no entity behind it is SKIPPED, not
   *                   projected as an empty row. `jsonb_exists` is exact own-key
   *                   membership, which is what `Object.hasOwn` is doing on the
   *                   other side — and why neither uses a truthiness test:
   *                   `entities["constructor"]` answers with a function.
   *                   (`jsonb_exists(a, b)` rather than `a ? b` so the body
   *                   survives being pasted through a client that reads `?` as a
   *                   bind placeholder.)
   *   usable          an entity with no string `key` is SKIPPED. `key` is the
   *                   STORAGE identity every answer is filed under (§1) and it
   *                   is the one attribute that cannot be defaulted — inventing
   *                   one files answers under a key nothing reads.
   *   sort_order      `row_number()` over the SURVIVING rows, so a skipped
   *                   duplicate or dangling id leaves no hole. Dense 0..n-1,
   *                   counting rows and not positions in `root`, exactly as
   *                   `rows.length` does.
   *
   * Every other attribute is read DEFENSIVELY and defaulted the way the
   * attribute validators in attributes.ts default it, because the caller is the
   * builder store's RAW schema — the validators have not run, so `options` may
   * be null and `label` simply absent:
   *
   *   label / helpText   a non-string becomes `''`
   *   options            a non-array becomes `[]`
   *   required           `is distinct from false` — absent, null and anything
   *                      else all mean required. Mirrors `?? true`, which is
   *                      layer 1 of the completeness rule.
   *   archived           `is distinct from true` — absent means live.
   *
   * `is distinct from`, not `<>`: `(attributes->'required') <> 'false'` is NULL
   * when the attribute is absent, and a NULL would fail the column's NOT NULL
   * rather than default to required.
   * -----------------------------------------------------------------------
   */
  with root_ids as (
    -- `elem`/`pos`, not `value`/`ordinality`: both of those are keywords in
    -- other grammar (XMLTABLE), and an alias that only mostly parses is not
    -- worth the two saved characters.
    select r.elem #>> '{}' as entity_id,
           r.pos           as pos
      from jsonb_array_elements(
             case when jsonb_typeof(p_schema -> 'root') = 'array'
                  then p_schema -> 'root'
                  else '[]'::jsonb
             end
           ) with ordinality as r(elem, pos)
  ),
  first_mention as (
    select entity_id, min(pos) as pos
      from root_ids
     -- A json `null` in `root` addresses no entity. Dropped here rather than
     -- looked up, which is where it would be dropped anyway.
     where entity_id is not null
     group by entity_id
  ),
  -- The entity record, guarded ONCE, in its own CTE rather than as an extra
  -- `and` beside the `jsonb_exists` below. SQL does not promise to evaluate the
  -- two in order, and `jsonb_exists` on something that is not an object means
  -- something else entirely (on an array it is element membership). A guard that
  -- relies on short-circuiting is a guard that works until the planner changes
  -- its mind.
  entity_map as (
    select case when jsonb_typeof(p_schema -> 'entities') = 'object'
                then p_schema -> 'entities'
                else '{}'::jsonb
           end as map
  ),
  resolved as (
    select fm.entity_id,
           fm.pos,
           em.map -> fm.entity_id as entity
      from first_mention fm
     cross join entity_map em
     where jsonb_exists(em.map, fm.entity_id)
  ),
  -- `attributes` is never null here: an entity with no `attributes` object has
  -- no `attributes -> 'key'` either, so the filter below has already dropped it.
  usable as (
    select res.entity_id,
           res.pos,
           res.entity,
           res.entity -> 'attributes' as attributes
      from resolved res
     where jsonb_typeof(res.entity -> 'attributes' -> 'key') = 'string'
  ),
  ordered as (
    select u.*,
           (row_number() over (order by u.pos))::int - 1 as sort_order
      from usable u
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id',          o.entity_id,
               'field_key',   o.attributes ->> 'key',
               'label',       case when jsonb_typeof(o.attributes -> 'label') = 'string'
                                   then o.attributes ->> 'label' else '' end,
               'field_type',  o.entity ->> 'type',
               'help_text',   case when jsonb_typeof(o.attributes -> 'helpText') = 'string'
                                   then o.attributes ->> 'helpText' else '' end,
               'options',     case when jsonb_typeof(o.attributes -> 'options') = 'array'
                                   then o.attributes -> 'options' else '[]'::jsonb end,
               'is_required', (o.attributes -> 'required') is distinct from to_jsonb(false),
               'is_active',   (o.attributes -> 'archived') is distinct from to_jsonb(true),
               'sort_order',  o.sort_order
             )
             order by o.sort_order
           ),
           '[]'::jsonb
         )
    into v_rows
    from ordered o;

  /*
   * -----------------------------------------------------------------------
   * STEP 1 — THE BLOB, AND THE AUTHORIZATION CHECK, IN ONE STATEMENT.
   *
   * FIRST, for three reasons that all point the same way:
   *
   *   it IS the permission check   `forms updatable in scope` decides whether
   *                                this row is visible-and-writable. No row
   *                                updated means the caller may not edit this
   *                                form, or there is no such form — and one
   *                                message for both, so this cannot be used to
   *                                probe which forms exist.
   *   fail before touching rows    a caller with no scope never reaches a DELETE
   *                                on the field rows at all.
   *   it takes the row lock        two leads saving the same form serialise on
   *                                `vizserve_pms_forms`, so they cannot
   *                                interleave two projections into one field
   *                                list.
   *
   * Stored VERBATIM. The blob is what the builder produced; `parseFormSchema`
   * normalises on read, and normalising on write as well would mean a form could
   * mean two things depending on which side you asked.
   * -----------------------------------------------------------------------
   */
  update vizserve_pms_forms
     set schema = p_schema
   where id = p_form_id;

  if not found then
    raise exception 'That form does not exist, or you cannot edit it.'
      using errcode = 'insufficient_privilege';
  end if;

  /*
   * -----------------------------------------------------------------------
   * STEP 2 — REMOVALS, KEYED ON THE ENTITY ID.
   *
   * ⚠️ THIS IS WHERE THE R5 GUARD HAS TO BE ALLOWED TO SPEAK, and where the
   * obvious implementation destroys it.
   *
   * The obvious one is "delete every field of this form, then insert the
   * projection". It is wrong twice over. Every field with submissions behind it
   * would hit the DELETE branch of `vizserve_pms_form_field_protect` and raise —
   * so a save that merely REORDERED two fields, or fixed a typo in a label,
   * would be refused on a form that has ever been submitted to. And it would
   * report a rename as a deletion, which is the wrong sentence for the wrong
   * operation.
   *
   * So the three statements are a MERGE KEYED ON `vizserve_pms_form_fields.id`,
   * which is why the backfill above reuses the row id as the entity id rather
   * than minting a new one. Only a field genuinely absent from the schema is
   * deleted, and for that one the guard fires and says the right thing:
   *
   *   Field "x" has data on existing requests and cannot be deleted.
   *   Set is_active = false instead.
   *
   * The exception rolls back the STEP 1 write too, because a function call is
   * one transaction — the blob never records a field the rows still hold.
   *
   * An ARCHIVED field is in the schema (`archived: true`), so it is in `v_rows`,
   * so it is not deleted. That is the whole reason `archivedAttribute` exists.
   *
   * DELETE BEFORE UPDATE, so that a new field may take the `field_key` a
   * deleted one has just released without tripping `unique (form_id, field_key)`.
   * -----------------------------------------------------------------------
   */
  delete from vizserve_pms_form_fields ff
   where ff.form_id = p_form_id
     and not exists (
       select 1 from jsonb_to_recordset(v_rows) as n(id uuid)
        where n.id = ff.id
     );

  /*
   * -----------------------------------------------------------------------
   * STEP 3 — THE FIELDS THAT SURVIVED.
   *
   * An UPDATE, never a delete-and-reinsert, so the UPDATE branch of the R5
   * guard is the branch that fires: `new.field_key is distinct from
   * old.field_key and v_has_data` raises
   *
   *   field_key "x" is immutable once the form has submissions.
   *   Change the label instead.
   *
   * …and rolls the whole save back. Reinserting under a new key would have
   * slipped past that check entirely by presenting a rename as two operations
   * neither of which is one.
   *
   * ⚠️ UNCHANGED ROWS ARE SKIPPED, by the row-wise `is distinct from`. Postgres
   * fires BEFORE UPDATE triggers on a no-op write, and the guard runs an
   * `exists (…)` over `vizserve_pms_requests` every time it fires — so without
   * this a save that touched one field paid for a scan per field, and every
   * untouched row had `updated_at` bumped for nothing.
   *
   * ⚠️ ONE KNOWN LIMITATION, NAMED SO IT IS NOT MISTAKEN FOR A BUG. Two fields
   * SWAPPING their `field_key` in a single save fails on
   * `unique (form_id, field_key)`: the constraint is not DEFERRABLE, so Postgres
   * checks it as each row is updated rather than at the end of the statement.
   * The save is refused cleanly and rolls back; doing it as two saves works.
   * Both fields would have to be free of submissions for the swap to be legal at
   * all — the R5 guard refuses it otherwise — so this is reachable only on a
   * form nobody has submitted to, and making the constraint deferrable is a
   * change to a live table for a case that has never arisen.
   * -----------------------------------------------------------------------
   */
  update vizserve_pms_form_fields ff
     set field_key   = n.field_key,
         label       = n.label,
         field_type  = n.field_type::vizserve_pms_field_type,
         help_text   = n.help_text,
         options     = n.options,
         is_required = n.is_required,
         is_active   = n.is_active,
         sort_order  = n.sort_order
    from jsonb_to_recordset(v_rows) as n(
           id          uuid,
           field_key   text,
           label       text,
           field_type  text,
           help_text   text,
           options     jsonb,
           is_required boolean,
           is_active   boolean,
           sort_order  integer
         )
   where ff.id = n.id
     and ff.form_id = p_form_id
     and (
           ff.field_key, ff.label, ff.field_type, ff.help_text,
           ff.options, ff.is_required, ff.is_active, ff.sort_order
         ) is distinct from (
           n.field_key, n.label, n.field_type::vizserve_pms_field_type, n.help_text,
           n.options, n.is_required, n.is_active, n.sort_order
         );

  /*
   * -----------------------------------------------------------------------
   * STEP 4 — THE NEW FIELDS.
   *
   * LAST, so a new field may take a `field_key` that step 2 deleted or step 3
   * renamed away from.
   *
   * The id comes from the schema, not from `gen_random_uuid()`: the entity id
   * IS the row id, and minting a new one would leave the blob pointing at a row
   * that no longer exists after the very next save.
   *
   * `not exists (… and ff.form_id = p_form_id)` — SCOPED TO THIS FORM on
   * purpose. Unscoped, an entity id that collided with another form's field row
   * would make this insert silently skip the field, and the caller would watch a
   * field disappear with no error. Scoped, the collision raises a duplicate-key
   * error and the save rolls back, which is the honest outcome for something
   * that should never happen. Nothing else can match: step 2 has already removed
   * every row of this form that the schema does not list.
   * -----------------------------------------------------------------------
   */
  insert into vizserve_pms_form_fields (
    id, form_id, field_key, label, field_type,
    help_text, options, is_required, is_active, sort_order
  )
  select n.id,
         p_form_id,
         n.field_key,
         n.label,
         n.field_type::vizserve_pms_field_type,
         n.help_text,
         n.options,
         n.is_required,
         n.is_active,
         n.sort_order
    from jsonb_to_recordset(v_rows) as n(
           id          uuid,
           field_key   text,
           label       text,
           field_type  text,
           help_text   text,
           options     jsonb,
           is_required boolean,
           is_active   boolean,
           sort_order  integer
         )
   where not exists (
     select 1 from vizserve_pms_form_fields ff
      where ff.id = n.id and ff.form_id = p_form_id
   );
end;
$$;

comment on function vizserve_pms_save_form_schema(uuid, jsonb) is
  'P7-66. The ONLY writer of vizserve_pms_forms.schema. Stores the blob and '
  'projects it into vizserve_pms_form_fields in one transaction, merging on '
  'entity id = row id: delete, then update, then insert. That ordering is what '
  'lets vizserve_pms_form_field_protect fire on the right operation — a removed '
  'field with data raises on the DELETE, a renamed field_key with data raises on '
  'the UPDATE — and either rolls back the schema write with it. SECURITY '
  'INVOKER: the RLS policies on forms and form_fields are the authorization, so '
  'this is no wider a door than editing the rows directly. The projection '
  'mirrors fieldsFromSchema() exactly (first mention of a duplicate id wins, a '
  'dangling id is skipped, an entity with no key is skipped, sort_order counts '
  'rows). Raises rather than returning a result; a caller sees success as the '
  'absence of an error.';


-- ---------------------------------------------------------------------------
-- 4. Grants.
--
-- BOTH GATES, STATED, because "permission denied for function …" is a GRANT
-- diagnosis and never an RLS one (CLAUDE.md; P0-06; P4's function-grants fix).
--
-- Postgres grants EXECUTE on a new function to PUBLIC, which includes `anon`.
-- `anon` holds no table privileges at all, so a call would fail on the first
-- statement anyway — but "it fails deeper in" is not an access rule, so the
-- implicit grant is revoked and the two roles that need it are named.
--
-- ⚠️ SERVICE ROLE GRANTED EXPLICITLY. Revoking from PUBLIC is exactly what took
-- `vizserve_pms_issue_approval_token` down in Phase 4: the revoke also removed
-- the implicit grant the service role was standing on. `ALTER DEFAULT
-- PRIVILEGES … grant execute on functions to service_role` has been in place
-- since 20260804110000 and should cover this, but it covers it only for the role
-- that ran that statement, and one redundant grant is cheaper than that outage
-- again.
-- ---------------------------------------------------------------------------
-- `authenticated` is granted broadly and REFUSED BY POLICY, which is the whole
-- point of security invoker: a plain member may call this and gets
-- `insufficient_privilege` from step 1, because `forms updatable in scope`
-- matched no row. Narrowing the grant by role would be a third place the
-- authorization rule lives.
--
-- `service_role` holds BYPASSRLS, so a call from a seed script or a cron job
-- skips the policies — as it does for a direct write today. Note that the R5
-- guard gets STRICTER there rather than looser: the trigger's read of
-- `vizserve_pms_requests` is unfiltered, so it sees every submission.
revoke all on function vizserve_pms_save_form_schema(uuid, jsonb) from public;
grant execute on function vizserve_pms_save_form_schema(uuid, jsonb) to authenticated;
grant execute on function vizserve_pms_save_form_schema(uuid, jsonb) to service_role;

-- No table grant for the new column: privileges on vizserve_pms_forms are held
-- at table level (20260729110000_p0_06_grants.sql), so a column added to it
-- inherits them. Stated so the absence reads as a decision.
