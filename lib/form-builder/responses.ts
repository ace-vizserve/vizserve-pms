import type { FormSchema } from "@/lib/form-builder/builder";
import type { FieldType } from "@/lib/schemas/forms";

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
 * P7-66 — WHICH WAYS OF READING THE ANSWERS THIS FORM OFFERS.
 *
 * ⚠️ AN ANONYMOUS FORM HAS NO INDIVIDUAL VIEW, AND THE REASON IS THAT THERE IS
 * NO INDIVIDUAL TO SHOW. `submitted_by` is NULL on every row because the INSERT
 * policy refused to let a name be written, so the view would page through
 * submissions headed "somebody", with a monogram it cannot draw and a name it
 * cannot print. A screen whose entire subject is absent is not a screen.
 *
 * ⚠️ IT IS NOT A CLAIM THAT THE PER-SUBMISSION GROUPING IS SECRET, AND IT MUST
 * NOT BE READ AS ONE. One response is one `field_values` blob: the grouping IS
 * the row. It is in the CSV export, it is in the RSC payload this page sends,
 * and it is in the table for anyone with SQL. Anonymity here means one specific
 * thing — NO NAME WAS EVER WRITTEN — and it has never meant that answers cannot
 * be read together.
 *
 * ⚠️ WHICH LEAVES A REAL RESIDUAL RISK, STATED RATHER THAN IMPLIED AWAY: on a
 * small team, one long free-text answer is re-identifiable by writing style, and
 * a minute-precision timestamp is re-identifiable by whoever watched somebody
 * fill the form in. Neither is fixed by hiding a tab. If that matters for a
 * given survey, the answers are what need coarsening — a decision for whoever
 * runs it, and one this file cannot make on their behalf.
 *
 * ⚠️ THE ARGUMENT IS `vizserve_pms_forms.is_anonymous`, NEVER A PROPERTY OF THE
 * ROWS ON SCREEN. `rows.every((r) => r.submitted_by === null)` is the tempting
 * shortcut and it is wrong in the expensive direction: an empty page, or a page
 * whose only author is outside the reader's department, satisfies it and would
 * declare a NAMED form anonymous — hiding attribution that exists and telling a
 * lead their survey collected no names while the table is full of them.
 *
 * A function rather than a ternary inside the component, so the rule is pinned
 * by a test on a machine with no DOM. Its signature takes a boolean and no
 * rows, which is the guarantee written into the type.
 *
 * This replaced `responseIdentityColumnIds`, which decided the same thing for
 * the flat table's pinned "Submitted by" column. The table is gone — a summary
 * replaced it — and the rule moved with the screen rather than being deleted
 * with it.
 */
export const RESPONSE_VIEWS = ["summary", "question", "individual"] as const;

export type ResponseView = (typeof RESPONSE_VIEWS)[number];

export function responseViewsFor(isAnonymous: boolean): readonly ResponseView[] {
  return isAnonymous ? RESPONSE_VIEWS.filter((view) => view !== "individual") : RESPONSE_VIEWS;
}


// ---------------------------------------------------------------------------
// P7-66 — READING THE ANSWERS, NOT JUST LISTING THEM.
//
// ⚠️ THE FLAT TABLE SAID "NO CHART, NO AGGREGATION, NO PER-QUESTION SUMMARY,
// BECAUSE NONE OF THAT WAS ASKED FOR." It is asked for now, and the reason it
// was worth waiting for is in that same note: every one of these is a decision
// about what the numbers MEAN, and the decisions are here, in one pure file,
// rather than spread through a screen.
//
// The three that matter:
//
//   WHAT IS THE DENOMINATOR. A percentage against the number of RESPONSES is
//   wrong on a question four people skipped — the bars would sum to less than
//   100% with nothing saying why. Against the number who ANSWERED THAT
//   QUESTION, "60% chose Home" means what it says. `blank` is reported
//   separately so the skipping is visible rather than hidden in the arithmetic.
//
//   WHAT COUNTS AS AN ANSWER. `answerFor`'s rule, unchanged and shared with the
//   table: `null`, `undefined`, `""` and `[]` are all "not answered". An
//   OPTIONAL email, date, select or number genuinely stores `""` (a ported
//   quirk documented in entities.ts), so a rule that counted those as answers
//   would inflate every optional question on every form.
//
//   WHAT HAPPENS TO A CHOICE NOBODY OFFERS ANY MORE. Options are editable, and
//   an answer given under an option since removed is still a real answer. It is
//   tallied, at the end, marked `offered: false` — dropping it would make the
//   counts disagree with the number of people who answered.
// ---------------------------------------------------------------------------

