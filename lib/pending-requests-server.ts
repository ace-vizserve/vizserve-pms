import {
  pendingRequestsApply,
  type PendingRequest,
  type PendingRequestFilters,
} from "@/lib/schemas/approvals";
import { createClient } from "@/utils/supabase/server";

/**
 * Reads the client requests still waiting on Gate 1, for the task views.
 *
 * The rules about WHICH filters a request can answer live in
 * `pendingRequestsApply` (lib/schemas/approvals.ts) — pure and unit-tested.
 * This file is the query and nothing else, which is the same division
 * `lib/dtr-server.ts` and `lib/client-approval-server.ts` follow.
 *
 * SCOPE IS RLS'S JOB. `vizserve_pms_requests` is readable only by a lead of the
 * form's department, so this returns nothing at all for a member — which is
 * right, since approving is not theirs to do — and the caller renders nothing
 * rather than an empty heading. There is no role check here and there should
 * not be one.
 */

type Row = {
  id: string;
  reference_no: string;
  title: string;
  requester_name: string;
  requester_org: string | null;
  target_date: string | null;
  submitted_at: string | null;
  vizserve_pms_forms: { name: string; default_list_id: string | null } | null;
};

export async function loadPendingRequests(
  filters: PendingRequestFilters & { listId?: string | null } = {},
): Promise<PendingRequest[]> {
  if (!pendingRequestsApply(filters)) return [];

  const supabase = await createClient();

  let query = supabase
    .from("vizserve_pms_requests")
    /*
     * `!inner` because the form is not decoration here — it carries the list
     * this request will land in, and the `?list=` filter below goes THROUGH the
     * embed rather than fetching the form's list first. Same move `/tasks`
     * makes for its folder filter, and for the same reason: reading it first
     * would make the slow query wait on the fast one.
     */
    .select(
      "id, reference_no, title, requester_name, requester_org, target_date, submitted_at, vizserve_pms_forms!inner(name, default_list_id)",
    )
    .eq("status", "PENDING_REVIEW")
    /*
     * OLDEST FIRST, and it is deliberately the opposite of the task list.
     *
     * A task list is read by deadline — what is due soonest. A queue is read by
     * how long something has been sitting there, because the failure mode of a
     * review queue is a request nobody looked at, not a request looked at in
     * the wrong order.
     */
    .order("submitted_at", { ascending: true, nullsFirst: false });

  // The form's inbox list is where this request's task will land, so filtering
  // the page to one list filters these to the requests destined for it.
  if (filters.listId) {
    query = query.eq("vizserve_pms_forms.default_list_id", filters.listId);
  }

  const { data, error } = await query;

  /*
   * Deliberately not thrown, and this is a judgement rather than laziness.
   *
   * These rows are an ADDITION to a page whose main job is tasks. A failed
   * request query must not take the task list down with it — the page still
   * has everything it had before this feature existed. The cost is that a
   * failure reads as "nothing waiting", which is why the surfaces that show
   * these also keep their own error handling for the task query itself.
   */
  if (error || !data) return [];

  return (data as unknown as Row[]).map((row) => ({
    id: row.id,
    reference_no: row.reference_no,
    title: row.title,
    requester_name: row.requester_name,
    requester_org: row.requester_org,
    target_date: row.target_date,
    submitted_at: row.submitted_at,
    listId: row.vizserve_pms_forms?.default_list_id ?? null,
    formName: row.vizserve_pms_forms?.name ?? "",
  }));
}
