import { z } from "zod";

import type { VizservePmsRequestStatus } from "@/lib/database.types";
import { APPROVAL_DECISIONS } from "@/lib/schemas/approvals";
import { taskStatusSchema } from "@/lib/schemas/tasks";

/**
 * P12-18 CONTRACT — what `/requests` and `/requests/[id]` read, once the reads
 * are the browser's.
 *
 * The D3a handoff artefact for client Gate 1, and a sibling of
 * `lib/schemas/task-list.ts`. Read that file's header for the general argument:
 * moving a read into the browser does NOT move the generated `Database` types
 * with it, so a column renamed or dropped from a `.select()` string arrives as
 * `undefined` with no type error anywhere.
 *
 * ⚠️ THIS IS THE ONE SURFACE WHERE THAT WOULD BE WORST. `/requests/[id]` is
 * where a Team Leader commits somebody to a date for a client, and every field
 * on it is a fact about an agreement with a person outside the company: what
 * they asked for, what was promised back, who signed it and when. A silently
 * undefined `target_date` renders as an em dash, which reads as "the client gave
 * no date" — a statement about the request rather than a gap in this deploy.
 *
 * ⚠️ REQUESTS AND INTERNAL APPROVALS KEEP SEPARATE CONTRACTS, as they keep
 * separate key prefixes and separate tables. They look mergeable — both are "a
 * form that gets approved" — and they are not: internal types are a fixed list
 * behind auth, client requests are user-built forms submitted with no session at
 * all. Different auth models, different lifecycles. Explicitly decided (CLAUDE.md);
 * do not unify them behind a flag, and do not start by sharing a schema file.
 */

/**
 * The lifecycle.
 *
 * ⚠️ THE DRIFT IS A TYPECHECK FAILURE, NOT A RUNTIME ONE, and both halves of
 * that are needed. `status-badge.tsx` keys its pill off a label MAP rather than
 * a list, so there is no array to import — and a hand-written copy of a Postgres
 * enum is exactly what CLAUDE.md warns produces a security-shaped bug rather
 * than a type error (see `ROLE_ORDER`). So:
 *
 *   * `satisfies` catches a value that is NOT in the enum.
 *   * `_Exhaustive` catches a value that is MISSING from this list — which is
 *     the direction that matters, because a status added by a migration and
 *     forgotten here would make every request in it fail to parse, and a whole
 *     queue would report itself as "a shape this build does not recognise".
 */
export const REQUEST_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "PENDING_REVIEW",
  "APPROVED",
  "RETURNED",
  "REJECTED",
] as const satisfies readonly VizservePmsRequestStatus[];

/* eslint-disable-next-line @typescript-eslint/no-unused-vars --
   Exported nowhere and read by nobody ON PURPOSE: its whole job is to fail to
   compile. Exporting it to silence the lint rule would invite an import, and an
   imported assertion is a value somebody can start passing around. */
type _RequestStatusesAreExhaustive =
  Exclude<VizservePmsRequestStatus, (typeof REQUEST_STATUSES)[number]> extends never
    ? true
    : ["a request status is missing from REQUEST_STATUSES"];

export const requestStatusSchema = z.enum(REQUEST_STATUSES);

/**
 * One row of the `/requests` queue.
 *
 * ⚠️ A DIFFERENT ROW SET FROM `pendingRequestRowSchema` IN `task-list.ts`, AND
 * DELIBERATELY SO. That one is the Gate 1 queue as the TASK VIEWS show it —
 * `status = PENDING_REVIEW`, five columns, filed under
 * `qk.pendingRequests(...)`. This is the whole queue with every status and the
 * SLA clock, filed under `qk.requests(...)`. Two row sets under one key would be
 * whichever-ran-last-wins, silently; the shared `["requests"]` PREFIX is what
 * makes a Gate 1 decision move both.
 */
export const requestListRowSchema = z.object({
  id: z.uuid(),
  reference_no: z.string(),
  title: z.string(),
  requester_name: z.string(),
  requester_org: z.string(),
  /** What the CLIENT asked for. Null when they gave no date. */
  target_date: z.string().nullable(),
  /** What the lead COMMITTED TO at Gate 1. Null until there is a decision. */
  approved_target_date: z.string().nullable(),
  /** P7-66. When the Gate 1 clock started. Null on a request never submitted. */
  sla_started_at: z.string().nullable(),
  reviewed_by: z.uuid().nullable(),
  status: requestStatusSchema,
  submitted_at: z.string(),
  form_id: z.uuid(),
});

export type RequestListRow = z.infer<typeof requestListRowSchema>;

/**
 * A client form, as the filter dropdown and the SLA column need it.
 *
 * `sla_minutes` feeds the SLA column: how long this form promises a decision in.
 * Without it the request's `sla_started_at` is a clock with no target.
 */
