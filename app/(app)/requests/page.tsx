import { Inbox } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { isRequestStatus, RequestStatusBadge } from "@/components/status-badge";
import { requireRole } from "@/lib/auth/authorization";
import { formatDate, isOverdue } from "@/lib/dates";
import { createClient } from "@/utils/supabase/server";
import { RequestFilters } from "./filters";

export const metadata: Metadata = { title: "Requests" };

type RequestRow = {
  id: string;
  reference_no: string;
  title: string;
  requester_name: string;
  requester_org: string;
  target_date: string | null;
  status: "DRAFT" | "SUBMITTED" | "PENDING_REVIEW" | "APPROVED" | "RETURNED" | "REJECTED";
  submitted_at: string;
  form_id: string;
};

/**
 * P1-13 — the Team Leader's queue, and Gate 1's front door.
 *
 * Department scoping is RLS's job, not this query's. That is what makes the
 * Phase 1 exit criterion — "a request appears in the correct TL's queue and
 * nowhere else" — assertable at the API layer rather than by clicking around.
 *
 * Sorted by target date ascending: a queue is a to-do list, so the thing due
 * soonest leads, not the thing submitted most recently.
 *
 * No <h1>. The shell breadcrumb is the page label.
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
    .select("id, reference_no, title, requester_name, requester_org, target_date, status, submitted_at, form_id")
    .order("submitted_at", { ascending: false, nullsFirst: false })
    .limit(200);

  if (isRequestStatus(params.status)) query = query.eq("status", params.status);
  if (params.form) query = query.eq("form_id", params.form);
  if (params.from) query = query.gte("submitted_at", params.from);
  // Inclusive of the end date: "to 3 Aug" means through 3 Aug, not up to its
  // first second.
  if (params.to) query = query.lt("submitted_at", `${params.to}T23:59:59.999Z`);

  const { data: requests, error: requestsError } = await query;

  const { data: forms } = await supabase.from("vizserve_pms_forms").select("id, name").order("name");
  const formName = new Map((forms ?? []).map((form) => [form.id, form.name]));

  const rows = (requests ?? []) as RequestRow[];
  const isFiltered = Boolean(params.status || params.form || params.from || params.to);

  const columns: Column<RequestRow>[] = [
    {
      key: "submitted_at",
      header: "Submitted at",
      className: "max-w-xs",
      cell: (request) => <p className="truncate">{formatDate(request.submitted_at)}</p>,
    },
    {
      key: "reference",
      header: "Reference",
      className: "whitespace-nowrap",
      cell: (request) => (
        <>
          <Link href={`/requests/${request.id}`} className="font-medium hover:underline">
            {request.reference_no}
          </Link>
          <p className="text-xs text-muted-foreground">{formName.get(request.form_id) ?? "—"}</p>
        </>
      ),
    },
    {
      key: "title",
      header: "Request",
      className: "max-w-xs",
      cell: (request) => <p className="truncate">{request.title}</p>,
    },
    {
      key: "requester",
      header: "Requester",
      className: "hidden md:table-cell",
      cell: (request) => (
        <>
          <p className="truncate">{request.requester_name}</p>
          <p className="text-xs text-muted-foreground">{request.requester_org}</p>
        </>
      ),
    },
    {
      key: "target",
      header: "Target date",
      className: "hidden sm:table-cell whitespace-nowrap",
      cell: (request) => (
        <>
          {formatDate(request.target_date)}
          {/* Overdue is said in words as well as colour — a red date alone is
              invisible to a meaningful share of people, and to anyone reading
              a printed or screenshotted queue. */}
          {isOverdue(request.target_date) && request.status === "PENDING_REVIEW" ? (
            <p className="text-xs font-medium text-destructive">Overdue</p>
          ) : null}
        </>
      ),
    },
    {
      key: "status",
      header: "Status",
      cell: (request) => <RequestStatusBadge status={request.status} />,
    },
  ];

  return (
    <PageShell>
      <RequestFilters forms={forms ?? []} />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(request) => request.id}
        empty={
          requestsError ? (
            <QueryError what="requests" message={requestsError.message} />
          ) : isFiltered ? (
            <EmptyState
              icon={<Inbox />}
              title="No requests match these filters"
              description="Widen the date range or clear the status filter to see the rest of the queue."
            />
          ) : (
            <EmptyState
              icon={<Inbox />}
              title="Nothing here yet"
              description="Requests appear when a client submits one of your published forms. If you are expecting one, check the form is published and routed to your department."
            />
          )
        }
      />

      {rows.length >= 200 ? (
        <p className="text-xs text-muted-foreground">Showing the first 200. Narrow the filters to see more.</p>
      ) : null}
    </PageShell>
  );
}
