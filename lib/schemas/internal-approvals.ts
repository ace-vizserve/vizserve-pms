import { z } from "zod";

import type { Role } from "@/lib/auth/roles";
import type {
  VizservePmsGender,
  VizservePmsInternalRequestStatus,
} from "@/lib/database.types";
import { APPROVAL_DECISIONS } from "@/lib/schemas/approvals";
import { DAY_HALVES, INTERNAL_REQUEST_TYPES } from "@/lib/schemas/internal-requests";

/**
 * P12-19 CONTRACT — what `/approvals` and `/approvals/[id]` read, once the reads
 * are the browser's.
 *
 * The D3a handoff artefact for INTERNAL approvals, and a sibling of
 * `lib/schemas/task-list.ts`. Read that file's header for the general argument.
 *
 * ⚠️ SEPARATE FROM `lib/schemas/requests.ts`, AND THAT IS A SETTLED DECISION
 * RATHER THAN AN ACCIDENT OF WHO WROTE WHAT. Internal approvals and client
 * requests look mergeable — both are "a form that gets approved" — and they are
 * not: internal types are a FIXED LIST behind auth with a three-stage chain,
 * client requests are user-built forms submitted with no session at all and one
 * gate. Different tables, different auth models, different lifecycles (CLAUDE.md).
 * The key prefixes are separate for the same reason, and sharing a schema file
 * would be the first step towards unifying them behind a flag.
 *
 * ⚠️ ON THIS SURFACE THE UNDEFINED THAT MATTERS IS `approval_stage`. It decides
 * which of three people a request is waiting on, which stops the rail draws, and
 * whether the decision panel appears at all — `waitingOnMe` switches on it. A
 * shape fault that turned it into `undefined` would fall to the `?? 0` default
 * and hand every leave request to whichever lead opened it, one stage early. It
 * is a plain `number` in the database and stated as one here, so a null is a
 * sentence rather than a silent zero.
 */

/**
 * The type and status enums, mirrored from the modules that already own them.
 *
 * ⚠️ `INTERNAL_REQUEST_TYPES` AND `DAY_HALVES` ARE IMPORTED, NOT COPIED.
 * `lib/schemas/internal-requests.ts` holds them because the labels, the blurbs,
 * the submit schema and the type pill all read them; a second copy here would be
 * a second thing to update when a migration adds a type, and the failure would
 * arrive as somebody's whole approvals list refusing to parse.
 *
 * The STATUS list has no such home — it is only ever consumed as a pill — so it
 * is stated here against the generated union, with the same two-sided guard
 * `REQUEST_STATUSES` uses: `satisfies` catches an invalid value and
 * `_Exhaustive` catches a missing one.
 */
export const internalRequestTypeSchema = z.enum(INTERNAL_REQUEST_TYPES);

export const INTERNAL_STATUSES = [
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
] as const satisfies readonly VizservePmsInternalRequestStatus[];

/* eslint-disable-next-line @typescript-eslint/no-unused-vars --
   Exported nowhere and read by nobody ON PURPOSE: its whole job is to fail to
   compile. See the same pattern in `lib/schemas/requests.ts`. */
type _InternalStatusesAreExhaustive =
  Exclude<VizservePmsInternalRequestStatus, (typeof INTERNAL_STATUSES)[number]> extends never
    ? true
    : ["an internal request status is missing from INTERNAL_STATUSES"];

export const internalStatusSchema = z.enum(INTERNAL_STATUSES);

const dayHalfSchema = z.enum(DAY_HALVES);

/**
 * P7-46 — an ENUM rather than a table, so it is stated here against the
 * generated union with the same two-sided guard the statuses use above.
 */
const GENDERS = ["MALE", "FEMALE"] as const satisfies readonly VizservePmsGender[];

/* eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above. */
type _GendersAreExhaustive =
  Exclude<VizservePmsGender, (typeof GENDERS)[number]> extends never
    ? true
    : ["a gender is missing from GENDERS"];

