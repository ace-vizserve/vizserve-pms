import { isDisplayOnly } from "@/lib/form-builder/canvas";
import type { FormSchema } from "@/lib/form-builder/builder";

/**
 * P7-66 — TURNING A PILE OF `field_values` BLOBS INTO COLUMNS AND CELLS.
 *
 * Pure, and deliberately separate from anything that renders it: the two rules
 * below are the ones that lose data when they are got wrong, and neither of
 * them is visible in a screenshot.
 *
 * ⚠️ P7-66 Phase 4 — THE AGGREGATION HALF OF THIS FILE IS GONE, AND ITS ONLY
 * CONSUMER NOW IS THE CSV EXPORT.
 *
 * It used to also hold `summariseResponses`, `rawAnswerFor`, `responseViewsFor`,
 * `RESPONSE_VIEWS`, `QuestionSummary` and `ChoiceTally` — per-question tallies,
 * choice bars, date spans and a three-way view switcher, feeding a screen that
 * put every question's answers on the Responses tab. Ace, on reading it: "no
 * need to capture all questions its hard to read it."
 *
 * That was the right call twice over. A tab that reprints the whole form is
 * unreadable at exactly the size where reading it matters, and it duplicated —
 * badly, capped at a thousand rows and without saying so past the cap — a job
 * the CSV export already does completely and correctly. The Responses tab is now
 * a count and, on a named form, who answered; the answers themselves live in the
 * file. One place, not two that disagree.
 *
 * What is left is what `lib/form-builder/csv.ts` needs, and it is the part that
 * was never about presentation: which COLUMNS a form's answers have (including
 * the archived and orphaned ones, which is the rule that loses history when it
 * is got wrong) and how one stored value becomes one cell.
 */

/** One column of the Responses table. */
export type ResponseColumn = {
  /** The `field_key` — the storage key, the column key and the React key. */
  key: string;
  /** What the header says. */
  label: string;
  /**
   * Why the column is here.
   *
   *   `active`    a live field on the form as it stands.
   *   `archived`  a field somebody archived. Its answers are still real.
   *   `orphan`    no field on this form claims this key, but answers hold it.
   */
  origin: "active" | "archived" | "orphan";
};

/**
 * ⚠️ A COLUMN THAT VANISHES TAKES ITS HISTORY WITH IT, so two kinds of dead
 * field still get a column.
 *
 * 1. ARCHIVED FIELDS. `is_active = false` carries into the schema as
 *    `attributes.archived`, and the form stops drawing the question — but the
 *    answers people already gave are still sitting in `field_values` under that
 *    key. Building the columns from "the fields the form currently asks" would
 *    silently drop every one of them, and the loss would be invisible: the
 *    table would look complete.
 *
 * 2. ORPHANED KEYS. `vizserve_pms_form_field_protect` refuses to delete a field
 *    that has data — but it counts `vizserve_pms_requests` only, so a field on
 *    an INTERNAL form can be deleted outright while responses still hold its
 *    key. (That gap is roadmap item 5: moving the guard onto the jsonb so it
 *    sees this table too.) Until then the answers outlive the field, and this
 *    is what keeps them on screen. The header is the raw key, because the label
 *    went with the field and inventing one would be a guess.
 *
 * ORDER: the schema's `root`, then orphans sorted by key. `root` is the form's
 * own order, which is the order the person answering saw — reading a row across
 * should read like the form reads down. Orphans have no place in that order, so
 * they go last, and sorted rather than in `Object.keys` order so the table is
 * stable between page loads.
 *
 * DUPLICATE KEYS resolve to the FIRST field in form order, matching
 * `entityIdsByFieldKey` in values.ts. Two fields sharing a key means one column,
 * because there is one key in the stored object and only one answer under it —
 * a second column would render the same value twice under two headings.
 * `formBuilder.validateSchema` refuses to save a duplicate, so this is only
 * reachable for a hand-edited blob; it is defined here so it is defined the
 * same way in both directions.
 */