/** One row of a choice question's tally. */
export type ChoiceTally = {
  option: string;
  count: number;
  /**
   * Whether the form still offers this choice.
   *
   * False means somebody answered it and it was removed afterwards. The screen
   * says so rather than dropping it — see the note above.
   */
  offered: boolean;
};

/** One question, summarised over every response the page loaded. */
export type QuestionSummary = {
  column: ResponseColumn;
  /** The entity's type, or null for an orphaned key with no field behind it. */
  fieldType: FieldType | null;
  /** How many responses gave an answer to this question. */
  answered: number;
  /** How many left it blank. `answered + blank` is the response count. */
  blank: number;
} & (
  | { kind: "choice"; tallies: ChoiceTally[] }
  | { kind: "date"; earliest: string | null; latest: string | null }
  | {
      kind: "text";
      /**
       * Every answer, with the index of the response it came from — so the
       * screen can attach the author and the timestamp without this file
       * knowing anything about either.
       */
      answers: { responseIndex: number; text: string }[];
    }
);

/** The stored value for one field on one response, before any formatting. */
export function rawAnswerFor(fieldValues: unknown, key: string): unknown {
  if (typeof fieldValues !== "object" || fieldValues === null || Array.isArray(fieldValues)) {
    return undefined;
  }

  // `Object.hasOwn` for the reason values.ts gives at length: `"constructor" in
  // {}` is true on every object there has ever been.
  if (!Object.hasOwn(fieldValues, key)) return undefined;

  return (fieldValues as Record<string, unknown>)[key];
}

/**
 * Every question on the form, summarised.
 *
 * ⚠️ THE COLUMNS COME FROM `responseColumns`, WHICH MEANS ARCHIVED AND ORPHANED
 * QUESTIONS ARE SUMMARISED TOO. A question somebody archived last week still has
 * a hundred answers behind it, and a summary that quietly stopped counting them
 * would be a page reporting fewer answers than the form received. The screen
 * marks them; this decides they exist.
 *
 * ⚠️ ORPHANED KEYS HAVE NO ENTITY, SO THEY HAVE NO TYPE. They are summarised as
 * text, which is the only reading available: there is no field left to say the
 * answers were choices, and inventing an option list from the values that
 * happen to be there would be a guess presented as a tally.
 */
export function summariseResponses(
  schema: FormSchema,
  responses: ReadonlyArray<{ field_values: unknown }>,
): QuestionSummary[] {
  const columns = responseColumns(schema, answeredKeysOf(responses));

  /*
   * key → the entity behind it. Built the same way `responseColumns` claims
   * keys — first field in form order wins — so a duplicate key summarises the
   * same field the table draws a column for.
   */
  const byKey = new Map<string, FormSchema["entities"][string]>();

  for (const entityId of [
    ...schema.root,
    ...Object.keys(schema.entities).filter((id) => !schema.root.includes(id)),
  ]) {
    if (!Object.hasOwn(schema.entities, entityId)) continue;

    const entity = schema.entities[entityId]!;
    if (!byKey.has(entity.attributes.key)) byKey.set(entity.attributes.key, entity);
  }

  return columns.map((column) => {
    const entity = byKey.get(column.key);
    const fieldType = (entity?.type as FieldType | undefined) ?? null;

    /*
     * ⚠️ ANSWERED IS DECIDED BY `answerFor`, THE FORMATTER, AND THAT IS
     * DELIBERATE. It is the one place the "what counts as an answer" rule lives,
     * it is shared with the flat table, and it already handles the `""` that an
     * optional email/date/select/number stores. A second rule here would drift
     * from it and the two screens would report different totals for one form.
     */
    const answeredIndexes: number[] = [];

    responses.forEach((response, index) => {
      if (answerFor(response.field_values, column.key) !== null) answeredIndexes.push(index);
    });

    const answered = answeredIndexes.length;
    const blank = responses.length - answered;
    const base = { column, fieldType, answered, blank };

    if (fieldType === "select" || fieldType === "multiselect") {
      return { ...base, kind: "choice", tallies: tally(entity, responses, column.key) };
    }

    if (fieldType === "date") {
      return { ...base, kind: "date", ...dateRange(responses, column.key) };
    }

    return {
      ...base,
      kind: "text",
      answers: answeredIndexes.map((responseIndex) => ({
        responseIndex,
        // Non-null by construction: this index is in the list precisely because
        // `answerFor` returned a string for it.
        text: answerFor(responses[responseIndex]!.field_values, column.key)!,
      })),
    };
  });
}