export const requestFormSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sla_minutes: z.number().int(),
});

export type RequestForm = z.infer<typeof requestFormSchema>;

/**
 * The request itself, on its detail page.
 *
 * ⚠️ THIS IS THE SUPERSET `fetchTaskRequest` WARNED WAS COMING, and widening it
 * is P12-18's first act. `qk.request(id)` has been written by `/tasks/[id]`
 * since P12-06 with eleven columns — the lead's view of the request behind a
 * task — and its own comment says in as many words: "Phase 4 moves
 * `/requests/[id]` onto this key with a far wider column set; whichever writes
 * last wins the entry. Widen this one then." So there is ONE shape and ONE
 * fetcher, and the task page reads the fields it needs out of it.
 *
 * ⚠️ THE FOUR REQUESTER FIELDS ARE NOT NULLABLE. The public form requires them,
 * so a null arriving here is a shape fault worth hearing about rather than a
 * value to paper over — the same posture the narrower version took.
 */
export const requestDetailSchema = z.object({
  id: z.uuid(),
  reference_no: z.string(),
  title: z.string(),
  description: z.string(),
  requester_name: z.string(),
  requester_email: z.string(),
  requester_org: z.string(),
  target_date: z.string().nullable(),
  approved_target_date: z.string().nullable(),
  /** The public form's answers, keyed by `field_key` (D20). */
  field_values: z.record(z.string(), z.unknown()).nullable(),
  status: requestStatusSchema,
  /** Rich text since P7-56. Sanitised at RENDER — see `lib/rich-text-dom.ts`. */
  decision_reason: z.string().nullable(),
  submitted_at: z.string(),
  sla_started_at: z.string().nullable(),
  reviewed_by: z.uuid().nullable(),
  reviewed_at: z.string().nullable(),
  form_id: z.uuid(),
});

export type RequestDetail = z.infer<typeof requestDetailSchema>;

/**
 * The form a request came through, plus where its work lands.
 *
 * `department_id` is the form's, NOT the viewer's, and the distinction is load
 * bearing twice over: a list created during the review has to belong where the
 * task will (P7-23), and the capacity scan is over that department's people.
 */
export const requestFormDetailSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  sla_minutes: z.number().int(),
  department_id: z.uuid(),
  default_list_id: z.uuid().nullable(),
});

export type RequestFormDetail = z.infer<typeof requestFormDetailSchema>;

/**
 * One field of the form this request was submitted through.
 *
 * ⚠️ ARCHIVED FIELDS ARE INCLUDED AND `is_active` RIDES ALONG AS A COLUMN. A
 * historical answer must keep rendering with its label even after the field is
 * retired from the live form (D20/R5) — `field_values` is keyed to `field_key`,
 * which is immutable once a form has submissions, and a field filtered out here
 * would turn somebody's answer into an orphaned value with no heading.
 */
export const requestFormFieldSchema = z.object({
  field_key: z.string(),
  label: z.string(),
  field_type: z.string(),
  is_active: z.boolean(),
});

export type RequestFormField = z.infer<typeof requestFormFieldSchema>;

/** An uploaded file. `field_key` is null for the generic attachment slot. */
export const requestAttachmentSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  field_key: z.string().nullable(),
});

export type RequestAttachment = z.infer<typeof requestAttachmentSchema>;

/**
 * One signature on this request, from the generic P2-00 approvals table.
 *
 * `approver_id` is nullable because the engine allows a system decision; the
 * page renders the name only when one resolves, which is also what happens for
 * a reader the users policy does not admit.
 */
export const requestDecisionSchema = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  /** The CLIENT's or the lead's words. Rich text; sanitised at render. */
  reason: z.string().nullable(),
  created_at: z.string(),
  approver_id: z.uuid().nullable(),
});

export type RequestDecision = z.infer<typeof requestDecisionSchema>;

/**
 * P7-59 — the task this request became.
 *
 * Only ever read once a decision exists: a pending request has no task by
 * definition, and a returned or rejected one never gets one.
 */
export const requestLinkedTaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  status: taskStatusSchema,
  assignee_id: z.uuid().nullable(),
  qa_assignee_id: z.uuid().nullable(),
});

export type RequestLinkedTask = z.infer<typeof requestLinkedTaskSchema>;

/** A department member who could be PIC, with the role the picker shows. */
export const reviewCandidateSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  role: z.string(),
});

export type ReviewCandidate = z.infer<typeof reviewCandidateSchema>;

/** P2-06 — a list the approved task could land in. */
export const reviewListSchema = z.object({
  id: z.uuid(),
  name: z.string(),
});

export type ReviewList = z.infer<typeof reviewListSchema>;
