import { describe, expect, it } from "vitest";

import { formAudienceSchema, formSettingsSchema } from "@/lib/schemas/forms";

/**
 * P7-66 Phase 5 — WHO SHOULD ANSWER AN INTERNAL FORM.
 *
 * ⚠️ THE RULE WORTH TESTING IS NOT "the list parses". It is that NO ROUTE
 * THROUGH THIS SCHEMA CAN WIDEN AN AUDIENCE BY ACCIDENT.
 *
 * The failure being guarded against is specific and quiet. The audience is
 * stored as a flag plus a row per department, and it is written by
 * delete-then-insert. If "an empty list" were allowed to mean "everyone", then a
 * narrowing that half-lands — a dropped request, a department deleted out from
 * under the rows, a screen that cleared its tick boxes — turns a survey scoped
 * to one department into a company-wide one, with nothing on any screen to say
 * so. That is why `is_all_departments` is carried explicitly rather than
 * inferred, here and in the column underneath.
 *
 * The database says the same thing twice more —
 * `vizserve_pms_set_form_audience` refuses the same pair, and
 * `vizserve_pms_form_targets_me` reads the flag rather than counting rows — but
 * the front end will be bypassed and the schema is the first of the three.
 */

const DEPT_A = "a1000000-0000-4000-8000-000000000001";
const DEPT_B = "a1000000-0000-4000-8000-000000000002";

describe("formAudienceSchema — everyone, or somebody", () => {
  it("accepts everyone with no departments named", () => {
    const result = formAudienceSchema.safeParse({
      is_all_departments: true,
      department_ids: [],
    });

    expect(result.success).toBe(true);
  });

  it("accepts specific departments", () => {
    const result = formAudienceSchema.safeParse({
      is_all_departments: false,
      department_ids: [DEPT_A, DEPT_B],
    });

    expect(result.success).toBe(true);
  });

  it("⚠️ REFUSES specific-departments-with-none, which is a form nobody can answer", () => {
    /*
     * The state is reachable by ACCIDENT — a department deleted elsewhere
     * cascades its audience row away — and the read side handles that correctly
     * by resolving it to nobody. It must not be reachable by REQUEST, because
     * nothing on the screen would explain why a published survey rejects every
     * colleague who opens it.
     */
    const result = formAudienceSchema.safeParse({
      is_all_departments: false,
      department_ids: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/at least one department/i);
    // Anchored to the list, so the message lands under the tick boxes rather
    // than at the top of the card away from the control that caused it.
    expect(result.error?.issues[0]?.path).toEqual(["department_ids"]);
  });

  it("⚠️ keeps everyone and the list as ONE fact, so an empty list never means everyone", () => {
    /*
     * The whole encoding, stated as a test. If `is_all_departments` were ever
     * dropped in favour of "no rows means everyone", THIS is the case that
     * would flip: the payload below would become legal and would mean the
     * opposite of what it says.
     */
    const everyone = formAudienceSchema.safeParse({
      is_all_departments: true,
      department_ids: [],
    });
    const nobody = formAudienceSchema.safeParse({
      is_all_departments: false,
      department_ids: [],
    });

    expect(everyone.success).toBe(true);
    expect(nobody.success).toBe(false);
  });

  it("refuses an id that is not a uuid", () => {
    // A shape check only. The FOREIGN KEY is what refuses an id that names no
    // department, and the audience policy is what refuses a caller who may not
    // set one — neither of which this schema can see.
    const result = formAudienceSchema.safeParse({
      is_all_departments: false,
      department_ids: ["vizbytes"],
    });

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The settings payload that carries it.
// ---------------------------------------------------------------------------

const INTERNAL_SETTINGS = {
  purpose: "INTERNAL",
  name: "Q3 pulse survey",
  slug: "q3-pulse-survey",
  description: "",
  department_id: DEPT_A,
  reference_prefix: "Q3P",
  is_anonymous: false,
  is_quiz: false,
  is_active: true,
  requires_attachment: false,
  sla_minutes: 2400,
  default_list_id: null,
  client_approval_days: 3,
} as const;

describe("formSettingsSchema — the audience is the one optional key", () => {
  it("⚠️ parses without an audience, which means LEAVE IT ALONE", () => {
    /*
     * The exemption from the no-defaults rule, and why it is safe HERE.
     *
     * Every other key on this schema is required because every key that parses
     * is handed STRAIGHT TO `.update()` — an omitted `is_active` is an unpublish,
     * and an omitted `purpose` once put a staff form on the public internet.
     * `audience` is not a column. It gates a separate, atomic write, so absent
     * means that write is not made at all and the stored audience stands. There
     * is no value for it to be overwritten with.
     */
    const result = formSettingsSchema.safeParse(INTERNAL_SETTINGS);

    expect(result.success).toBe(true);
    expect(result.data?.audience).toBeUndefined();
  });

  it("⚠️ is NOT nullable, so there is only one way to say leave it alone", () => {
    /*
     * Null would be a VALUE, and a caller — or a reader of this code — would
     * immediately have to decide whether it meant "everyone" or "do not touch
     * it". Two spellings of the same intent is how the two drift apart. Absent
     * is the only spelling.
     */
    const result = formSettingsSchema.safeParse({ ...INTERNAL_SETTINGS, audience: null });

    expect(result.success).toBe(false);
  });

  it("carries a well-formed audience through", () => {
    const result = formSettingsSchema.safeParse({
      ...INTERNAL_SETTINGS,
      audience: { is_all_departments: false, department_ids: [DEPT_A, DEPT_B] },
    });

    expect(result.success).toBe(true);
    expect(result.data?.audience).toEqual({
      is_all_departments: false,
      department_ids: [DEPT_A, DEPT_B],
    });
  });

  it("refuses a malformed audience rather than dropping it", () => {
    /*
     * ⚠️ THE FAILURE MODE THIS FORBIDS is a schema that strips an unparseable
     * audience and reports success. The settings would save, the audience write
     * would be skipped, and the person would be told everything landed while
     * looking at tick boxes that did not.
     */
    const result = formSettingsSchema.safeParse({
      ...INTERNAL_SETTINGS,
      audience: { is_all_departments: false, department_ids: [] },
    });

    expect(result.success).toBe(false);
  });
});
