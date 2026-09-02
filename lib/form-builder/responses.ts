import type { FormSchema } from "@/lib/form-builder/builder";

/**
 * P7-66 Phase 4b — TURNING A PILE OF `field_values` BLOBS INTO A TABLE.
 *
 * Pure, and deliberately separate from the screen that renders it: the two
 * rules below are the ones that lose data when they are got wrong, and neither
 * of them is visible in a screenshot.
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
 *    an ENGAGEMENT form can be deleted outright while responses still hold its
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

/**
 * ⚠️ AN ANSWER COLUMN'S DataTable ID IS NAMESPACED, AND IT HAS TO BE.
 *
 * `DataTable` uses `Column.key` as the TanStack column id AND as the React key
 * (components/data-table.tsx), and the Responses table draws two fixed identity
 * columns — `submitted_by` and `submitted_at` — before the per-form answer
 * columns. `FIELD_KEY_PATTERN` (`^[a-z][a-z0-9_]*$`) permits both of those
 * words and nothing reserved them, so a form with a question keyed
 * `submitted_by` produced:
 *
 *   - two TanStack columns with the same id, which is undefined behaviour in
 *     the row model rather than a caught error;
 *   - two React children with the same key in the header and in every row;
 *   - and, worst, `pinnedKey` — `columns.find((c) => c.pin === "left")?.key` —
 *     matching the ANSWER column as well, so the answer cell was painted
 *     `sticky left-0 z-20 bg-card` on top of the frozen identity column.
 *
 * A colon can never appear in a field key, so the prefix is collision-proof by
 * construction rather than by a reserved-word list somebody has to remember to
 * extend when a third fixed column is added. `tests/unit/form-responses.test.ts`
 * asserts the disjointness against `RESPONSE_IDENTITY_COLUMN_IDS`.
 */
export const ANSWER_COLUMN_PREFIX = "answer:";

/** The two fixed columns the Responses table can draw before any answer. */
export const RESPONSE_IDENTITY_COLUMN_IDS = ["submitted_by", "submitted_at"] as const;

/**
 * P7-66 — WHICH OF THE TWO A GIVEN FORM ACTUALLY GETS, and the FORM decides.
 *
 * On an anonymous form `submitted_by` is NULL on every row, because the INSERT
 * policy refused to let a name be written — so the column is not drawn at all.
 * Not drawn empty and not drawn hidden: a column full of dashes reads as "the
 * names were lost", and the point of the setting is that there were none.
 *
 * ⚠️ THE ARGUMENT IS `vizserve_pms_forms.is_anonymous`, NEVER A PROPERTY OF THE
 * ROWS ON SCREEN. `rows.every((r) => r.submitted_by === null)` is the tempting
 * shortcut and it is wrong in the expensive direction: an empty page, or a page
 * whose only author is outside the reader's department, satisfies it and would
 * declare a NAMED form anonymous — telling a lead their survey collected no
 * names while the table is full of them.
 *
 * A function rather than a ternary inline in the table so the rule is pinned by
 * a test on a machine with no DOM: `tests/unit/form-anonymity.test.ts` asserts
 * both the column set and the pin, and the table consumes exactly this.
 *
 * The FIRST id is the pinned one. The answer columns are per-form and there can
 * be a dozen, so the table scrolls sideways as a matter of course — a row whose
 * identity has scrolled off the left edge is a row you cannot place, and on an
 * anonymous form the timestamp is the only identity left to freeze.
 */
export function responseIdentityColumnIds(isAnonymous: boolean): readonly string[] {
  return isAnonymous ? [RESPONSE_IDENTITY_COLUMN_IDS[1]] : RESPONSE_IDENTITY_COLUMN_IDS;
}

export function answerColumnId(fieldKey: string): string {
  return `${ANSWER_COLUMN_PREFIX}${fieldKey}`;
}
