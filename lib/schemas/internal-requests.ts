import { z } from "zod";

import { richTextSchema } from "@/lib/schemas/rich-text";

/**
 * PHASE 5 CONTRACT — the four internal request types (D3a, R11).
 *
 * A DISCRIMINATED UNION on `request_type`, for the same reason the Phase 2
 * decision payload is one: "start_date is required, but only for leave" written
 * as four optional fields is a rule nobody can see and everybody forgets. Here a
 * reimbursement carrying a start date does not typecheck, and the matching CHECK
 * constraint in the migration says the same thing to a caller who skips this
 * layer entirely.
 *
 * LEAVE BALANCES ARE NOT MODELLED, deliberately and permanently until someone
 * decides otherwise. Amier, 22:40: HR counts manually for now — "ang mahalaga
 * lang, may record". Accrual, carry-over and entitlement are a project of their
 * own, and this file is where that scope would first try to creep in.
 */

export const INTERNAL_REQUEST_TYPES = [
  "LEAVE",
  "NO_TIME_IN",
  "NO_TIME_OUT",
  "TIME_IN_CORRECTION",
  "TIME_OUT_CORRECTION",
  "REIMBURSEMENT",
  "OVERTIME",
] as const;

export type InternalRequestType = (typeof INTERNAL_REQUEST_TYPES)[number];

/**
 * P7-39 RELABELLED THE ORIGINAL PAIR. "No time-in" was unambiguous while it was
 * the only kind of time correction; next to "Time-in correction" it reads as a
 * near-synonym. "Missing" versus "correction" is the distinction that actually
 * matters to the person approving: one fills a blank, the other overwrites a
 * recorded time with a claim that contradicts it.
 *
 * The enum values are untouched — this is display only.
 */
export const INTERNAL_REQUEST_LABELS: Record<InternalRequestType, string> = {
  LEAVE: "Leave",
  NO_TIME_IN: "Missing time-in",
  NO_TIME_OUT: "Missing time-out",
  TIME_IN_CORRECTION: "Time-in correction",
  TIME_OUT_CORRECTION: "Time-out correction",
  REIMBURSEMENT: "Reimbursement",
  OVERTIME: "Overtime",
};

/**
 * The label, or a readable fallback for a type this build has not heard of.
 *
 * ⚠️ THE MAP ABOVE IS COMPLETE TODAY AND THAT IS NOT THE POINT. P7-38 added
 * `TIME_IN_CORRECTION` and `TIME_OUT_CORRECTION` properly — enum, migration and
 * labels together — which is exactly the right fix. This exists because of how
 * the gap arose in the first place:
 *
 * `TIME_IN_CORRECTION` was live in the database for a day BEFORE the migration
 * that declares it reached this repo, because P7 enum values are pasted into
 * the Supabase SQL editor by hand. During that day the type badge rendered an
 * EMPTY PILL — a request whose kind was invisible on the one screen built to
 * show it, and nothing anywhere said why.
 *
 * That ordering is not going to change, so the next hand-applied enum value
 * will do the same thing. A humanised fallback is worse than a real label and
 * far better than a blank, and it is visibly wrong enough to get fixed.
 */
export function internalRequestLabel(type: string): string {
  return (
    INTERNAL_REQUEST_LABELS[type as InternalRequestType] ??
    // TIME_IN_CORRECTION -> "Time in correction". Sentence case, matching the
    // map above closely enough that a stray one does not look like a bug.
    type.charAt(0).toUpperCase() + type.slice(1).toLowerCase().replaceAll("_", " ")
  );
}

