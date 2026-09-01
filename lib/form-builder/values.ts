import { validateEntitiesValues, type EntitiesErrors } from "@coltorapps/builder";
import { z } from "zod";

import { formBuilder, type FormSchemaEntity } from "@/lib/form-builder/builder";
import type { ParsedFormSchema } from "@/lib/form-builder/schema";

/**
 * P7-63 Phase 0 — THE TRANSLATION LAYER. §1 of the plan, and the highest-risk
 * file in the change.
 *
 * The library keys values AND errors by entity id. The database keys
 * `vizserve_pms_requests.field_values` by `field_key`, and has done since the
 * first submission. Key the storage by entity id and every historical
 * submission becomes unreadable — silently, because a missing key renders as a
 * blank answer rather than an error.
 *
 * So the two live side by side and this file is the only place that crosses
 * between them:
 *
 *   submit:  { [field_key]: value }  →  { [entityId]: value }  →  validate
 *   store:   result.data             →  { [field_key]: value }  →  jsonb
 *   errors:  entitiesErrors          →  { [field_key]: message }
 *
 * The error direction needs its own extractor because the library types an
 * entity error as `unknown` — it is whatever `validate` threw, which here is
 * always a `ZodError`, and `submissionResultSchema.field_errors` has always
 * promised the browser a plain `Record<string, string>`.
 *
 * Everything here takes a `ParsedFormSchema`, never a raw blob. That is what
 * guarantees the attribute defaults have been applied and that the keys and
 * entity ids are well formed — see the brand in schema.ts.
 *
 * NO `in`, AND NO BARE BRACKET LOOK-UP, on anything keyed by a `field_key` or
 * an entity id. `FIELD_KEY_PATTERN` and the column's CHECK both allow
 * `constructor`, and `"constructor" in {}` is true for every object there has
 * ever been — which is how a field named that had its error message dropped and
 * left the requester staring at a refusal with nothing highlighted. Reads go
 * through `Object.hasOwn`, and every field-keyed object is built with
 * `Object.fromEntries`, which defines own properties rather than assigning
 * through the prototype.
 */

export type FieldValues = Record<string, unknown>;

/**
 * THE ONE RULE for a duplicate `field_key`: the FIRST field in form order owns
 * it, in every direction.
 *
 * `formBuilder.validateSchema` refuses to save a duplicate, so this is only
 * reachable for a hand-edited blob. It still has to be decided somewhere,
 * because the two directions used to disagree — the key→id map resolved by form
 * order and the id→key map by object iteration order, so a text field and a
 * multiselect sharing one key would take the typed answer in and hand a `[]`
 * back out to be stored. Whatever the rule is, both directions have to use it,
 * and form order is the only one a reader can predict.
 */
function orderedEntities(schema: ParsedFormSchema): Array<[string, FormSchemaEntity]> {
  const seen = new Set<string>();
  const entries: Array<[string, FormSchemaEntity]> = [];

  for (const entityId of schema.root) {
    // `Object.hasOwn`, not truthiness: `entities["constructor"]` answers with a
    // function on any plain object, and that would have been pushed here as a
    // field with no attributes on it.
    if (seen.has(entityId) || !Object.hasOwn(schema.entities, entityId)) continue;

    seen.add(entityId);
    entries.push([entityId, schema.entities[entityId]]);
  }

  /*
   * Then anything else in `entities` — belt and braces, and unreachable in
   * practice.
   *
   * An entity absent from `root` with no parent is `UnreachableEntity`, which
   * `parseFormSchema` now refuses outright; it used to be branded, and
   * `validateEntitiesValues` would then resolve `{ success: true }` having
   * quietly ignored the answer, so a required question was skipped and the
   * requester's reply discarded while the submission reported success. That is
   * the drop this loop was once defended as preventing, and it was causing it.
   *
   * `schemaFromFields` puts every field in `root`, so nothing that mints a
   * schema can produce one of these. The loop stays only so that duplicate-key
   * resolution is defined for the whole record rather than for part of it.
   */
  for (const [entityId, entity] of Object.entries(schema.entities)) {
    if (!seen.has(entityId)) {
      seen.add(entityId);
      entries.push([entityId, entity]);
    }
  }

  return entries;
}

/** `field_key` → entity id, in form order. First field wins on a clash. */
export function entityIdsByFieldKey(schema: ParsedFormSchema): Map<string, string> {
  const byKey = new Map<string, string>();

  for (const [entityId, entity] of orderedEntities(schema)) {
    if (!byKey.has(entity.attributes.key)) byKey.set(entity.attributes.key, entityId);
  }

  return byKey;
}

/**
 * entity id → `field_key`, for every entity.
 *
 * Note the asymmetry with `entityIdsByFieldKey`: the loser of a duplicate key
 * still appears here, mapped to the key it shares. That is used only for
 * ERRORS, where dropping the loser would mean refusing a submission with
 * nothing to show for it. Values go the other way round — see `toFieldValues`.
 */
