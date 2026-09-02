import type { Metadata } from "next";

import { ListSearch } from "@/components/list-search";
import { PageShell } from "@/components/page-shell";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { ilikeAnyOf } from "@/lib/search";
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
    q?: string;
    page?: string;
    size?: string;
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
  const SORTS = ["submitted", "reference", "title", "requester", "target", "agreed", "status"] as const;
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
    agreed: "approved_target_date",
    status: "status",
  };

  /*
   * P7-66 — REAL PAGING, REPLACING A SILENT CAP.
   *
   * This was `.limit(200)` with a sentence under the table apologising for it.
   * A queue that grows forever cannot be capped and called complete: the 201st
   * request simply did not exist as far as this page was concerned, and sorting
   * by target date made WHICH 200 you saw change under you.
   */
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.size);
  const from = (page - 1) * pageSize;

  const term = (params.q ?? "").trim();

  let query = supabase
    .from("vizserve_pms_requests")
    .select(
      "id, reference_no, title, requester_name, requester_org, target_date, approved_target_date, status, submitted_at, sla_started_at, reviewed_by, form_id",
      { count: "exact" },
    )
    .order(ORDER_COLUMN[sort], { ascending, nullsFirst: false })
    .range(from, from + pageSize - 1);

  /* Reference, title and requester — the three things somebody actually has to
     hand when chasing a request. `ilikeAnyOf` quotes the value; never build the
     filter string here. */
  const search = ilikeAnyOf(["reference_no", "title", "requester_name", "requester_org"], term);
  if (search) query = query.or(search);

  if (isRequestStatus(params.status)) query = query.eq("status", params.status);
  if (params.form) query = query.eq("form_id", params.form);
  if (params.from) query = query.gte("submitted_at", params.from);
  // Inclusive of the end date: "to 3 Aug" means through 3 Aug, not up to its
  // first second.
  if (params.to) query = query.lt("submitted_at", `${params.to}T23:59:59.999Z`);

  const { data: requests, error: requestsError, count } = await query;

  /*
   * ⚠️ P7-66 Phase 4b — `purpose` NARROWS THIS, and it is not a department
   * filter in disguise. A request can only come from a CLIENT_REQUEST form, so
   * an internal form in this picker is an option that can never match a row.
   * It matters because `published internal forms readable by their audience`
   * (20260902110000_p7_66_form_responses.sql) makes every published internal
   * form readable by every signed-in person — so without this line a lead would
   * see other departments' survey names listed as request filters. Client forms
   * are untouched by that policy and stay department-scoped by RLS.
   */
  const { data: forms } = await supabase
    .from("vizserve_pms_forms")
    // `sla_minutes` feeds the SLA column: how long this form promises a decision
    // in. Without it the request's `sla_started_at` is a clock with no target.
    .select("id, name, sla_minutes")
    .eq("purpose", "CLIENT_REQUEST")
    .order("name");
  /* A Map cannot cross the RSC boundary; the table rebuilds nothing and just
     indexes this. */
  const formNames = Object.fromEntries((forms ?? []).map((form) => [form.id, form.name]));
  const formSlaMinutes = Object.fromEntries(
    (forms ?? []).map((form) => [form.id, form.sla_minutes]),
  );

  const rows = (requests ?? []) as RequestRow[];
  /* Names for the "Reviewed by" column, over the reviewers on this page only. */
  const reviewerIds = [
    ...new Set((requests ?? []).map((request) => request.reviewed_by).filter(Boolean)),
  ] as string[];

  const { data: reviewers } =
    reviewerIds.length > 0
      ? await supabase.from("vizserve_pms_users").select("id, full_name").in("id", reviewerIds)
      : { data: null };

  const reviewerNames = Object.fromEntries(
    (reviewers ?? []).map((person) => [person.id, person.full_name]),
  );

  const isFiltered = Boolean(params.status || params.form || params.from || params.to || term);
  const total = count ?? 0;

  /*
   * ⚠️ REBUILT FROM THE NARROWED VALUES, NOT COPIED FROM THE URL — the same
   * shape `/inbox` and `/admin/audit` use. Every param this forgets is a param
   * the paginator silently drops, which is why `sort` and `dir` are here.
   */
  function hrefFor(target: number) {
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    if (params.status) next.set("status", params.status);
    if (params.form) next.set("form", params.form);
    if (params.from) next.set("from", params.from);
    if (params.to) next.set("to", params.to);
    if (sort !== "submitted") next.set("sort", sort);
    if (params.dir === "desc") next.set("dir", "desc");
    if (pageSize !== PAGE_SIZES[0]) next.set("size", String(pageSize));
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/requests?${query}` : "/requests";
  }

  return (
    <PageShell>
      <div className="flex flex-wrap items-end gap-3">
        <ListSearch
          initial={term}
          basePath="/requests"
          id="requests-search"
          placeholder="Search reference, title or requester"
          className="w-full sm:w-64 lg:w-72"
        />

        <RequestFilters forms={forms ?? []} />
      </div>

      {/* The readout describes the RESULTS when anything is narrowing them.
          A total that ignores the filters above it is the kind of mismatch that
          makes people distrust both numbers. */}
      <p className="-mt-1 text-xs text-muted-foreground">
        <span className="tabular-nums">{total}</span> {total === 1 ? "request" : "requests"}
        {isFiltered ? " matching" : " in total"}
        {term ? <> for &ldquo;{term}&rdquo;</> : null}
      </p>

      <RequestsTable
        rows={rows}
        formNames={formNames}
        formSlaMinutes={formSlaMinutes}
        reviewerNames={reviewerNames}
        isFiltered={isFiltered}
        errorMessage={requestsError?.message}
      />

      <Pagination
        page={page}
        pageSize={pageSize}
        total={total}
        hrefFor={hrefFor}
        basePath="/requests"
      />
    </PageShell>
  );
}