export const INTERNAL_REQUEST_BLURBS: Record<InternalRequestType, string> = {
  LEAVE:
    "Time off. HR still counts balances by hand — this is the record, not an entitlement check.",
  NO_TIME_IN:
    "You worked but no time-in was captured. Approval writes the corrected time into your DTR.",
  NO_TIME_OUT: "You forgot to time out, or the shift ran past the 18-hour cut-off.",
  TIME_IN_CORRECTION:
    "A time-in was captured but it is wrong — usually you started work and clocked in later. Approval overwrites the recorded time.",
  TIME_OUT_CORRECTION:
    "A time-out was captured but it is wrong, in either direction. For extra hours you agreed in advance, file overtime instead.",
  REIMBURSEMENT: "Money you spent on the company's behalf.",
  OVERTIME:
    "Extra hours on a given day, agreed before you work them. Approval is what stops that day reading as over-logged on your timesheet.",
};

/**
 * The four types that resolve to a corrected instant on a DTR row. One list,
 * exported, because the dialog, the DTR table and the approvals detail all ask
 * "is this a time correction" and three copies would drift the moment a fifth
 * type arrives.
 */
export const TIME_CORRECTION_TYPES = [
  "NO_TIME_IN",
  "NO_TIME_OUT",
  "TIME_IN_CORRECTION",
  "TIME_OUT_CORRECTION",
] as const satisfies readonly InternalRequestType[];

export type TimeCorrectionType = (typeof TIME_CORRECTION_TYPES)[number];

export function isTimeCorrectionType(value: string): value is TimeCorrectionType {
  return (TIME_CORRECTION_TYPES as readonly string[]).includes(value);
}

/**
 * Why you are asking.
 *
 * Floor of 5 rather than the client-facing 10 in `approvals.ts`: the approver
 * here already knows the requester and their week, so "Sick" is genuinely
 * enough context. The floor exists to block "." and an empty submit, not to
 * demand an essay from someone with flu.
 */
/** Named so the dialogs and these schemas cannot drift apart. */
export const INTERNAL_REASON_MIN = 5;
export const INTERNAL_REASON_MAX = 2000;

export const internalReasonSchema = richTextSchema({
  min: INTERNAL_REASON_MIN,
  max: INTERNAL_REASON_MAX,
  requiredMessage: "Say why, even briefly.",
  tooLongMessage: "Keep it under 2000 characters.",
});

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");

/** `HH:MM`, 24-hour. Matches the Postgres `time` the submit function takes. */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time, like 08:30.");

/**
 * P7-16 — which half of a day leave begins and ends in.
 *
 * DECLARED MORNING FIRST, and the order is load-bearing in the same way
 * `TASK_PRIORITIES` is: the Postgres enum compares by declaration order, so the
 * single-day rule is `start_half <= end_half` with no CASE on either side.
 * Reversing this list silently inverts that rule.
 */
export const DAY_HALVES = ["MORNING", "AFTERNOON"] as const;

export type DayHalf = (typeof DAY_HALVES)[number];

export const dayHalfSchema = z.enum(DAY_HALVES);

/**
 * What each half MEANS, which is not symmetrical and is the part people get
 * wrong. On the first day, MORNING means the whole day and AFTERNOON means half
 * of it. On the last day it is the other way round.
 */
export const DAY_HALF_LABELS: Record<DayHalf, string> = {
  MORNING: "Morning",
  AFTERNOON: "Afternoon",
};

/**
 * P9-01 — THE APPROVAL STAGE, which is the whole chain.
 *
 * `vizserve_pms_internal_requests.approval_stage` is a smallint and these are
 * its four values. Zero is not "the beginning" — it is "there is no chain", and
 * every non-leave request carries it for ever.
 *
 *   0  decided once, by any lead of the department. Overtime, reimbursement,
 *      the four corrections, and every request filed before P9-01.
 *   1  waiting on the relievers. All of them, individually.
 *   2  waiting on a team leader of the department.
 *   3  waiting on a manager, company-wide.
 *
 * Leave opens at 1 or at 2 depending on its type and takes the same path from
 * there — reliever leave is not a second workflow, it is this one started a
 * stage earlier.
 */
export const APPROVAL_STAGES = [0, 1, 2, 3] as const;

