import Link from "next/link";
import { Inbox } from "lucide-react";

import { listPendingTimesheetWeeks } from "@/lib/approvals-queue-server";
import { loadUserNames } from "@/lib/counts-server";
import { loadDepartmentNames } from "@/lib/departments-server";
import type { VizservePmsInternalRequestStatus } from "@/lib/database.types";
import { cn } from "@/lib/utils";
import type { createClient } from "@/utils/supabase/server";
import { EmptyState } from "@/components/empty-state";
import { PAGE_SIZES, Pagination } from "@/components/pagination";
import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";
import { Section, type Row } from "./approvals-table";
import { TimesheetWeeksSection } from "./timesheet-weeks-table";

/** One more than shown, so a cut-off list says so. */
const WEEKS_CAP = 200;

/** `?status=` values, and the label each filter reads as. `all` stays out of the URL. */
export const OVERSIGHT_STATUSES = {
  all: { label: "All", value: null },
  pending: { label: "Pending", value: "PENDING_REVIEW" },
  approved: { label: "Approved", value: "APPROVED" },
  rejected: { label: "Rejected", value: "REJECTED" },
  withdrawn: { label: "Withdrawn", value: "WITHDRAWN" },
} as const satisfies Record<string, { label: string; value: VizservePmsInternalRequestStatus | null }>;

export type OversightStatus = keyof typeof OVERSIGHT_STATUSES;

export function isOversightStatus(value: string | undefined): value is OversightStatus {
  return value !== undefined && value in OVERSIGHT_STATUSES;
}

/**
 * P15-07 — APPROVALS FOR THE ROLES THAT ONLY WATCH.
 *
 * Admin, Business Manager and CEO file nothing, hand in no timesheet and
 * approve nothing (P14-04), so the ordinary page — "my requests" and "waiting
 * on me" — was blank for all three. This is the same page as a read-only view
 * of everybody's: every request in every department, the step each pending one
 * is at, and the weeks handed in that the Manager has still to decide.
 *
 * NO DEPARTMENT FILTER IN THE QUERY. RLS already gives these roles every
 * department (`vizserve_pms_manages_department` is true for admin and above).
 *
 * No filing button and no decision panel: the detail page decides that from
 * `waitingOnMe`, which is never true for these roles.
 */
export async function OversightApprovals({
  supabase,
  status,
  orderColumn,
  ascending,
  page,
  pageSize,
  sort,
  dir,
}: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  status: OversightStatus;
  orderColumn: string;
  ascending: boolean;
  page: number;
  pageSize: number;
  /** Only what the URL named, so the links below do not invent a choice. */
  sort?: string;
  dir?: string;
}) {
  const from = (page - 1) * pageSize;

  let query = supabase
    .from("vizserve_pms_internal_requests")
    .select("*, vizserve_pms_users!vizserve_pms_internal_requests_requester_id_fkey(full_name)", {
      count: "exact",
    })
    .order(orderColumn, { ascending, nullsFirst: false })
    .range(from, from + pageSize - 1);

  const statusValue = OVERSIGHT_STATUSES[status].value;
  if (statusValue) query = query.eq("status", statusValue);

  const [{ data, error, count }, weeks, departments] = await Promise.all([
    query,
    // The Manager's queue, read rather than worked. The caller's id is passed
    // only for the helper's own-week exclusion, which drops nothing here: these
    // roles hand in no weeks.
    listPendingTimesheetWeeks(supabase, "00000000-0000-0000-0000-000000000000", true, WEEKS_CAP + 1),
    loadDepartmentNames(),
  ]);

  const rows = (data ?? []) as unknown as Row[];
  const total = count ?? 0;
  const reviewerIds = [...new Set(rows.map((row) => row.reviewed_by).filter(Boolean))] as string[];
  const reviewerNames = await loadUserNames(reviewerIds);

  const weeksTruncated = weeks.rows.length > WEEKS_CAP;
  const weekRows = weeksTruncated ? weeks.rows.slice(0, WEEKS_CAP) : weeks.rows;

  function href(next: { status?: OversightStatus; page?: number }) {
    const params = new URLSearchParams();
    const targetStatus = next.status ?? status;
    if (targetStatus !== "all") params.set("status", targetStatus);
    if (sort) params.set("sort", sort);
    if (sort && dir === "desc") params.set("dir", "desc");
    if (pageSize !== PAGE_SIZES[0]) params.set("size", String(pageSize));
    if (next.page && next.page > 1) params.set("page", String(next.page));
    const qs = params.toString();
    return qs ? `/approvals?${qs}` : "/approvals";
  }

  return (
    <>
      <p className="text-xs text-muted-foreground">
        Every leave, overtime, time correction and reimbursement request across the company, and
        who each pending one is waiting on. Read-only: requests are decided by team leaders and the
        manager.
      </p>

      {/* Links, not a client filter: the list is paged on the server, so the
          filter has to reach the query. */}
      <nav aria-label="Filter by status" className="flex flex-wrap gap-2">
        {(Object.keys(OVERSIGHT_STATUSES) as OversightStatus[]).map((key) => (
          <Link
            key={key}
            href={href({ status: key })}
            aria-current={key === status ? "page" : undefined}
            className={cn(buttonVariants({ variant: key === status ? "default" : "outline", size: "sm" }))}
          >
            {OVERSIGHT_STATUSES[key].label}
          </Link>
        ))}
      </nav>

      <Section
        title="All requests"
        description="Every department. Open one to see its hand-over, its steps and who signed each."
        rows={rows}
        showWho
        showStep
        count={total}
        departmentNames={Object.fromEntries(departments)}
        reviewerNames={reviewerNames}
        empty={
          error ? (
            <QueryError what="the requests" message={error.message} />
          ) : (
            <EmptyState
              icon={<Inbox />}
              title={status === "all" ? "No requests yet" : "No requests with that status"}
              description="Leave, time corrections, overtime and reimbursements appear here as people file them."
            />
          )
        }
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        hrefFor={(target) => href({ page: target })}
        basePath="/approvals"
      />

      <TimesheetWeeksSection
        rows={weekRows}
        description="Weeks handed in and waiting on the manager. These rows open the team week grid on the right week."
        empty={
          weeks.error ? (
            <QueryError what="the timesheet weeks" message={weeks.error.message} />
          ) : (
            <EmptyState
              icon={<Inbox />}
              title="No weeks waiting"
              description="Every week handed in has been decided."
            />
          )
        }
      />
      {weeksTruncated ? (
        <p className="text-xs text-muted-foreground">
          Showing the first {WEEKS_CAP} weeks handed in.
        </p>
      ) : null}
    </>
  );
}