export function responseColumns(
  schema: FormSchema,
  answeredKeys: Iterable<string>,
): ResponseColumn[] {
  const columns: ResponseColumn[] = [];
  const claimed = new Set<string>();

  // `root` first, then anything else in `entities` — the same two-pass walk
  // `orderedEntities` does, so a schema whose root is incomplete still gets a
  // column per field rather than losing one silently.
  const entityIds = [
    ...schema.root,
    ...Object.keys(schema.entities).filter((id) => !schema.root.includes(id)),
  ];

  for (const entityId of entityIds) {
    // `Object.hasOwn`, never `in` or a bare look-up: `FIELD_KEY_PATTERN` allows
    // `constructor`, and `entities.constructor` answers with a function on any
    // plain object — which would be pushed here as a field with no attributes.
    if (!Object.hasOwn(schema.entities, entityId)) continue;

    const entity = schema.entities[entityId]!;

    /*
     * ⚠️ A THING THAT IS SHOWN IS NOT A COLUMN.
     *
     * A page break, an image and a video are rows in `vizserve_pms_form_fields`
     * like any other, so each arrives here in `root` with a `key` and a `label`.
     * None has an input, so nothing is ever filed under those keys — a column
     * would be a heading over an em-dash on every row of the table and every
     * line of the CSV, for a question nobody was asked.
     *
     * ⚠️ AND THEY MUST NOT `claimed.add` ON THE WAY PAST. The key is derived
     * from the label, so a page break called "Your details" and a question
     * called "Your details" produce the same key. Claiming it here would
     * suppress the REAL question's column and silently drop its answers from the
     * table and the export. Skipping before the claim means the question keeps
     * its column; the display row is simply not there.
     *
     * `answeredKeysOf` needs no equivalent — it reads keys out of stored
     * answers, and no answer has ever held a section's key.
     */
    if (isDisplayOnly(entity.type)) continue;

    const key = entity.attributes.key;

    if (claimed.has(key)) continue;
    claimed.add(key);

    columns.push({
      key,
      // A field with no label is not a state the builder can produce
      // (`labelAttribute` requires one), but a hand-edited blob can, and a
      // blank table header is worse than the key.
      label: entity.attributes.label?.trim() ? entity.attributes.label : key,
      origin: entity.attributes.archived === true ? "archived" : "active",
    });
  }

  const orphans = [...new Set(answeredKeys)].filter((key) => !claimed.has(key)).sort();

  for (const key of orphans) {
    columns.push({ key, label: key, origin: "orphan" });
  }

  return columns;
}

/** Every `field_values` key any of these responses actually holds. */
export function answeredKeysOf(
  responses: ReadonlyArray<{ field_values: unknown }>,
): string[] {
  const keys = new Set<string>();

  for (const response of responses) {
    const values = response.field_values;
    if (typeof values !== "object" || values === null || Array.isArray(values)) continue;
    for (const key of Object.keys(values)) keys.add(key);
  }

  return [...keys];
}

/**
 * One stored answer → one line of text, or `null` for "not answered".
 *
 * ⚠️ `null` AND `""` ARE THE SAME THING HERE, and the caller draws an em-dash
 * for both. The entity validators already drop an untouched optional field
 * rather than storing `""` (values.ts), but an OPTIONAL `email`, `date`,
 * `select` or `number` genuinely does store `""` — a ported quirk of
 * `buildFieldSchema`, documented in entities.ts. Rendering that as a blank cell
 * beside a real blank cell is right; rendering it as an answer would not be.
 *
 * A `file` answer is an array of `{ id, name }` receipts, so the NAMES are
 * shown. The id is a reference into `vizserve_pms_pending_attachments` and is a
 * UUID — never put in front of a person (§6 of the design system). Files cannot
 * be attached on /respond yet, so this is here for the day they can rather than
 * for data that exists today.
 */
export function formatResponseAnswer(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === "string") return value.trim() === "" ? null : value;

  // `false` is an answer, not an absence, so this cannot be a truthiness check.
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (Array.isArray(value)) {
    const parts = value.map(formatArrayMember).filter((part): part is string => part !== null);
    return parts.length === 0 ? null : parts.join(", ");
  }

  // An object that is not an array — a shape nothing in this system stores
  // today. Shown as "1 item" rather than `[object Object]` or a JSON dump: the
  // first is meaningless and the second could be long enough to break the row.
  return "1 item";
}

/** A member of a multiselect list, or a file receipt. */
function formatArrayMember(member: unknown): string | null {
  if (typeof member === "string") return member.trim() === "" ? null : member;
  if (typeof member === "number") return String(member);

  if (typeof member === "object" && member !== null && Object.hasOwn(member, "name")) {
    const name = (member as { name?: unknown }).name;
    if (typeof name === "string" && name.trim() !== "") return name;
  }

  return null;
}

/** The answer to one field on one response, ready to render. */
export function answerFor(fieldValues: unknown, key: string): string | null {
  if (typeof fieldValues !== "object" || fieldValues === null || Array.isArray(fieldValues)) {
    return null;
  }

  // `Object.hasOwn` for the reason values.ts gives at length: `"constructor" in
  // {}` is true on every object there has ever been, and a field keyed that way
  // would render a function.
  if (!Object.hasOwn(fieldValues, key)) return null;

  return formatResponseAnswer((fieldValues as Record<string, unknown>)[key]);
}