export type ApprovalStage = (typeof APPROVAL_STAGES)[number];

/** What the request is waiting on. Shown to everybody, including the requester. */
export const APPROVAL_STAGE_LABELS: Record<ApprovalStage, string> = {
  0: "Waiting on a team leader",
  1: "Waiting on the relievers",
  2: "Waiting on a team leader",
  3: "Waiting on a manager",
};

/** The short form, for the stepper on the request page. */
export const APPROVAL_STAGE_NAMES: Record<Exclude<ApprovalStage, 0>, string> = {
  1: "Relievers",
  2: "Team leader",
  3: "Manager",
};

export function isChained(stage: number | null | undefined): boolean {
  return (stage ?? 0) > 0;
}

/**
 * P9-01 — at most three.
 *
 * Amier's ceiling. Past three the turn-over is not a hand-over, it is a
 * redistribution, and it wants a conversation rather than a form. The submit
 * function enforces the same number.
 */
export const MAX_RELIEVERS = 3;

/**
 * The attestation, verbatim.
 *
 * ⚠️ EXPORTED AS A CONSTANT because it is a claim somebody makes, not a caption.
 * The checkbox renders this string, and `turnover_confirmed_at` records when
 * they agreed to it — so if the wording ever changes, rows written before the
 * change attest to the OLD sentence and nothing in the database says which. Do
 * not edit this line casually; if it has to change materially, version it.
 */
export const TURNOVER_CONFIRMATION_TEXT =
  "I confirm that all major and critical tasks have been listed above and each has " +
  "been assigned a corresponding reliever for the duration of my leave.";

/** One reliever and the tasks they are taking on. */
export const relieverAssignmentSchema = z.object({
  reliever_id: z.uuid("Choose a reliever."),
  /**
   * The requester's OWN tasks. The server re-checks every one of them against
   * `vizserve_pms_is_on_task` — being on a task through P7-13's assignee table
   * counts, being merely in the department does not — so this array is a
   * proposal, never an authority.
   */
  task_ids: z.array(z.uuid()).min(1, "Give every reliever at least one task."),
});

export type RelieverAssignment = z.infer<typeof relieverAssignmentSchema>;

