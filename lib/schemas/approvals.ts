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
 * P7-63 — what a person reads, as opposed to what Postgres stores.
 *
 * The request detail page rendered the enum itself with `capitalize` on it,
 * which is the same class of bug as showing a status code: "returned" is a
 * column value, and "Returned for changes" is the thing that happened. Stated
 * here, beside the union, so a screen never restates it — the same arrangement
 * `TASK_STATUS_LABELS` has in `tasks.ts`.
 *
 * Exhaustive by construction: a `Record` keyed on the union stops compiling the
 * moment a fourth decision is added without a label to go with it.
 */
export const APPROVAL_DECISION_LABELS: Record<ApprovalDecision, string> = {
  approved: "Approved",
  // Not "Returned". The request went back to the requester with something to
  // act on, and the word people use for that is not the past tense of a verb
  // about direction.
  returned: "Returned for changes",
  rejected: "Rejected",
};

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
  /**
   * P2-06. Null means "use the form's default" — NOT "no list". Clearing is not
   * something the review screen offers, and treating an absent value as a
   * deletion is how a form's default silently stops applying.
   */
  list_id: z.uuid().nullable().default(null),
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

// ---------------------------------------------------------------------------
// P7-26 — a pending request, read where the WORK lives
// ---------------------------------------------------------------------------

/**
 * A client request still waiting on Gate 1, as the task views render it.
 *
 * WHY IT EXISTS. "The requested task of the client is basically a task" — and
 * it is: the submission carries a title, a description, a wanted date, the
 * client's answers and their files, and `vizserve_pms_approve_request` copies
 * all of it onto the task it creates. What did not follow was WHERE it was
 * visible. A pending request lived only on `/requests`, so the Client Requests
 * folder showed nothing until somebody approved. Work that had been asked for
 * was invisible in every view of the work.
 *
 * NOT a task and not becoming one. Creating the task at submission was the
 * alternative and it is worse: a rejected request would leave a task behind,
 * and every gate, report and count in the app would gain a stage meaning
 * "might not be real yet". The client drafts; the TL/TM commits.
 */
export type PendingRequest = {
  id: string;
  reference_no: string;
  title: string;
  requester_name: string;
  requester_org: string | null;
  target_date: string | null;
  submitted_at: string | null;
  /** The form's inbox list (P7-18) — where this request's task will land. */
  listId: string | null;
  formName: string;
};

/** The task-view filters, as far as a request can answer them. */
export type PendingRequestFilters = {
  /** `?kind=` — a request is client work by definition. */
  kind?: "all" | "client" | "internal";
  /** `?view=` — nobody is assigned yet, so `mine` and `qa` exclude these. */
  scope?: "all" | "mine" | "qa";
  /** `?status=` or `?priority=` — a request has neither column. */
  hasTaskOnlyFilter?: boolean;
};

/**
 * Do pending requests belong on this page at all, given its filters?
 *
 * THE RULE: a request has no status, no priority, no assignee and no QA
 * reviewer. Where the task view asks a question a request cannot answer, the
 * requests are DROPPED — never shown regardless.
 *
 * Showing them anyway is the "a control that claims a filter it does not apply"
 * trap the board's `kind` note already records, one table along: a page
 * filtered to `?status=FOR_QA` that still lists three requests is a page whose
 * filter is a suggestion. Dropping them is the only answer that keeps the count
 * at the top of the screen true.
 *
 * Pure, so it is testable without a database — the same shape as `scopeAllows`
 * in `lib/schemas/tasks.ts` and `dayState` in `lib/schemas/timesheet.ts`.
 */
export function pendingRequestsApply(filters: PendingRequestFilters = {}): boolean {
  const { kind = "all", scope = "all", hasTaskOnlyFilter = false } = filters;

  // Internal work explicitly excludes anything with a client behind it, and a
  // pending request is nothing but a client behind it.
  if (kind === "internal") return false;

  // "Mine" and "waiting on my QA" are seat questions. A request has no seats
  // filled — that is what approving it decides.
  if (scope === "mine" || scope === "qa") return false;

  // A status or priority filter is a question about a column requests do not
  // have. Any value at all hides them.
  if (hasTaskOnlyFilter) return false;

  return true;
}
