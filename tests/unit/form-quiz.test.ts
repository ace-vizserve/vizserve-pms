import { describe, expect, it } from "vitest";

import { fieldGradingSchema, formSettingsSchema } from "@/lib/schemas/forms";

/**
 * P7-66 Phase 8 — THE QUIZ CONTRACT THAT LIVES IN TYPESCRIPT.
 *
 * Most of this feature is enforced in Postgres and cannot be tested from here —
 * `tests/db` runs against LIVE production and is not run. What IS here is the
 * shape the browser sends and the two rules `formSettingsSchema` has to keep,
 * both of which have bitten this file's neighbours before:
 *
 *   `is_quiz` MUST NOT DEFAULT on the update schema. Six fields once silently
 *   overwrote stored values because they defaulted, and one of them published a
 *   staff form. A defaulted `is_quiz` would quietly stop a form being marked on
 *   the next unrelated Save.
 *
 *   AN EMPTY KEY IS A SHAPE, NOT AN OMISSION. "Not marked" and "marked, nothing
 *   is right" are different states, and the action — not the schema — is what
 *   turns the first into a NULL. The schema's job is only to make the browser's
 *   payload uniform.
 *
 * The marking itself (`vizserve_pms_form_response_score`), the internal-only
 * rule (`vizserve_pms_forms_quiz_is_internal`), the choice-field rule and the
 * "key must be a subset of the options" rule are all SQL, in
 * 20260902160000_p7_66_quiz.sql, and are checked by reading it.
 */

describe("formSettingsSchema · is_quiz", () => {
  const complete = {
    name: "Induction quiz",
    slug: "induction-quiz",
    description: "",
    department_id: null,
    reference_prefix: "IND",
    purpose: "INTERNAL" as const,
    is_anonymous: false,
    is_quiz: true,
    is_active: false,
    requires_attachment: false,
    sla_minutes: 480,
    default_list_id: null,
    client_approval_days: 3,
  };

  it("accepts a payload that states it", () => {
    const parsed = formSettingsSchema.safeParse(complete);

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.is_quiz).toBe(true);
  });

  it("REFUSES a payload that omits it, rather than defaulting to false", () => {
    /*
     * ⚠️ THE WHOLE POINT OF THIS TEST. A default here would mean a settings save
     * that forgot the key turns marking OFF on a live quiz — silently, on a form
     * whose Responses tab would simply stop showing scores for new answers, with
     * nothing anywhere saying which save did it.
     *
     * Refusing is loud, and loud is the correct failure for a payload that does
     * not say what it wants.
     */
    const withoutQuiz: Record<string, unknown> = { ...complete };
    delete withoutQuiz.is_quiz;

    expect(formSettingsSchema.safeParse(withoutQuiz).success).toBe(false);
  });

  it("carries false through unchanged", () => {
    // A client form sends a constant false. It must survive the parse as false
    // rather than being treated as absent.
    const parsed = formSettingsSchema.safeParse({
      ...complete,
      purpose: "CLIENT_REQUEST" as const,
      is_quiz: false,
    });

    expect(parsed.success && parsed.data.is_quiz).toBe(false);
  });
});

describe("fieldGradingSchema", () => {
  const fieldId = "11111111-1111-4111-8111-111111111111";

  it("accepts one correct option", () => {
    const parsed = fieldGradingSchema.safeParse({
      field_id: fieldId,
      correct_answer: ["Alpha"],
      points: 2,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts several, which is how a Choose many key is expressed", () => {
    const parsed = fieldGradingSchema.safeParse({
      field_id: fieldId,
      correct_answer: ["Alpha", "Beta"],
      points: 1,
    });

    expect(parsed.success && parsed.data.correct_answer).toEqual(["Alpha", "Beta"]);
  });

  it("accepts an empty key, because unticking the last option is not an error", () => {
    /*
     * ⚠️ IT PARSES HERE AND BECOMES NULL IN THE ACTION. The database refuses an
     * empty array — "pick at least one correct option" — because a marked
     * question with no right answer is a question nobody can get right. But
     * unticking the last box means STOP MARKING THIS QUESTION, which is a NULL,
     * and the two must not arrive at the same place. Refusing here would put a
     * validation error in front of somebody doing something reasonable.
     */
    const parsed = fieldGradingSchema.safeParse({
      field_id: fieldId,
      correct_answer: [],
      points: 1,
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses zero points", () => {
    // `vizserve_pms_form_fields_points_positive` refuses it underneath; a
    // question worth nothing is not a question the quiz is asking.
    const parsed = fieldGradingSchema.safeParse({
      field_id: fieldId,
      correct_answer: ["Alpha"],
      points: 0,
    });

    expect(parsed.success).toBe(false);
  });

  it("reads points from a form field, which arrives as a string", () => {
    // The editor's Points box is an `<input type="number">`, whose value is a
    // string. `z.coerce` is what stops that being a validation error nobody
    // could act on.
    const parsed = fieldGradingSchema.safeParse({
      field_id: fieldId,
      correct_answer: ["Alpha"],
      points: "3",
    });

    expect(parsed.success && parsed.data.points).toBe(3);
  });

  it("refuses a fractional score", () => {
    const parsed = fieldGradingSchema.safeParse({
      field_id: fieldId,
      correct_answer: ["Alpha"],
      points: 1.5,
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses a field id that is not a uuid", () => {
    // The entity id IS the row id, so a non-uuid is a caller that has invented
    // one rather than read it off the schema.
    const parsed = fieldGradingSchema.safeParse({
      field_id: "not-a-uuid",
      correct_answer: ["Alpha"],
      points: 1,
    });

    expect(parsed.success).toBe(false);
  });
});