export const leaveRequestSchema = z
  .object({
    request_type: z.literal("LEAVE"),
    reason: internalReasonSchema,
    start_date: dateOnly,
    end_date: dateOnly,
    /**
     * Defaulted to a WHOLE span — morning of the first day to the afternoon of
     * the last — because that is what "the 3rd to the 5th" has always meant and
     * every row written before P7-16 means exactly that. Somebody who never
     * touches these two controls gets the behaviour they had before.
     */
    start_half: dayHalfSchema.default("MORNING"),
    end_half: dayHalfSchema.default("AFTERNOON"),
    /**
     * P7-12. Required, and an id rather than a code: the list is admin-editable
     * data in `vizserve_pms_leave_types`, not an enum, so there is no closed set
     * to validate against here. The server checks it exists AND is still active
     * — a retired type stays valid on the rows that already reference it and
     * must not be selectable for a new one, which is a rule no zod schema can
     * express.
     */
    leave_type_id: z.uuid("Choose what kind of leave this is."),
    /**
     * P9-01. Empty for the leave types that need no cover, which is most of
     * them.
     *
     * ⚠️ WHETHER THIS IS *REQUIRED* IS NOT EXPRESSIBLE HERE, and deliberately so
     * — the answer lives in `vizserve_pms_leave_types.requires_reliever`, a row
     * this schema cannot read. So zod validates the SHAPE of what was sent and
     * `vizserve_pms_submit_internal_request` owns "was it needed at all". The
     * same split P7-12 made for "is this leave type still active", and for the
     * same reason: a rule about a row in another table is not a rule about this
     * payload.
     */
    relievers: z.array(relieverAssignmentSchema).default([]),
    turnover_confirmed: z.boolean().default(false),
  })
  // Checked here so the user sees it on the field, and again as a CHECK
  // constraint in the migration so a direct API call cannot dodge it.
  // A one-day request cannot start in the afternoon and end in the morning.
  // Across two days or more every combination is legal — afternoon-to-morning is
  // the ordinary "half a day either end" shape.
  .refine(
    (value) =>
      value.start_date !== value.end_date ||
      DAY_HALVES.indexOf(value.start_half) <= DAY_HALVES.indexOf(value.end_half),
    {
      message: "Leave on one day cannot start in the afternoon and end in the morning.",
      path: ["end_half"],
    },
  )
  .refine((value) => value.end_date >= value.start_date, {
    message: "The last day cannot be before the first.",
    path: ["end_date"],
  })
  /**
   * P9-01 — the reliever block's own rules.
   *
   * All four are restated in `vizserve_pms_submit_internal_request`, because
   * the front end will be bypassed. They live here as well so the person
   * filling the form is told which row is wrong rather than being handed one
   * sentence about a list of three.
   *
   * ⚠️ `superRefine` rather than more `.refine()`s: these need `path` to point
   * at a SPECIFIC ROW (`["relievers", 1, "reliever_id"]`), and `.refine` gives
   * one path for the whole check.
   */
  .superRefine((value, ctx) => {
    if (value.relievers.length > MAX_RELIEVERS) {
      ctx.addIssue({
        code: "custom",
        message: `Name at most ${MAX_RELIEVERS} relievers.`,
        path: ["relievers"],
      });
    }

    // The same person twice is not two approvals — the stage would be
    // impossible to complete honestly.
    const seenPerson = new Map<string, number>();
    // One task, one reliever. Two people "covering" the same task is nobody
    // covering it, and the badge on that task would have to name two.
    const seenTask = new Map<string, number>();

    value.relievers.forEach((row, index) => {
      const firstPerson = seenPerson.get(row.reliever_id);
      if (firstPerson === undefined) {
        seenPerson.set(row.reliever_id, index);
      } else {
        ctx.addIssue({
          code: "custom",
          message: "That person is already listed as a reliever.",
          path: ["relievers", index, "reliever_id"],
        });
      }

      row.task_ids.forEach((taskId) => {
        if (seenTask.has(taskId)) {
          ctx.addIssue({
            code: "custom",
            message: "Another reliever already has that task.",
            path: ["relievers", index, "task_ids"],
          });
        } else {
          seenTask.set(taskId, index);
        }
      });
    });

    // The tick is a GATE, not a formality: the reliever block is the requester
    // asserting that the critical work is listed and covered, and without it
    // the three people downstream are approving a claim nobody made.
    if (value.relievers.length > 0 && !value.turnover_confirmed) {
      ctx.addIssue({
        code: "custom",
        message: "Confirm the turn-over before submitting.",
        path: ["turnover_confirmed"],
      });
    }
  });

/**
 * The DTR corrections. All four exist because P5-02 makes a punch
 * unoverwritable on purpose — this is the only way back, and it needs somebody
 * else's signature.
 *
 * ONE SCHEMA FOR FOUR TYPES, unlike the migration's four separate CHECK
 * branches. The database keeps them apart because a branch covering several
 * types is how a payload rule goes missing (p7_04); here the payload genuinely
 * is one shape and a discriminated union of four identical members would be
 * four places to forget a field.
 */
export const timeCorrectionSchema = z.object({
  request_type: z.enum(TIME_CORRECTION_TYPES),
  reason: internalReasonSchema,
  work_date: dateOnly,
  correction_time: timeOfDay,
});

export const reimbursementSchema = z.object({
  request_type: z.literal("REIMBURSEMENT"),
  reason: internalReasonSchema,
  amount: z
    .number({ error: "Enter the amount." })
    .positive("The amount must be more than zero.")
    // A ceiling that no legitimate staff reimbursement reaches, so a stray
    // keypress fails here rather than in somebody's approval queue.
    .max(1_000_000, "That is too large for a reimbursement — raise it with finance directly."),
});

