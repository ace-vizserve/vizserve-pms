import { z } from "zod";

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
  "REIMBURSEMENT",
] as const;

export type InternalRequestType = (typeof INTERNAL_REQUEST_TYPES)[number];

export const INTERNAL_REQUEST_LABELS: Record<InternalRequestType, string> = {
  LEAVE: "Leave",
  NO_TIME_IN: "No time-in",
  NO_TIME_OUT: "No time-out",
  REIMBURSEMENT: "Reimbursement",
};

export const INTERNAL_REQUEST_BLURBS: Record<InternalRequestType, string> = {
  LEAVE:
    "Time off. HR still counts balances by hand — this is the record, not an entitlement check.",
  NO_TIME_IN:
    "You worked but no time-in was captured. Approval writes the corrected time into your DTR.",
  NO_TIME_OUT: "You forgot to time out, or the shift ran past the 18-hour cut-off.",
  REIMBURSEMENT: "Money you spent on the company's behalf.",
};

/**
 * Why you are asking.
 *
 * Floor of 5 rather than the client-facing 10 in `approvals.ts`: the approver
 * here already knows the requester and their week, so "Sick" is genuinely
 * enough context. The floor exists to block "." and an empty submit, not to
 * demand an essay from someone with flu.
 */
export const internalReasonSchema = z
  .string()
  .trim()
  .min(5, "Say why, even briefly.")
  .max(2000, "Keep it under 2000 characters.");

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");

/** `HH:MM`, 24-hour. Matches the Postgres `time` the submit function takes. */
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a 24-hour time, like 08:30.");

export const leaveRequestSchema = z
  .object({
    request_type: z.literal("LEAVE"),
    reason: internalReasonSchema,
    start_date: dateOnly,
    end_date: dateOnly,
  })
  // Checked here so the user sees it on the field, and again as a CHECK
  // constraint in the migration so a direct API call cannot dodge it.
  .refine((value) => value.end_date >= value.start_date, {
    message: "The last day cannot be before the first.",
    path: ["end_date"],
  });

/**
 * The DTR correction pair. These two exist because P5-02 makes a punch
 * unoverwritable on purpose — this is the only way back, and it needs somebody
 * else's signature.
 */
export const timeCorrectionSchema = z.object({
  request_type: z.enum(["NO_TIME_IN", "NO_TIME_OUT"]),
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

export const internalRequestSchema = z.discriminatedUnion("request_type", [
  leaveRequestSchema,
  timeCorrectionSchema,
  reimbursementSchema,
]);

export type InternalRequestInput = z.infer<typeof internalRequestSchema>;

/**
 * The decision payload. Approve carries nothing; reject requires a reason.
 *
 * No `returned` member — P5-08 specifies approve or reject only. The engine
 * still supports returning; this consumer simply never asks for it.
 */
export const internalDecisionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("approved"), reason: z.string().trim().max(2000).optional() }),
  z.object({
    decision: z.literal("rejected"),
    reason: z
      .string()
      .trim()
      .min(5, "Tell them why — a rejection with no reason is unactionable.")
      .max(2000, "Keep it under 2000 characters."),
  }),
]);

export type InternalDecisionInput = z.infer<typeof internalDecisionSchema>;
