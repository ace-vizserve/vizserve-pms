import { describe, expect, it } from "vitest";

import {
  APPROVAL_STAGE_LABELS,
  MAX_RELIEVERS,
  TURNOVER_CONFIRMATION_TEXT,
  internalRequestSchema,
  isChained,
} from "@/lib/schemas/internal-requests";

/**
 * P9-01 — the hand-over block's own rules.
 *
 * ⚠️ WHAT THIS FILE CANNOT TEST, and it is most of the feature. Every rule here
 * is ALSO in `vizserve_pms_submit_internal_request`, because the front end will
 * be bypassed — and three of the rules exist ONLY there, because they are
 * questions about other tables that no zod schema can ask:
 *
 *   * whether this leave type requires a reliever at all
 *     (`vizserve_pms_leave_types.requires_reliever`)
 *   * whether each named person is an active member of the requester's own
 *     department
 *   * whether each task is one the requester is actually on
 *     (`vizserve_pms_is_on_task`, which counts P7-13 assignees, not just the PIC)
 *
 * Those belong to `tests/db/`, which cannot run against the live project in
 * `.env`. So what is pinned here is the SHAPE — the part a person filling the
 * form should be told about on the field rather than after a round trip.
 */

const leave = (over: Record<string, unknown> = {}) => ({
  request_type: "LEAVE" as const,
  reason: "Family trip, booked months ago.",
  start_date: "2026-10-05",
  end_date: "2026-10-09",
  leave_type_id: "11111111-1111-4111-8111-111111111111",
  ...over,
});

const person = (n: number) => `2222222${n}-2222-4222-8222-222222222222`;
const task = (n: number) => `3333333${n}-3333-4333-8333-333333333333`;

describe("a leave request with no hand-over", () => {
  it("still parses — most leave types need none", () => {
    const parsed = internalRequestSchema.safeParse(leave());
    expect(parsed.success).toBe(true);
    // The default matters: the submit action forwards this array as
    // `p_relievers`, and `undefined` there would submit SQL NULL for a type
    // that may require one.
    expect(parsed.success && parsed.data).toMatchObject({
      relievers: [],
      turnover_confirmed: false,
    });
  });

  it("does not demand the confirmation when nobody was named", () => {
    // The tick is a claim ABOUT the rows above it. Requiring it on a sick-leave
    // request with no hand-over would be asking somebody to attest to nothing.
    expect(internalRequestSchema.safeParse(leave({ turnover_confirmed: false })).success).toBe(
      true,
    );
  });
});