/**
 * P7-04 — overtime, approved per day.
 *
 * A day and a length, nothing else. It is deliberately not tied to a task: the
 * person asking usually does not yet know which task the extra hours will land
 * on, and a day's overage split across two tasks would otherwise need two
 * requests. The timesheet reads this by date.
 *
 * The 960-minute ceiling is arithmetic, not taste. The timesheet's day rule is
 * `8 hours + approved overtime`, and the database refuses more than 1440 minutes
 * against one day — so 480 + 960 is exactly the point where the advisory rule
 * would start contradicting the enforced one.
 */
export const MAX_OVERTIME_MINUTES = 960;

export const overtimeRequestSchema = z.object({
  request_type: z.literal("OVERTIME"),
  reason: internalReasonSchema,
  work_date: dateOnly,
  overtime_minutes: z
    .number({ error: "How much overtime?" })
    .int("Give it in whole minutes.")
    .min(1, "That has to be more than nothing.")
    .max(MAX_OVERTIME_MINUTES, "That is more than 16 hours of overtime on one day."),
});

export const internalRequestSchema = z.discriminatedUnion("request_type", [
  leaveRequestSchema,
  timeCorrectionSchema,
  reimbursementSchema,
  overtimeRequestSchema,
]);

export type InternalRequestInput = z.infer<typeof internalRequestSchema>;

/**
 * The same question as `isTimeCorrectionType`, asked of a whole payload so that
 * TypeScript NARROWS THE UNION rather than just the string.
 *
 * Both exist because they are used in different places: the type-level guard is
 * for a `request_type` read off a database row, where there is no union to
 * narrow; this one is for the submit action, where narrowing is the entire
 * reason `work_date` and `correction_time` can be read without a cast. A cast
 * there would be the thing that lets a fifth correction type through with a
 * null time.
 */
export function isTimeCorrectionRequest(
  value: InternalRequestInput,
): value is Extract<InternalRequestInput, { correction_time: string }> {
  return isTimeCorrectionType(value.request_type);
}

/**
 * The decision payload. Approve carries nothing; reject requires a reason.
 *
 * No `returned` member — P5-08 specifies approve or reject only. The engine
 * still supports returning; this consumer simply never asks for it.
 */
export const internalDecisionSchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approved"),
    reason: richTextSchema({ max: 2000 }).optional(),
  }),
  z.object({
    decision: z.literal("rejected"),
    reason: richTextSchema({
      min: INTERNAL_REASON_MIN,
      max: INTERNAL_REASON_MAX,
      requiredMessage: "Tell them why — a rejection with no reason is unactionable.",
      tooLongMessage: "Keep it under 2000 characters.",
    }),
  }),
]);

export type InternalDecisionInput = z.infer<typeof internalDecisionSchema>;

/**
 * P7-F — the two query parameters the DTR shortcut hands to `/approvals`.
 *
 * Someone looking at a gap in their own DTR should not have to leave the screen
 * showing the problem, open a dialog, choose the type and retype the date they
 * were just looking at. Every one of those steps is a chance to file the
 * correction against the wrong day. So the DTR row links here with the type and
 * the date already chosen.
 *
 * PREFILL IS A CONVENIENCE, NEVER AN AUTHORITY. Nothing narrowed here is
 * trusted server-side: `vizserve_pms_submit_internal_request` still resolves the
 * department from the caller's own row and still refuses a future correction.
 * This exists so a hand-edited URL opens the PLAIN dialog rather than erroring —
 * the same posture `/timesheet` already takes with `?week=banana`.
 *
 * Returns undefined per field rather than throwing, because a bad parameter is
 * not a failure state: it is a link somebody mangled, and the right response is
 * the dialog they were trying to reach.
 */
