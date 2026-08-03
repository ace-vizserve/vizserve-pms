import { z } from "zod";

/**
 * PHASE 2 CONTRACT — the decision payload (D3a, R11).
 *
 * Agreed before either track writes code. Kurt's review screen builds against
 * it; Ace's server actions parse with it; the Postgres functions re-check
 * everything anyway.
 *
 * Note the shape: `approve` carries assignment and dates, `return` and `reject`
 * carry only a reason. They are a DISCRIMINATED UNION rather than one object
 * with optional fields, because "reason is required unless the decision is
 * approve" expressed as an optional string is a rule nobody can see. Here it is
 * unrepresentable to reject without one.
 */

export const APPROVAL_DECISIONS = ["approved", "returned", "rejected"] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

/**
 * A reason people can act on.
 *
 * The floor is 10 characters, not 1. A required field that accepts "." is a
 * required field in name only, and the whole point of P2-08 is that the reason
 * reaches a client who has no other channel. Amier's framing at 37:00 is that
 * negotiation is the primary path — a returned request with the reason "no" is
 * not a negotiation.
 */
export const decisionReasonSchema = z
  .string()
  .trim()
  .min(10, "Give the requester something they can act on — at least a sentence.")
  .max(2000, "Keep it under 2000 characters.");

export const approveDecisionSchema = z.object({
  decision: z.literal("approved"),
  assignee_id: z.uuid("Choose who will do the work."),
  /**
   * Nullable, defaulting to the approving TL on the client. Overridable to any
   * member of the department (Amier 41:30) — so it is optional here rather than
   * required, and the "who is QA by default" decision lives in the UI where it
   * can be seen.
   */
  qa_assignee_id: z.uuid().nullable().default(null),
  /**
   * The NEGOTIATED date. Null means "as requested".
   *
   * The request's own `target_date` is never overwritten. Both survive, and the
   * delta between them is the only measurable evidence that this gate does
   * anything (P2-03).
   */
  approved_target_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")
    .nullable()
    .default(null),
  /** Typo corrections made while approving. Null means unchanged. */
  title: z.string().trim().min(1).max(300).nullable().default(null),
  description: z.string().trim().min(1).nullable().default(null),
});

export const returnDecisionSchema = z.object({
  decision: z.literal("returned"),
  reason: decisionReasonSchema,
});

export const rejectDecisionSchema = z.object({
  decision: z.literal("rejected"),
  reason: decisionReasonSchema,
});

export const decisionPayloadSchema = z.discriminatedUnion("decision", [
  approveDecisionSchema,
  returnDecisionSchema,
  rejectDecisionSchema,
]);

export type DecisionPayload = z.infer<typeof decisionPayloadSchema>;
export type ApproveDecision = z.infer<typeof approveDecisionSchema>;

/**
 * One candidate assignee's load, as the capacity panel renders it (P2-02).
 *
 * `due_before` is the number that actually answers the Team Leader's question.
 * "9 open" is context; "3 of them are already due before the date this client is
 * asking for" is a decision.
 */
export const capacityRowSchema = z.object({
  user_id: z.uuid(),
  full_name: z.string(),
  role: z.string(),
  open_count: z.number().int(),
  due_before: z.number().int(),
  overdue_count: z.number().int(),
  next_due_dates: z.array(z.string()).default([]),
});

export type CapacityRow = z.infer<typeof capacityRowSchema>;

export const approveResultSchema = z.object({
  ok: z.literal(true),
  task_id: z.uuid(),
  reference_no: z.string(),
  approved_target_date: z.string().nullable(),
});

export const decideResultSchema = z.object({
  ok: z.literal(true),
  status: z.enum(["RETURNED", "REJECTED"]),
  reference_no: z.string(),
  requester_email: z.string(),
  requester_name: z.string(),
  title: z.string(),
});
