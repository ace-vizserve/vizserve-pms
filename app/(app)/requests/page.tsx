import type { Metadata } from "next";
import Link from "next/link";

import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { formatDate, isOverdue } from "@/lib/dates";
import { isRequestStatus, RequestStatusBadge } from "@/components/status-badge";
import { RequestFilters } from "./filters";

export const metadata: Metadata = { title: "Requests" };

/**
 * P1-13 — the Team Leader's queue. Phase 2 turns this into Gate 1.
 *
 * Department scoping is RLS's job, not this query's. That is what makes the
 * Phase 1 exit criterion — "a request appears in the correct TL's queue and
 * nowhere else" — assertable at the API layer rather than by clicking around.
 *
 * Sorted by target date ascending: the queue is a to-do list, so the thing due
 * soonest is the thing to look at, not the thing submitted most recently.
 */
export default async function RequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; form?: string; from?: string; to?: string }>;
}) {
  await requireRole("team_leader");
  const params = await searchParams;
  const supabase = await createClient();

  let query = supabase
    .from("vizserve_pms_requests")
    .select(
      "id, reference_no, title, requester_name, requester_org, target_date, status, submitted_at, form_id",
    )
    .order("target_date", { ascending: true, nullsFirst: false })
    .limit(200);

  if (isRequestStatus(params.status)) query = query.eq("status", params.status);
  if (params.form) query = query.eq("form_id", params.form);
  if (params.from) query = query.gte("submitted_at", params.from);
  // Inclusive of the end date: a user picking "to 3 Aug" means through 3 Aug,
  // not up to its first second.
  if (params.to) query = query.lt("submitted_at", `${params.to}T23:59:59.999Z`);

  const { data: requests } = await query;

  const { data: forms } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name")
    .order("name");

  const formName = new Map((forms ?? []).map((f) => [f.id, f.name]));

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Requests</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          Client submissions routed to the departments you lead.
        </p>
      </div>

      <RequestFilters forms={forms ?? []} />

      {!requests || requests.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center">
          <p className="text-sm font-medium">Nothing here</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Requests appear when a client submits one of your published forms. If you are expecting
            one, check the form is published and routed to your department.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Reference</th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Request</th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Requester</th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Target date</th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((request) => {
                const overdue =
                  isOverdue(request.target_date) && request.status === "PENDING_REVIEW";

                return (
                  <tr key={request.id} className="border-t align-top hover:bg-muted/30">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <Link
                        href={`/requests/${request.id}`}
                        className="font-medium hover:underline"
                      >
                        {request.reference_no}
                      </Link>
                      <p className="mt-0.5 text-2xs text-muted-foreground">
                        {formName.get(request.form_id) ?? "—"}
                      </p>
                    </td>
                    <td className="max-w-xs px-4 py-3">
                      <p className="truncate">{request.title}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="truncate">{request.requester_name}</p>
                      <p className="mt-0.5 text-2xs text-muted-foreground">
                        {request.requester_org}
                      </p>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {formatDate(request.target_date)}
                      {/* Overdue is stated in words as well as colour — a red
                          date alone is invisible to a meaningful share of
                          people and to anyone printing the queue. */}
                      {overdue ? (
                        <p className="mt-0.5 text-2xs font-medium text-destructive">Overdue</p>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <RequestStatusBadge status={request.status} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {requests && requests.length >= 200 ? (
        <p className="text-xs text-muted-foreground">
          Showing the first 200. Narrow the filters to see more.
        </p>
      ) : null}
    </div>
  );
}