/**
 * One internal request row, as both approvals surfaces select it.
 *
 * ⚠️ THE QUERY SELECTS `*` AND THIS IS THE FULL COLUMN LIST, which is unusual
 * here and deliberate. Every other fetcher in `lib/query/fetchers/` names its
 * columns; these two pages genuinely read almost all of them — `requestDetail()`
 * in `request-summary.tsx` switches on the type and reaches for `start_date`,
 * `end_date`, `amount`, `work_date`, `correction_at`, `overtime_minutes` and
 * both halves, and the detail page adds the chain, the withdrawal note and the
 * review stamps. Naming twenty columns in a string would be a list to keep in
 * step with this one for no narrowing worth having.
 *
 * ⚠️ WHICH MAKES THE PARSE THE ONLY THING STANDING BETWEEN `*` AND THE SCREEN.
 * A `select("*")` cannot fail to return a column that exists, but it also cannot
 * tell this build about one that has been RENAMED — and `requestDetail()`'s
 * non-null assertions on `start_date` / `end_date` would then render "Invalid
 * Date – Invalid Date" as somebody's leave span.
 */
export const internalRequestRowSchema = z.object({
  id: z.uuid(),
  request_type: internalRequestTypeSchema,
  requester_id: z.uuid(),
  department_id: z.uuid(),
  status: internalStatusSchema,
  /** Rich text since P7-56. Sanitised at RENDER — see `lib/rich-text-dom.ts`. */
  reason: z.string(),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  work_date: z.string().nullable(),
  correction_at: z.string().nullable(),
  amount: z.number().nullable(),
  /** P7-04. Set only on OVERTIME rows; capped at 960 by a CHECK. */
  overtime_minutes: z.number().int().nullable(),
  /**
   * P7-12. Required on LEAVE and forbidden on every other type. Nullable here
   * despite being required, because LEAVE rows filed before the list existed
   * have none — the constraint is NOT VALID for exactly that reason.
   */
  leave_type_id: z.uuid().nullable(),
  /** P7-16. LEAVE only, and null on every row written before it. */
  start_half: dayHalfSchema.nullable(),
  end_half: dayHalfSchema.nullable(),
  /**
   * P9-01 — THE APPROVAL CHAIN, as one number.
   *
   * 0 = no chain (every non-LEAVE type, decided once by any lead, and every row
   * filed before P9-01). 1 = relievers, 2 = team leader, 3 = manager.
   *
   * ⚠️ A REQUEST IS NOT FINISHED WHEN A LEAD APPROVES IT. Anything reading
   * `status` alone to mean "decided" was right until P9-04 and is wrong now.
   * `waitingOnMe` switches on THIS, which is why it is not optional above.
   */
  approval_stage: z.number().int(),
  /** P9-01. When the requester ticked the turn-over confirmation. */
  turnover_confirmed_at: z.string().nullable(),
  decision_reason: z.string().nullable(),
  /**
   * P11-13. Optional rich text from the REQUESTER saying why they took the
   * request back.
   *
   * ⚠️ NOT `decision_reason`, which is an APPROVER's words about their own
   * decision. A withdrawal is not a decision — a CHECK keeps this null on every
   * status but WITHDRAWN, and Phase 6 must not count one as the other.
   */
  withdrawn_note: z.string().nullable(),
  reviewed_by: z.uuid().nullable(),
  reviewed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type InternalRequest = z.infer<typeof internalRequestRowSchema>;

/**
 * A row plus the requester's name, which is how the queue selects it.
 *
 * ⚠️ THE EMBED CONSTRAINT IS NAMED IN THE `.select()` STRING and must stay
 * named. `vizserve_pms_internal_requests` has more than one FK to
 * `vizserve_pms_users`, so an unqualified embed is ambiguous and PostgREST
 * refuses the WHOLE query with PGRST201 — the failure takes the query, not the
 * column.
 *
 * `vizserve_pms_users` is nullable because the NAME is scoped separately from
 * the row: a reader may be entitled to the request and not to the person.
 */
export const internalRequestListRowSchema = internalRequestRowSchema.extend({
  vizserve_pms_users: z.object({ full_name: z.string() }).nullable(),
});

export type InternalRequestListRow = z.infer<typeof internalRequestListRowSchema>;

/** The detail page's row: the requester's email comes along, plus the leave type. */
export const internalRequestDetailSchema = internalRequestRowSchema.extend({
  vizserve_pms_users: z.object({ full_name: z.string(), email: z.string() }).nullable(),
  /**
   * P7-12 — the leave type as an embed rather than a second query.
   *
   * It is visible HERE, to the requester and to the lead deciding it, and
   * deliberately nowhere else: `vizserve_pms_leave_calendar` returns dates and a
   * name and no type, because "on sick leave" is health information about a
   * named colleague.
   *
   * Null on every non-LEAVE row, and on LEAVE rows older than P7-12.
   */
  vizserve_pms_leave_types: z.object({ label: z.string() }).nullable(),
});

export type InternalRequestDetail = z.infer<typeof internalRequestDetailSchema>;

/**
 * P9-01 — one reliever, their answer, and what they are taking on.
 *
 * ⚠️ THE EMBED CONSTRAINT IS NAMED, and it has to be.
 * `vizserve_pms_internal_request_relievers` has one FK to `vizserve_pms_users`,
 * so an unqualified embed resolves today — but the pattern that broke
 * `vizserve_pms_timesheet_weeks` with PGRST201 is a SECOND FK arriving later,
 * and the failure takes the whole query rather than the column. Naming it costs
 * nothing now and cannot break then.
 */
export const relieverRowSchema = z.object({
  id: z.uuid(),
  reliever_id: z.uuid(),
  /** Null while they have not answered. That is what `owedAsReliever` filters on. */
  decision: z.enum(APPROVAL_DECISIONS).nullable(),
  decided_at: z.string().nullable(),
  reason: z.string().nullable(),
  vizserve_pms_users: z.object({ full_name: z.string() }).nullable(),
  vizserve_pms_internal_request_reliever_tasks: z.array(
    z.object({
      task_id: z.uuid(),
      vizserve_pms_tasks: z.object({ id: z.uuid(), title: z.string() }).nullable(),
    }),
  ),
});

export type RelieverRow = z.infer<typeof relieverRowSchema>;

/**
 * P11-01 — one signature on the chain: who, when, and what they wrote.
 *
 * ⚠️ THIS TABLE HAD BEEN WRITTEN SINCE PHASE 5 AND READ BY NOTHING. Every
 * stage-2 and stage-3 decision on every internal request is in it with its
 * reason, and no screen showed one — the stage rail could manage a role and an
 * adverb, so a manager was asked for a final signature on a decision they could
 * not see.
 *
 * `reviewed_by` / `reviewed_at` on the request are NOT an alternative:
 * `vizserve_pms_decide_internal_request` writes them only on the terminal
 * transition (p9_04), so while a request sits at stage 3 they are still null.
 * The intermediate history exists here or nowhere.
 *
 * `full_name` is nullable because the NAME is scoped separately from the row. A
 * reader may be entitled to the decision and not to the person — see `metaLine`,
 * which drops whichever half is missing rather than rendering a stray separator.
 */
export const internalDecisionRowSchema = z.object({
  decision: z.enum(APPROVAL_DECISIONS),
  reason: z.string().nullable(),
  created_at: z.string(),
  approver_id: z.uuid(),
  vizserve_pms_users: z.object({ full_name: z.string() }).nullable(),
});

export type InternalDecisionRow = z.infer<typeof internalDecisionRowSchema>;

/** P8-05 — one timesheet week an approved leave request touches. */
export const affectedWeekSchema = z.object({
  id: z.uuid(),
  week_start: z.string(),
  status: z.string(),
});

export type AffectedWeek = z.infer<typeof affectedWeekSchema>;

/** P7-12 — one option in the leave-type picker. */
export const pickableLeaveTypeSchema = z.object({
  id: z.uuid(),
  label: z.string(),
  /**
   * P7-45. Null means "applies to everyone". Filtered by `leaveTypeApplies`.
   *
   * ⚠️ THE ENUM, NOT A `string`. `leaveTypeApplies` takes the generated union,
   * and widening it here would have made this the one place the check could be
   * handed a value the database cannot hold.
   */
  applies_to_gender: z.enum(GENDERS).nullable(),
  /** P9-01. What makes the hand-over block appear in the dialog. */
  requires_reliever: z.boolean(),
});

export type PickableLeaveType = z.infer<typeof pickableLeaveTypeSchema>;

/**
 * An id and a name. The narrowest people read there is.
 *
 * ⚠️ ITS OWN SCHEMA RATHER THAN A `.pick()` OFF `relieverCandidateSchema`, and
 * the near-miss is worth recording: it WAS that for an hour, and the reliever
 * shape then grew `department_id` and `department_name` — at which point the
 * reviewer-names read, which selects two columns, would have failed to parse and
 * taken the whole approvals queue down. Two reads with two column lists get two
 * schemas.
 */
export const personNameSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
});