export function narrowRequestPrefill(params: {
  type?: string | string[] | null;
  date?: string | string[] | null;
  time?: string | string[] | null;
}): { type?: InternalRequestType; date?: string; time?: string } {
  // Next hands back `string[]` when a parameter appears twice. Taking the first
  // would silently honour `?type=LEAVE&type=OVERTIME`; a repeated parameter is
  // not a choice, so neither is honoured.
  const type = typeof params.type === "string" ? params.type : undefined;
  const date = typeof params.date === "string" ? params.date : undefined;
  const time = typeof params.time === "string" ? params.time : undefined;

  return {
    type: INTERNAL_REQUEST_TYPES.includes(type as InternalRequestType)
      ? (type as InternalRequestType)
      : undefined,
    // Shape only. A real date still has to survive the schema and the function
    // — `2026-02-31` matches this regex and is refused later, which is the
    // right place for it: this is a URL guard, not a calendar.
    date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
    /**
     * P7-40. The SCHEDULED time, so a correction opens saying what the record
     * should have said rather than an empty field.
     *
     * ⚠️ A SUGGESTION, NOT A CLAIM, and the dialog must keep it editable. The
     * whole point of the request is that a human is asserting when they actually
     * started; prefilling their scheduled start and letting them submit it
     * unread would turn an attestation into a rubber stamp, and the approver
     * would be signing off a number the system invented.
     */
    time: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : undefined,
  };
}

/**
 * A leave span in words — "3 Sep (afternoon) – 5 Sep (morning)".
 *
 * One function, because the dialog, the approvals list and the request detail
 * all have to say the same thing, and three copies of "when is this person
 * away" is three chances to disagree about a half day.
 *
 * The halves are only mentioned when they are NOT the whole-span default:
 * writing "(morning)" on the first day of every full-day request adds a word to
 * every row and distinguishes nothing.
 */
export function describeLeaveSpan(
  start: string,
  end: string,
  startHalf: DayHalf | null,
  endHalf: DayHalf | null,
  formatDay: (value: string) => string,
): string {
  const startsMidday = startHalf === "AFTERNOON";
  const endsMidday = endHalf === "MORNING";

  const from = `${formatDay(start)}${startsMidday ? " (afternoon)" : ""}`;
  const to = `${formatDay(end)}${endsMidday ? " (morning)" : ""}`;

  // A single day with both halves the same is "3 Sep (morning only)" rather than
  // "3 Sep (morning) – 3 Sep (morning)", which reads as a range of nothing.
  if (start === end) {
    if (startsMidday && endsMidday) return `${formatDay(start)} — that half day`;
    if (startsMidday) return `${formatDay(start)} (afternoon only)`;
    if (endsMidday) return `${formatDay(start)} (morning only)`;
    return formatDay(start);
  }

  return `${from} – ${to}`;
}

/**
 * P11-13 — the optional note on a withdrawal.
 *
 * ⚠️ NO FLOOR, AND THAT IS THE FEATURE. Every other free-text field in this file
 * has a five-character minimum because somebody is being asked to justify
 * something; this one is offered, never demanded. P9-03's rule — that
 * withdrawing owes nobody an explanation, precisely because only the author can
 * do it — is unchanged by giving them somewhere to put one.
 *
 * The cap is the same 2000 as everything else here, measured on the flattened
 * text rather than the markup (see `richTextSchema`).
 *
 * `.default("")` rather than `.optional()`: the dialog always renders the editor
 * and always sends its value, so "" is the shape that actually arrives when
 * somebody leaves it alone. The action turns that into a null.
 */
export const withdrawNoteSchema = z.object({
  note: richTextSchema({
    max: INTERNAL_REASON_MAX,
    tooLongMessage: "Keep it under 2000 characters.",
  }).default(""),
});

export type WithdrawNoteInput = z.infer<typeof withdrawNoteSchema>;
