import "server-only";

import { formatDate, formatDateTime } from "@/lib/dates";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * Everything a client-facing email says about the request itself.
 *
 * ⚠️ ONE SHAPE, LOADED ONCE, PASSED TO EVERY SENDER. The alternative was seven
 * more optional parameters on seven senders and a widened `.select()` at each
 * of the four call sites, which is the same five columns written eleven times
 * and drifting from the first edit onwards.
 *
 * EVERY FIELD IS NULLABLE AND A NULL OMITS ITS ROW. Not "—", not "Not
 * specified": a labelled row with nothing beside it is the EmailJS failure mode
 * this codebase already paid for once, where a renamed variable shipped as a
 * blank in a client's inbox and nothing anywhere said why. A row that cannot be
 * filled should not be drawn.
 *
 * WHY IT READS THROUGH THE SERVICE ROLE. Two of the four callers have no user
 * session at all — the public form's acknowledgement and the reminder cron —
 * and the other two are sending to a client about a request they can already
 * see. There is no scope decision here that RLS would be making: the row is
 * fetched by primary key, and the only consumer is an email to the address
 * stored on that row.
 */
export type RequestDetails = {
  /** The form they filled in — "Design Request". */
  formName: string | null;
  /** `requester_org`. HFSE for everyone until another client exists (D13). */
  requesterOrg: string | null;
  /** Formatted. When it arrived. */
  submittedAt: string | null;
  /** Formatted. The date THEY asked for, which may not be the agreed one. */
  targetDate: string | null;
  /** Formatted. What the Team Leader negotiated to. */
  approvedTargetDate: string | null;
  /** The brief they typed. Rendered as a quote, not a table row. */
  description: string | null;
  /** "Creative" or "Creative · Ryza Santos". Only exists after Gate 1. */
  handledBy: string | null;
};

/**
 * Loads the detail block for one request. Never throws.
 *
 * A failure here must not stop the email: the whole point of these is that a
 * client hears something, and a degraded email that omits three rows is better
 * than a decision that goes out silently because a join failed. Callers already
 * treat mail as non-fatal; this keeps that true one level down.
 *
 * FOUR SMALL QUERIES RATHER THAN ONE NESTED SELECT, deliberately. `tasks` has
 * two foreign keys into `vizserve_pms_users` (assignee and QA), so an embedded
 * resource needs a disambiguating hint that fails at RUNTIME when it is wrong
 * — in a path with no test against a real database and no user watching. Four
 * lookups by primary key cannot be ambiguous, and this runs after the work is
 * already committed.
 */
export async function loadRequestDetails(requestId: string): Promise<RequestDetails | null> {
  try {
    const admin = createAdminClient();

    const { data: request } = await admin
      .from("vizserve_pms_requests")
      .select(
        "form_id, requester_org, description, target_date, approved_target_date, submitted_at",
      )
      .eq("id", requestId)
      .maybeSingle();

    if (!request) return null;

    const [{ data: form }, { data: task }] = await Promise.all([
      admin
        .from("vizserve_pms_forms")
        .select("name")
        .eq("id", request.form_id)
        .maybeSingle(),
      admin
        .from("vizserve_pms_tasks")
        .select("department_id, assignee_id")
        .eq("request_id", requestId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    const [{ data: department }, { data: assignee }] = await Promise.all([
      task
        ? admin
            .from("vizserve_pms_departments")
            .select("name")
            .eq("id", task.department_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      task?.assignee_id
        ? admin
            .from("vizserve_pms_users")
            .select("full_name")
            .eq("id", task.assignee_id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    return {
      formName: form?.name ?? null,
      requesterOrg: request.requester_org ?? null,
      submittedAt: request.submitted_at ? formatDateTime(request.submitted_at) : null,
      targetDate: request.target_date ? formatDate(request.target_date) : null,
      approvedTargetDate: request.approved_target_date
        ? formatDate(request.approved_target_date)
        : null,
      // Trimmed rather than truncated. A brief that runs long is the client's
      // own words being read back to them; cutting it mid-sentence reads as a
      // bug, and the quote block scrolls perfectly well.
      description: request.description?.trim() || null,
      handledBy: department?.name
        ? assignee?.full_name
          ? `${department.name} · ${assignee.full_name}`
          : department.name
        : null,
    };
  } catch (error) {
    console.error(`[email] request details unavailable for ${requestId} —`, error);
    return null;
  }
}

export async function loadRequestDetailsForTask(taskId: string): Promise<RequestDetails | null> {
  try {
    const { data: task } = await createAdminClient()
      .from("vizserve_pms_tasks")
      .select("request_id")
      .eq("id", taskId)
      .maybeSingle();

    return task?.request_id ? await loadRequestDetails(task.request_id) : null;
  } catch (error) {
    console.error(`[email] request details unavailable for task ${taskId} —`, error);
    return null;
  }
}
