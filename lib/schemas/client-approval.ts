import { z } from "zod";

/**
 * PHASE 4 CONTRACT — the token payload and the client decision (D3a, R11).
 *
 * The token itself never appears in a schema, and that is the point: it lives in
 * the URL, is hashed the moment it reaches Postgres, and is never stored,
 * logged, or returned to a browser. There is nothing here to validate it
 * against, because validation is a hash comparison in the database.
 */

export const CLIENT_DECISIONS = ["APPROVED", "REVISION_REQUESTED"] as const;
export type ClientDecision = (typeof CLIENT_DECISIONS)[number];

/**
 * What the public approval page renders.
 *
 * Everything here is safe for an unauthenticated reader. Note what is absent:
 * no department, no PIC name, no internal ids beyond the task. A public endpoint
 * that leaks the org chart is a small thing that compounds.
 */
export const approvalPageSchema = z.object({
  ok: z.literal(true),
  purpose: z.enum(["approval", "feedback"]),
  /** A used token still renders, showing what was decided. */
  consumed: z.boolean(),
  task_id: z.uuid(),
  status: z.string(),
  reference_no: z.string().nullable(),
  title: z.string(),
  requester_name: z.string().nullable(),
  submitted_at: z.string().nullable(),
  agreed_date: z.string().nullable(),
  resolution: z.string().nullable(),
  output_link: z.string().nullable(),
  auto_complete_at: z.string().nullable(),
  field_values: z.record(z.string(), z.unknown()).default({}),
  fields: z.array(z.object({ field_key: z.string(), label: z.string() })).default([]),
  attachments: z
    .array(z.object({ id: z.uuid(), filename: z.string(), size_bytes: z.number() }))
    .default([]),
});

export type ApprovalPage = z.infer<typeof approvalPageSchema>;

/**
 * Every failure is one of these, and the page says the same kind of thing for
 * `invalid` and `expired` — distinguishing them tells an enumerator which
 * guesses were close.
 */
export const approvalErrorSchema = z.object({
  ok: z.literal(false),
  error: z.enum([
    "invalid",
    "expired",
    "already_used",
    "no_longer_open",
    "comment_required",
    "invalid_rating",
  ]),
});

export const approvalPageResultSchema = z.union([approvalPageSchema, approvalErrorSchema]);

/**
 * The decision the client submits.
 *
 * A discriminated union again, so "a comment is required unless you are
 * approving" is unrepresentable rather than merely validated. The database
 * enforces it a second time, in a CHECK constraint.
 */
const approverNameSchema = z
  .string()
  .trim()
  .max(120)
  .optional()
  .transform((value) => value || undefined);

export const clientApproveSchema = z.object({
  decision: z.literal("APPROVED"),
  /** Optional praise. Nothing depends on it. */
  comment: z.string().trim().max(2000).optional(),
  // Q7 option (c): weak as security, decent as accountability, near-zero
  // friction. Recorded alongside the IP for the dispute this will eventually
  // cause.
  approver_name: approverNameSchema,
});

export const clientRevisionSchema = z.object({
  decision: z.literal("REVISION_REQUESTED"),
  comment: z
    .string()
    .trim()
    .min(10, "Tell us what needs changing — the team works from this directly."),
  approver_name: approverNameSchema,
});

export const clientDecisionSchema = z.discriminatedUnion("decision", [
  clientApproveSchema,
  clientRevisionSchema,
]);

export type ClientDecisionInput = z.infer<typeof clientDecisionSchema>;

export const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).optional(),
});

export type FeedbackInput = z.infer<typeof feedbackSchema>;

/** How each rating reads. Never a bare number — 3 out of what? */
export const RATING_LABELS: Record<number, string> = {
  1: "Poor",
  2: "Below expectations",
  3: "Fine",
  4: "Good",
  5: "Excellent",
};