export function fieldKeysByEntityId(schema: ParsedFormSchema): Map<string, string> {
  const byId = new Map<string, string>();

  for (const [entityId, entity] of orderedEntities(schema)) {
    byId.set(entityId, entity.attributes.key);
  }

  return byId;
}

/**
 * Stored/submitted shape → the shape the library validates.
 *
 * A key with no field behind it is DROPPED. That is a field somebody archived
 * or deleted after the answer was given; carrying it forward would put a value
 * under an entity id that does not exist, and the library would ignore it
 * anyway.
 */
export function toEntityValues(
  schema: ParsedFormSchema,
  fieldValues: FieldValues,
): Record<string, unknown> {
  const byKey = entityIdsByFieldKey(schema);
  const entries: Array<[string, unknown]> = [];

  for (const [key, value] of Object.entries(fieldValues)) {
    const entityId = byKey.get(key);
    if (entityId !== undefined) entries.push([entityId, value]);
  }

  return Object.fromEntries(entries);
}

/**
 * Validated output → the shape that goes into `field_values`.
 *
 * Driven from `entityIdsByFieldKey` rather than from the values object, so the
 * field that owns a key on the way IN is the same field that fills it on the
 * way OUT. Iterating the values instead let object key order decide, which is
 * how a duplicate key could swallow a real answer.
 *
 * `undefined` is dropped rather than written. The library returns a key for
 * every processable entity whether or not it had a value, so an untouched
 * optional field arrives here as `undefined` — writing it would put `null` in
 * the jsonb, which reads back as an answer somebody gave.
 */
export function toFieldValues(
  schema: ParsedFormSchema,
  entityValues: Record<string, unknown>,
): FieldValues {
  const entries: Array<[string, unknown]> = [];

  for (const [key, entityId] of entityIdsByFieldKey(schema)) {
    if (!Object.hasOwn(entityValues, entityId)) continue;

    const value = entityValues[entityId];
    if (value !== undefined) entries.push([key, value]);
  }

  return Object.fromEntries(entries);
}

/**
 * P7-66 Phases 2+3 — THE PAYLOAD MERGE, where the public form's two state
 * owners meet.
 *
 * After the swap the form has two of them: `react-hook-form` holds the five
 * fixed fields every client request carries, and the interpreter store holds the
 * per-form answers, keyed by entity id and validated by the entity declarations.
 * Neither can see the other's values, so exactly one function joins them, and
 * this is it.
 *
 * ⚠️ THE NESTING IS THE COLLISION RULE, NOT A LAYOUT CHOICE. A form may
 * perfectly well carry a field keyed `title` or `description` — nothing forbids
 * it, `FIELD_KEY_PATTERN` allows it, and the fixed fields are not reserved words
 * — and a flat merge would have that answer silently overwrite the requester's
 * actual title. Under `field_values` the two cannot reach each other, which is
 * also exactly where `vizserve_pms_submit_request` looks for it:
 * `p_payload -> 'field_values' -> field_key`.
 *
 * ⚠️ AND `field_values` IS WRITTEN LAST, so a `field_values` key that somehow
 * arrived in the core object cannot displace the real one.
 *
 * Field-keyed on the way out, per §1: the entity ids stay inside this module.
 */
export function mergeSubmissionPayload(
  coreValues: Record<string, unknown>,
  schema: ParsedFormSchema,
  entityValues: Record<string, unknown>,
): Record<string, unknown> {
  return { ...coreValues, field_values: toFieldValues(schema, entityValues) };
}

/**
 * Entity-keyed errors → the `Record<string, string>` the browser expects.
 *
 * Walked in form order and never overwritten, so the duplicate key that
 * `toFieldValues` resolves to the first field resolves to the first field's
 * message here too — but a loser's error still surfaces if the winner had none,
 * because a refusal the form cannot point at is worse than a message sitting on
 * a field that shares its key.
 *
 * "Never overwritten" is tracked in a `Set`, not by asking the result object
 * whether it has the key yet. `"constructor" in {}` is true, so a field
 * legitimately keyed `constructor` was read as already-answered-for and had its
 * message dropped — producing precisely the blank refusal the paragraph above
 * exists to rule out.
 */
export function toFieldErrors(
  schema: ParsedFormSchema,
  entitiesErrors: EntitiesErrors,
): Record<string, string> {
  const claimed = new Set<string>();
  const entries: Array<[string, string]> = [];

  for (const [entityId, key] of fieldKeysByEntityId(schema)) {
    if (claimed.has(key) || !Object.hasOwn(entitiesErrors, entityId)) continue;

    claimed.add(key);
    entries.push([key, extractErrorMessage(entitiesErrors[entityId])]);
  }

  return Object.fromEntries(entries);
}

/**
 * Where each `field_errors` entry belongs on the page that has two state owners.
 *
 * `entities` are the interpreter store's, by entity id; `core` are the host's
 * own fixed inputs, by name; `unplaced` is the first message nothing on the page
 * can show, which the caller raises to the form level rather than dropping.
 */
export type RoutedFieldErrors = {
  entities: Array<{ entityId: string; message: string }>;
  core: Array<{ name: string; message: string }>;
  unplaced: string | null;
};