describe("the hand-over rules", () => {
  const ok = leave({
    relievers: [{ reliever_id: person(1), task_ids: [task(1), task(2)] }],
    turnover_confirmed: true,
  });

  it("accepts one reliever holding two tasks", () => {
    expect(internalRequestSchema.safeParse(ok).success).toBe(true);
  });

  it("refuses a reliever with no tasks", () => {
    // A name on a form with no work against it is an approval nobody can reason
    // about — the point of the stage is that the person agrees to take THOSE
    // tasks.
    const parsed = internalRequestSchema.safeParse(
      leave({
        relievers: [{ reliever_id: person(1), task_ids: [] }],
        turnover_confirmed: true,
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it(`refuses more than ${MAX_RELIEVERS}`, () => {
    const parsed = internalRequestSchema.safeParse(
      leave({
        relievers: [1, 2, 3, 4].map((n) => ({ reliever_id: person(n), task_ids: [task(n)] })),
        turnover_confirmed: true,
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("refuses the same person twice, and points at the second row", () => {
    const parsed = internalRequestSchema.safeParse(
      leave({
        relievers: [
          { reliever_id: person(1), task_ids: [task(1)] },
          { reliever_id: person(1), task_ids: [task(2)] },
        ],
        turnover_confirmed: true,
      }),
    );
    expect(parsed.success).toBe(false);
    // The path is what puts the message on the offending control rather than at
    // the top of a list of three.
    expect(parsed.success === false && parsed.error.issues[0].path).toEqual([
      "relievers",
      1,
      "reliever_id",
    ]);
  });

  it("refuses one task given to two relievers", () => {
    // Two people covering the same task is nobody covering it, and the badge on
    // that task would have to name two.
    const parsed = internalRequestSchema.safeParse(
      leave({
        relievers: [
          { reliever_id: person(1), task_ids: [task(1)] },
          { reliever_id: person(2), task_ids: [task(1)] },
        ],
        turnover_confirmed: true,
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("lets the same reliever hold several tasks", () => {
    // The duplicate check is across ROWS, not within one. A reliever taking
    // four tasks is the ordinary case and must not read as a duplicate.
    const parsed = internalRequestSchema.safeParse(
      leave({
        relievers: [{ reliever_id: person(1), task_ids: [task(1), task(2), task(3)] }],
        turnover_confirmed: true,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses a hand-over that was never confirmed", () => {
    const parsed = internalRequestSchema.safeParse({ ...ok, turnover_confirmed: false });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0].path).toEqual([
      "turnover_confirmed",
    ]);
  });

  it("keeps the P7-16 half-day rule working alongside the new ones", () => {
    // The reliever fields went into the base object BEFORE the two existing
    // `.refine()`s, because `leaveRequestSchema` is a ZodEffects and `.extend()`
    // does not exist on one. Getting that wrong compiles and silently drops the
    // half-day and date-order checks.
    const parsed = internalRequestSchema.safeParse(
      leave({
        start_date: "2026-10-05",
        end_date: "2026-10-05",
        start_half: "AFTERNOON",
        end_half: "MORNING",
        relievers: [{ reliever_id: person(1), task_ids: [task(1)] }],
        turnover_confirmed: true,
      }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe("the attestation", () => {
  it("says what the person is actually confirming", () => {
    // Pinned verbatim because `turnover_confirmed_at` records WHEN somebody
    // agreed to this sentence and nothing in the database records WHICH
    // sentence. Editing it silently changes what past rows attest to.
    expect(TURNOVER_CONFIRMATION_TEXT).toBe(
      "I confirm that all major and critical tasks have been listed above and each has " +
        "been assigned a corresponding reliever for the duration of my leave.",
    );
  });
});

describe("the approval stage", () => {
  it("treats zero as no chain rather than as the first step", () => {
    expect(isChained(0)).toBe(false);
    expect(isChained(null)).toBe(false);
    expect(isChained(undefined)).toBe(false);
    expect(isChained(1)).toBe(true);
    expect(isChained(2)).toBe(true);
  });

  it("tells the requester who they are actually waiting on", () => {
    // The bug this replaces: every screen said "waiting on your department
    // lead", which sends somebody with three relievers to chase the wrong
    // person entirely.
    expect(APPROVAL_STAGE_LABELS[1]).toBe("Waiting on the relievers");
    expect(APPROVAL_STAGE_LABELS[3]).toBe("Waiting on a manager");
    // Stage 0 and stage 2 are both a team leader, in different worlds — the
    // unchained path and the second gate. They read the same on purpose.
    expect(APPROVAL_STAGE_LABELS[0]).toBe(APPROVAL_STAGE_LABELS[2]);
  });
});

/**
 * P9-07 — THE TURN-OVER CONFIRMATION IS REQUIRED, IN EVERY LAYER THAT CAN SAY SO.
 *
 * "(Required)" on a label is a claim, not a rule. Three layers enforce it and
 * this describes all three, because two of them cannot be reached from here:
 *
 *   1. zod, below — refuses a hand-over with the box unticked, on submit.
 *   2. `vizserve_pms_submit_internal_request` — raises 'Confirm the turn-over
 *      before submitting.' when the leave type requires a reliever. Covered by
 *      `tests/db/relievers.test.ts`.
 *   3. `vizserve_pms_check_turnover`, a DEFERRED CONSTRAINT TRIGGER — the rule
 *      that survives a second write path. Deferred because the reliever rows
 *      are inserted after the request they belong to; INSERT-only because
 *      legacy VACATION rows predate the concept and must stay decidable.
 *
 * Layer 1 is what somebody filling the form actually hits. The other two exist
 * because CLAUDE.md says the front end will be bypassed.
 */
describe("the turn-over confirmation is a gate, not a label", () => {
  const withReliever = (over: Record<string, unknown> = {}) =>
    leave({
      relievers: [{ reliever_id: person(1), task_ids: [task(1)] }],
      turnover_confirmed: true,
      ...over,
    });

  it("refuses a hand-over submitted with the box unticked", () => {
    const parsed = internalRequestSchema.safeParse(withReliever({ turnover_confirmed: false }));

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]).toMatchObject({
      path: ["turnover_confirmed"],
      message: "Confirm the turn-over before submitting.",
    });
  });

  it("refuses it however many relievers are named", () => {
    const parsed = internalRequestSchema.safeParse(
      leave({
        relievers: [1, 2, 3].map((n) => ({ reliever_id: person(n), task_ids: [task(n)] })),
        turnover_confirmed: false,
      }),
    );
    expect(parsed.success).toBe(false);
  });

  it("defaults to FALSE, so a payload that omits it is refused rather than assumed", () => {
    // ⚠️ The trap this pins. `z.boolean().optional()` would make a missing key
    // `undefined`, and `!undefined` is true — but the submit action forwards
    // the parsed value straight to `p_turnover_confirmed`, where SQL NULL
    // `coalesce`s to false. Both refuse today. A later `.default(true)`, or
    // reading the raw input instead of the parsed value, would quietly let an
    // unattested hand-over through.
    const parsed = internalRequestSchema.safeParse({
      ...withReliever(),
      turnover_confirmed: undefined,
    });
    expect(parsed.success).toBe(false);
  });

  it("does not demand it on leave that names nobody", () => {
    // Sick leave, birthday leave: no hand-over, nothing to attest to. Whether
    // THIS type needed a reliever at all is a fact about a row in
    // `vizserve_pms_leave_types`, which no zod schema can read — that half is
    // the submit function's, and it raises before this ever matters.
    expect(internalRequestSchema.safeParse(leave()).success).toBe(true);
  });

  it("refuses a reliever named with no tasks, rather than dropping the row", () => {
    /*
     * ⚠️ THE SILENT-LOSS BUG. The dialog used to build its payload with
     * `.filter((row) => row.relieverId && row.taskIds.length > 0)`, which
     * discarded a colleague chosen with no tasks WITHOUT A WORD — so somebody
     * could name a person, tick the confirmation, submit, and be told it was
     * filed while that person held nothing. It is `||` now, so the row survives
     * to be refused here.
     */
    const parsed = internalRequestSchema.safeParse(
      leave({
        relievers: [{ reliever_id: person(1), task_ids: [] }],
        turnover_confirmed: true,
      }),
    );

    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0].message).toBe(
      "Give every reliever at least one task.",
    );
  });
});