/**
 * One choice question's counts, in the form's own option order.
 *
 * ⚠️ EVERY DECLARED OPTION GETS A ROW, INCLUDING A ZERO. "Nobody picked
 * Contact" is a finding; a missing row is an absence somebody has to notice.
 *
 * ⚠️ A MULTISELECT ANSWER COUNTS ONCE PER OPTION CHOSEN, so the tallies can sum
 * to more than `answered`. That is what the question means, and it is why the
 * percentage the screen draws is against `answered` rather than against the sum
 * — "60% of the people who answered chose Home" is true of a multiselect;
 * "Home is 30% of all selections" is a different and less useful number.
 */
function tally(
  entity: FormSchema["entities"][string] | undefined,
  responses: ReadonlyArray<{ field_values: unknown }>,
  key: string,
): ChoiceTally[] {
  const counts = new Map<string, number>();

  for (const option of entity?.attributes.options ?? []) counts.set(option, 0);

  // Answers under options nobody offers any more. Kept apart so they can be
  // reported after the live ones and marked — see the note at the top.
  const retired = new Map<string, number>();

  for (const response of responses) {
    const raw = rawAnswerFor(response.field_values, key);
    const chosen = Array.isArray(raw) ? raw : [raw];

    for (const value of chosen) {
      if (typeof value !== "string" || value.trim() === "") continue;

      if (counts.has(value)) counts.set(value, counts.get(value)! + 1);
      else retired.set(value, (retired.get(value) ?? 0) + 1);
    }
  }

  return [
    ...[...counts].map(([option, count]) => ({ option, count, offered: true })),
    // Sorted, so the table is stable between page loads rather than following
    // whatever order the responses came back in.
    ...[...retired]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([option, count]) => ({ option, count, offered: false })),
  ];
}

/**
 * The span a date question's answers cover.
 *
 * ⚠️ COMPARED AS STRINGS, WHICH IS CORRECT FOR `YYYY-MM-DD` AND ONLY FOR IT.
 * That is the stored shape (`dateEntity`), and it sorts lexically exactly as it
 * sorts chronologically — so this needs no parsing, which is the point:
 * `lib/dates.ts` exists because parsing a bare date wrong lands it on the
 * previous day in any negative offset, and a comparison that never parses
 * cannot make that mistake.
 *
 * Anything that is not that shape is ignored rather than guessed at. A blob
 * hand-edited to hold `31/12/2026` would otherwise sort as the latest date on
 * any form it appears on.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function dateRange(
  responses: ReadonlyArray<{ field_values: unknown }>,
  key: string,
): { earliest: string | null; latest: string | null } {
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const response of responses) {
    const raw = rawAnswerFor(response.field_values, key);
    if (typeof raw !== "string" || !ISO_DATE.test(raw)) continue;

    if (earliest === null || raw < earliest) earliest = raw;
    if (latest === null || raw > latest) latest = raw;
  }

  return { earliest, latest };
}
