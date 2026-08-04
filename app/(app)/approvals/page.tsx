import type { Metadata } from "next";
import Link from "next/link";

import { requireAuthContext } from "@/lib/auth/authorization";
import type { InternalRequestRow } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";
import { createClient } from "@/utils/supabase/server";
import { NewRequestDialog } from "./new-request-dialog";
import { InternalStatusBadge, requestDetail, TypeBadge } from "./request-summary";

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
 */
type Row = InternalRequestRow & { vizserve_pms_users: { full_name: string } | null };

function RequestRow({ request, showWho }: { request: Row; showWho: boolean }) {
  return (
    <tr className="border-t align-top hover:bg-muted/30">
      <td className="px-4 py-3">
        <Link href={`/approvals/${request.id}`} className="font-medium hover:underline">
          {requestDetail(request)}
        </Link>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <TypeBadge type={request.request_type} />
          {showWho ? (
            <span className="text-2xs text-muted-foreground">
              {request.vizserve_pms_users?.full_name ?? "—"}
            </span>
          ) : null}
        </div>
      </td>
      <td className="max-w-xs px-4 py-3">
        <p className="truncate text-muted-foreground">{request.reason}</p>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
        {formatDate(request.created_at)}
      </td>
      <td className="px-4 py-3">
        <InternalStatusBadge status={request.status} />
      </td>
    </tr>
  );
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
  empty: string;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-xs text-muted-foreground">{empty}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  Request
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  Reason
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  Submitted
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((request) => (
                <RequestRow key={request.id} request={request} showWho={showWho} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function ApprovalsPage() {
  const context = await requireAuthContext();
  const supabase = await createClient();

  const { data } = await supabase
    .from("vizserve_pms_internal_requests")
    .select("*, vizserve_pms_users!vizserve_pms_internal_requests_requester_id_fkey(full_name)")
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as unknown as Row[];
  const mine = rows.filter((row) => row.requester_id === context.userId);
  // Everything visible that is not mine is, by RLS, something I lead the
  // department for. Pending ones are the queue; decided ones are history and
  // live on the requester's own list.
  const pendingOnMe = rows.filter(
    (row) => row.requester_id !== context.userId && row.status === "PENDING_REVIEW",
  );

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Leave, time corrections and reimbursements. Leave balances are counted by HR — this is
            the record, not an entitlement check.
          </p>
        </div>
        <NewRequestDialog />
      </div>

      {/* Approver queue first when there is one: it is the thing with somebody
          else waiting on the other end. */}
      {pendingOnMe.length > 0 ? (
        <Section
          title="Pending your approval"
          description="Requests from the departments you lead."
          rows={pendingOnMe}
          showWho
          empty=""
        />
      ) : null}

      <Section
        title="My requests"
        description="Everything you have submitted."
        rows={mine}
        showWho={false}
        empty="You have not submitted any requests yet."
      />
    </div>
  );
}