/**
 * P7-66 — the return leg of §1, and the ONE PLACE THAT DECIDES WHO OWNS A KEY.
 *
 * ⚠️ A PER-FORM FIELD WINS THE KEY. THE CORE LIST IS ONLY A FALLBACK, and the
 * order is the entire content of this function.
 *
 * `field_errors` is FLAT — one `Record<string, string>` keyed by `field_key` —
 * so the nesting that keeps a per-form field named `title` out of the
 * requester's actual title on the way OUT (`mergeSubmissionPayload`) does not
 * exist on the way BACK. Nothing forbids such a field: `FIELD_KEY_PATTERN`
 * allows it and the five fixed names are not reserved words.
 *
 * Asking "is this a core name?" first therefore put the server's message on the
 * core Title input while the blank per-form field showed nothing — and that is
 * not a cosmetic mix-up but an UNFIXABLE LOOP on a page anyone on the internet
 * can open: react-hook-form clears the bogus message the moment the requester
 * edits the title it is sitting on, the field the server is actually complaining
 * about is still blank, and the server refuses again. Round for ever, with the
 * only usable instruction pointing at the wrong box.
 *
 * Resolving the entity first cannot have the mirror problem. A core name reaches
 * the fallback only when NO field on this form claims that key, which is exactly
 * when the core input is the thing being complained about.
 *
 * The core list is a predicate rather than a list, because it belongs to the
 * host — this module knows about `field_key`s and entity ids and has no opinion
 * about what a page collects alongside them.
 */
export function routeFieldErrors(
  schema: ParsedFormSchema,
  fieldErrors: Record<string, string>,
  isCoreField: (key: string) => boolean,
): RoutedFieldErrors {
  const entityIdByKey = entityIdsByFieldKey(schema);
  const routed: RoutedFieldErrors = { entities: [], core: [], unplaced: null };

  for (const [key, message] of Object.entries(fieldErrors)) {
    const entityId = entityIdByKey.get(key);

    if (entityId !== undefined) {
      routed.entities.push({ entityId, message });
      continue;
    }

    if (isCoreField(key)) {
      routed.core.push({ name: key, message });
      continue;
    }

    // Nothing on this page collects that key — `attachments` is the live
    // example, and it used to be set on a `field_values.attachments` path that
    // renders nowhere, so the client was refused with no reason shown.
    routed.unplaced ??= message;
  }

  return routed;
}

/**
 * Whatever `validate` threw → one sentence for the person filling the form.
 *
 * ONLY a `ZodError` gets through. Ours throw `ZodError`, whose first issue
 * carries the message the old `buildFieldSchema` branch was written to produce
 * — so this is what keeps the wording identical after the swap. Anything else
 * that lands here is a crash, not a rule, and a crash message printed beside a
 * field reads as advice to the requester on a page anyone on the internet can
 * open. This is the last of three layers, not the only one: the entity
 * validators are the ones that throw, and they are given attributes
 * `parseFormSchema` has already normalised.
 */
export function extractErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues[0]?.message ?? FALLBACK_ERROR_MESSAGE;
  }

  return FALLBACK_ERROR_MESSAGE;
}

const FALLBACK_ERROR_MESSAGE = "This answer is not valid.";

/**
 * Shown when the form itself, rather than an answer, is the problem. It carries
 * no detail for the same reason `extractErrorMessage` falls back: the requester
 * is unauthenticated and the detail is ours.
 */
export const FORM_ERROR_MESSAGE = "This form could not be checked. Please contact the team.";

export type FieldValuesValidation =
  | { ok: true; values: FieldValues }
  | { ok: false; fieldErrors: Record<string, string>; formError?: string };

/**
 * The server-side entry point: field-keyed in, field-keyed out.
 *
 * Callers never see an entity id. That is the point — the translation is a
 * detail of this file, so a server action and a public renderer both keep
 * speaking the language `field_values` and `field_errors` are already written
 * in (submissionResultSchema, public-form.tsx).
 *
 * It RESOLVES, always. `validateEntitiesValues` reports a bad ANSWER by
 * resolving with `entitiesErrors`, but reports a bad SCHEMA by throwing
 * `SchemaValidationError` — and this sits behind an endpoint with no session,
 * where an uncaught throw is a 500 rather than a message. `parseFormSchema` runs
 * the library's own `validateSchema`, so a schema that reaches here has already
 * been accepted by the same code that would do the throwing; if one still gets
 * through, that is our bug, and the requester gets an answer rather than a
 * stack trace.
 */
export async function validateFieldValues(
  schema: ParsedFormSchema,
  fieldValues: FieldValues,
): Promise<FieldValuesValidation> {
  let result;

  try {
    result = await validateEntitiesValues(toEntityValues(schema, fieldValues), formBuilder, schema);
  } catch {
    return { ok: false, fieldErrors: {}, formError: FORM_ERROR_MESSAGE };
  }

  if (!result.success) {
    return { ok: false, fieldErrors: toFieldErrors(schema, result.entitiesErrors) };
  }

  return { ok: true, values: toFieldValues(schema, result.data) };
}
