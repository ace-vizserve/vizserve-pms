import type { Metadata } from "next";

import { PageShell } from "@/components/page-shell";
import { isRequestStatus } from "@/components/status-badge";
import { requireRole } from "@/lib/auth/authorization";
import { createClient } from "@/utils/supabase/server";
import { RequestFilters } from "./filters";
import { RequestsTable, type RequestRow } from "./requests-table";

export const metadata: Metadata = { title: "Requests" };

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
  searchParams: Promise<{
    status?: string;
    form?: string;
    from?: string;
    to?: string;
    sort?: string;
    dir?: string;
  }>;
}) {
  await requireRole("team_leader");
  const params = await searchParams;
  const supabase = await createClient();

  /*
   * P7-64 — THE SORT ALLOWLIST.
   *
   * `?sort=` is a string somebody can type. It is narrowed to this closed union
   * and then used to pick a LITERAL `.order()` below — never interpolated into
   * one. An unknown column name reaches Postgres as `invalid input value` and
   * 500s the page, which is why every `.order()` in this repo names its column
   * outright.
   */
  const SORTS = ["submitted", "reference", "title", "requester", "target", "status"] as const;
  type Sort = (typeof SORTS)[number];
  const sort: Sort = (SORTS as readonly string[]).includes(params.sort ?? "")
    ? (params.sort as Sort)
    : "submitted";
  // Submitted-at leads newest-first; everything else reads naturally ascending.
  const ascending = params.dir ? params.dir !== "desc" : sort !== "submitted";

  const ORDER_COLUMN: Record<Sort, string> = {
    submitted: "submitted_at",
    reference: "reference_no",
    title: "title",
    requester: "requester_name",
    target: "target_date",
    status: "status",
  };

  let query = supabase
    .from("vizserve_pms_requests")
    .select("id, reference_no, title, requester_name, requester_org, target_date, status, submitted_at, form_id")
    .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
    .limit(200);

  if (isRequestStatus(params.status)) query = query.eq("status", params.status);
  if (params.form) query = query.eq("form_id", params.form);
  if (params.from) query = query.gte("submitted_at", params.from);
  // Inclusive of the end date: "to 3 Aug" means through 3 Aug, not up to its
  // first second.
  if (params.to) query = query.lt("submitted_at", `${params.to}T23:59:59.999Z`);

  const { data: requests, error: requestsError } = await query;

  /*
   * ⚠️ P7-66 Phase 4b — `purpose` NARROWS THIS, and it is not a department
   * filter in disguise. A request can only come from a CLIENT_REQUEST form, so
   * an engagement form in this picker is an option that can never match a row.
   * It matters because `published engagement forms readable by staff`
   * (20260902110000_p7_66_form_responses.sql) makes every published engagement
   * form readable by every signed-in person — so without this line a lead would
   * see other departments' survey names listed as request filters. Client forms
   * are untouched by that policy and stay department-scoped by RLS.
   */
  const { data: forms } = await supabase
    .from("vizserve_pms_forms")
    .select("id, name")
    .eq("purpose", "CLIENT_REQUEST")
    .order("name");
  /* A Map cannot cross the RSC boundary; the table rebuilds nothing and just
     indexes this. */
  const formNames = Object.fromEntries((forms ?? []).map((form) => [form.id, form.name]));

  const rows = (requests ?? []) as RequestRow[];
  const isFiltered = Boolean(params.status || params.form || params.from || params.to);

  return (
    <PageShell>
      <RequestFilters forms={forms ?? []} />

      <RequestsTable
        rows={rows}
        formNames={formNames}
        isFiltered={isFiltered}
        errorMessage={requestsError?.message}
      />

      {rows.length >= 200 ? (
        <p className="text-xs text-muted-foreground">Showing the first 200. Narrow the filters to see more.</p>
      ) : null}
    </PageShell>
  );
}
