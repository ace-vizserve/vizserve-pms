import { z } from "zod";

import { taskStatusSchema } from "@/lib/schemas/tasks";
import { requestStatusSchema } from "@/lib/schemas/requests";

/**
 * P12-21 — the row shapes behind `qk.reports(period)`.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THESE ROWS WERE READ WITH `as` CASTS AND NO PARSE AT ALL, and that is the
 * half of this file worth explaining. `/reports` and `lib/reports-server.ts`
 * between them held nine reads, every one of which did
 * `(data ?? []) as unknown as Row[]` and then added the result up. A cast is not
 * a check: a column renamed by a migration this build has not seen would have
 * arrived as `undefined`, `row.byStatus[undefined] += 1` would have made a key
 * called "undefined", and the page would have printed a total that was quietly
 * missing a band — on the one screen in the product where people make decisions
 * from numbers.
 *
 * `parse.ts` turns a shape fault into a sentence that names the likely cause
 * ("if a migration has not been applied to this project yet, that is why") and
 * puts it in `isError`, where `QueryError` says the figures could not be read
 * instead of printing figures that cannot be trusted.
 *
 * ⚠️ AND THE `?? []`S WENT WITH THE CASTS. That is the P12-01 bug, and this page
 * had it nine times: the four loaders threw the PostgREST error away entirely
 * and returned a zeroed metric, so a dead connection rendered as "no client has
 * given feedback in this period" and "turnaround: no completed requests". Both
 * are sentences somebody would repeat in a meeting.
 * ------------------------------------------------------------------------
 */

/**
 * P6-05 — one task, as the volume report counts it.
 *
 * `department_id` is NOT NULL on `vizserve_pms_tasks`, so this is the shape that
 * says so: a task with no department cannot exist and a row claiming otherwise
 * is a shape fault rather than a row to skip.
 */
export const reportTaskSchema = z.object({
  id: z.uuid(),
  status: taskStatusSchema,
  department_id: z.uuid(),
  due_date: z.string().nullable(),
});

/** P6-05 — one client request, counted by status. */
export const reportRequestSchema = z.object({
  id: z.uuid(),
  status: requestStatusSchema,
});

/**
 * P6-05 — one timesheet entry, with the department of the task it is against.
 *
 * ⚠️ THE EMBED IS `!inner` AND THE SHAPE STILL SAYS `.nullable()`. PostgREST
 * guarantees the join on an inner embed, but the generated types do not know it
 * and neither does this schema — an entry with no task is not a thing the schema
 * allows, so a null here is a fault worth surviving rather than crashing on. The
 * fetcher skips it, exactly as the RSC did.
 */
export const reportHoursSchema = z.object({
  minutes: z.number(),
  vizserve_pms_tasks: z.object({ department_id: z.uuid() }).nullable(),
});

/**
 * P6-04 — one completion, joined back to the request whose clock it stopped.
 *
 * ⚠️ THE HISTORY ROW IS THE ONLY DURABLE RECORD OF A COMPLETION INSTANT.
 * `vizserve_pms_tasks` carries the current status and nothing about when it got
 * there, so turnaround is measured from `vizserve_pms_task_status_history`.
 * Both embeds are `!inner` — an internal task has no request behind it and
 * cannot have a turnaround — but `sla_started_at` is genuinely nullable and the
 * fetcher drops those rows rather than measuring from nothing.
 */
export const turnaroundRowSchema = z.object({
  created_at: z.string(),
  vizserve_pms_tasks: z
    .object({
      title: z.string(),
      vizserve_pms_requests: z
        .object({ reference_no: z.string(), sla_started_at: z.string().nullable() })
        .nullable(),
    })
    .nullable(),
});

/**
 * P6-06a — what the client asked for against what the team committed to.
 *
 * ⚠️ BOTH ARE NULLABLE AND A NULL `approved_target_date` MEANS "AS REQUESTED",
 * NOT "MISSING" (P2-06). The fetcher counts it into `asRequested` rather than
 * dropping it; dropping would report every rubber-stamp as an absence of data
 * and make Gate 1 look busier than it is.
 */
export const negotiationRowSchema = z.object({
  target_date: z.string().nullable(),
  approved_target_date: z.string().nullable(),
});

/**
 * P6-06b — one Gate 3 decision.
 *
 * `decision` is left as a plain string on purpose. The three values this metric
 * counts are named at the call site, and a fourth added to the enum should widen
 * the DENOMINATOR — "of everything that closed" — rather than fail the parse and
 * take the page down.
 */
export const clientDecisionCountSchema = z.object({ decision: z.string() });

/** P6-07 — one piece of client feedback. */
export const feedbackRowSchema = z.object({
  rating: z.number(),
  comment: z.string().nullable(),
  created_at: z.string(),
});