/**
 * P11-11 — one name the reliever picker may offer: ANY ACTIVE COLLEAGUE.
 *
 * ⚠️ FROM A `security definer` RPC, NOT FROM `vizserve_pms_users`, and the four
 * columns are the point. Widening that table's policy so a member could read the
 * whole directory would have put email, role, `is_hr` and `app_access` in front
 * of everybody to populate a dropdown. `vizserve_pms_reliever_candidates`
 * returns exactly what the picker draws — a name and the team it groups under.
 *
 * The rows arrive already ordered by department, which is what lets
 * `groupByDepartment` in `new-request-dialog.tsx` walk them once rather than
 * bucketing: it starts a new group whenever `department_id` changes.
 */
export const relieverCandidateSchema = z.object({
  id: z.uuid(),
  full_name: z.string(),
  department_id: z.uuid(),
  department_name: z.string(),
});

export type RelieverCandidate = z.infer<typeof relieverCandidateSchema>;

/** P9-01 — one task somebody could hand over. */
export const handoverTaskSchema = z.object({
  id: z.uuid(),
  title: z.string(),
});

export type HandoverTask = z.infer<typeof handoverTaskSchema>;

/**
 * The three fields of the viewer that every approvals decision turns on.
 *
 * ⚠️ RESOLVED ON THE SERVER AND PASSED DOWN, LIKE `Viewer` ON `/tasks`. They are
 * the exact `Pick<AuthContext, …>` `waitingOnMe` has always taken — no more, and
 * the "no more" is the point: `lib/auth/authorization.ts` is `server-only`, so
 * the browser is TOLD its scope rather than deciding it. Everything derived from
 * these is PRESENTATION; `vizserve_pms_decide_internal_request` and
 * `vizserve_pms_may_decide_internal_stage` are the authority.
 */
export type ApprovalsViewer = {
  userId: string;
  role: Role;
  /** Which departments this person LEADS. D15 — the role alone is not enough. */
  managedDepartmentIds: readonly string[];
  /** P7-45. Decides which leave types the picker may offer. Null sees them all. */
  gender: VizservePmsGender | null;
  /** `roleAtLeast(role, "team_leader")` — resolved once, read in four places. */
  isApprover: boolean;
  /** P8-01: `roleAtLeast(role, "owner")`, never `=== "admin"` (a dead rung). */
  isAdmin: boolean;
  /** Whether the submit function will accept anything from them at all. */
  hasDepartment: boolean;
  fullName: string;
};
