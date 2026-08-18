import type { Metadata } from "next";
import Link from "next/link";
import { Inbox } from "lucide-react";

import { requireAuthContext } from "@/lib/auth/authorization";
import type { InternalRequestRow } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";
import { createClient } from "@/utils/supabase/server";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { InternalStatusBadge, InternalTypeBadge } from "@/components/status-badge";
import { NewRequestDialog } from "./new-request-dialog";

/** Rows rendered. The query asks for one more so the cap is detectable. */
const APPROVALS_PAGE_SIZE = 200;
import { requestDetail } from "./request-summary";

export const metadata: Metadata = { title: "Approvals" };

/**
 * P5-10 — my requests, and requests pending my approval.
 *
 * Two sections on one page rather than two routes, because for a team leader
 * they are the same errand: "what do I owe, and what does anyone owe me". A
 * member simply sees one section, since the other is always empty for them.
 *
 * ONE QUERY FOR BOTH. RLS already returns your own requests plus your
 * departments'; splitting them here is a partition of rows we already hold, not
 * a second round trip — and it means the two lists cannot disagree about a row
 * that changed between them.
 *
 * No <h1>. The breadcrumb is the page label; the two sections keep their own
 * <h2> because "pending your approval" and "mine" are genuinely different lists
 * and nothing else on the screen distinguishes them.
 */
type Row = InternalRequestRow & { vizserve_pms_users: { full_name: string } | null };

function columnsFor(showWho: boolean): Column<Row>[] {
  return [
    {
      key: "request",
      header: "Request",
      cell: (request) => (
        <>
          <Link href={`/approvals/${request.id}`} className="font-medium hover:underline">
            {requestDetail(request)}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <InternalTypeBadge type={request.request_type} />
            {showWho ? (
              <span className="text-2xs text-muted-foreground">
                {request.vizserve_pms_users?.full_name ?? "—"}
              </span>
            ) : null}
          </div>
        </>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      className: "hidden sm:table-cell max-w-xs",
      cell: (request) => <p className="truncate text-muted-foreground">{request.reason}</p>,
    },
    {
      key: "submitted",
      header: "Submitted",
      className: "hidden md:table-cell whitespace-nowrap text-muted-foreground",
      cell: (request) => formatDate(request.created_at),
    },
    {
      key: "status",
      header: "Status",
      cell: (request) => <InternalStatusBadge status={request.status} />,
    },
  ];
}

function Section({
  title,
  description,
  rows,
  showWho,
  empty,
}: {
  title: string;
  description: string;
  rows: Row[];
  showWho: boolean;
  empty: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>

      <DataTable
        columns={columnsFor(showWho)}
        rows={rows}
        getRowKey={(request) => request.id}
        empty={empty}
      />
    </section>
  );
}

export default async function ApprovalsPage() {
  const context = await requireAuthContext();
  const supabase = await createClient();

  const [{ data, error: requestsError }, { data: leaveTypes }] = await Promise.all([
    supabase
      .from("vizserve_pms_internal_requests")
      .select("*, vizserve_pms_users!vizserve_pms_internal_requests_requester_id_fkey(full_name)")
      .order("created_at", { ascending: false })
      // One more than shown, so truncation is detectable. The list splits into
      // "mine" and "pending on me" AFTER this, so a silent cap here does not just
      // hide old rows — it can drop something out of somebody's approval queue
      // with nothing on screen to say so.
      .limit(APPROVALS_PAGE_SIZE + 1),

    // P7-12 — the picker's options.
    //
    // ACTIVE ONLY, and ordered by the list's own `sort_order` rather than
    // alphabetically: a retired type stays valid on the requests that already
    // reference it and must not be selectable for a new one, and the seeded
    // order puts Vacation and Sick first because that is what almost everybody
    // picks.
    supabase
      .from("vizserve_pms_leave_types")
      .select("id, label")
      .eq("is_active", true)
      .order("sort_order"),
  ]);

  const fetched = (data ?? []) as unknown as Row[];
  const truncated = fetched.length > APPROVALS_PAGE_SIZE;
  const rows = truncated ? fetched.slice(0, APPROVALS_PAGE_SIZE) : fetched;
  const mine = rows.filter((row) => row.requester_id === context.userId);
  // Everything visible that is not mine is, by RLS, something I lead the
  // department for. Pending ones are the queue; decided ones are history and
  // live on the requester's own list.
  const pendingOnMe = rows.filter(
    (row) => row.requester_id !== context.userId && row.status === "PENDING_REVIEW",
  );

  return (
    <PageShell className="gap-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Leave, time corrections and reimbursements. Leave balances are counted by HR — this is the
          record, not an entitlement check.
        </p>
        <NewRequestDialog leaveTypes={leaveTypes ?? []} />
      </div>

      {/* Approver queue first when there is one: it is the thing with somebody
          else waiting on the other end. Rendered only when non-empty, so it
          needs no empty state of its own. */}
      {pendingOnMe.length > 0 ? (
        <Section
          title="Pending your approval"
          description="Requests from the departments you lead."
          rows={pendingOnMe}
          showWho
          empty={null}
        />
      ) : null}

      <Section
        title="My requests"
        description="Everything you have submitted."
        rows={mine}
        showWho={false}
        empty={
          requestsError ? (
            <QueryError what="your requests" message={requestsError.message} />
          ) : (
            <EmptyState
              icon={<Inbox />}
              title="You have not submitted any requests"
              description="Leave, a missed time in or out, and reimbursements all start here. Your department lead decides them — you cannot decide your own."
            />
          )
        }
      />

      {truncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the most recent {APPROVALS_PAGE_SIZE}. Older requests are not listed.
        </p>
      ) : null}
    </PageShell>
  );
}
