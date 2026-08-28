import type { Metadata } from "next";
import Link from "next/link";
import { History, SearchX } from "lucide-react";

import { requireRole } from "@/lib/auth/authorization";
import {
  auditActionLabel,
  auditActionTone,
  auditEntityHref,
  auditEntityLabel,
  auditFields,
  isAuditEntityType,
  isAuditPeriod,
  isRecord,
  isUuid,
  type AuditLookup,
  type AuditPeriod,
} from "@/lib/audit";
import { addDays, formatDateTime, todayInAppZone } from "@/lib/dates";
import { ilikeAnyOf } from "@/lib/search";
import { createClient } from "@/utils/supabase/server";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ListSearch } from "@/components/list-search";
import { PageShell } from "@/components/page-shell";
import { PAGE_SIZES, Pagination, resolvePage, resolvePageSize } from "@/components/pagination";
import { QueryError } from "@/components/query-error";
import { Chip } from "@/components/status-badge";
import { buttonVariants } from "@/components/ui/button";
import { AuditDetails, type AuditEntry } from "./audit-details";
import { AuditFilters, SYSTEM_ACTOR } from "./audit-filters";

export const metadata: Metadata = { title: "Audit trail" };

/** The window the screen opens on. Also the value that stays out of the URL. */
const DEFAULT_PERIOD: AuditPeriod = "30";

/**
 * P0-09 — the audit trail, finally readable.
 *
 * The table has been written to since Phase 0 by every server action and by a
 * dozen SQL functions, and until now nothing read it: the RLS policy is
 * admin-only select and there was no screen behind it. An audit trail nobody
 * can open is a trail that exists only in the sense that the rows are there.
 *
 * ADMIN ONLY, and enforced three times over — `requireRole("admin")` here, the
 * `vizserve_pms_is_admin()` policy under the query, and the nav floor that
 * keeps the link out of everyone else's sidebar. The nav one protects nobody
 * (hiding a link is presentation); the other two are the enforcement.
 *
 * Read through the ORDINARY RLS-scoped client, deliberately. The service role
 * would work and would be wrong: it would mean this screen shows rows the
 * policy says an admin may not see, and the day the policy narrows — a
 * department-scoped audit view, say — the screen would silently keep showing
 * everything.
 *
 * OPENS ON THE LAST 30 DAYS rather than on everything. This table only ever
 * grows and never gets pruned; a first page of "all time" is the same first
 * page as "last 30 days" on any real dataset, but it costs an unbounded
 * `count: exact` to produce and tells the reader nothing about how far back
 * they are looking.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    page?: string;
    size?: string;
    entity?: string;
    actor?: string;
    period?: string;
  }>;
}) {
  await requireRole("admin");
  const params = await searchParams;
  const supabase = await createClient();

  const term = params.q?.trim() ?? "";
  // Both clamped in components/pagination.tsx. `size` in particular is not
  // decoration: .range() takes what it is given, so an unvalidated ?size=100000
  // is one URL edit away from selecting every audit row ever written.
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.size);

  const entity = isAuditEntityType(params.entity) ? params.entity : null;
  const period: AuditPeriod = isAuditPeriod(params.period) ? params.period : DEFAULT_PERIOD;

  // Not narrowed against the user list on purpose: an id that matches nobody is
  // a filter that returns nothing, which is the correct answer to it. Only the
  // `system` sentinel is special, and it maps to `actor_id is null`.
  const actor = params.actor?.trim() || null;

  const from = (page - 1) * pageSize;

  let query = supabase
    .from("vizserve_pms_audit_logs")
    .select("id, entity_type, entity_id, action, actor_id, before, after, created_at", {
      count: "exact",
    })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);

  if (entity) query = query.eq("entity_type", entity);

  if (actor === SYSTEM_ACTOR) {
    // `.is(null)`, not `.eq`. SQL null equals nothing, itself included, so an
    // `eq` here would return zero rows for every system-written entry — the
    // exact rows this filter exists to find.
    query = query.is("actor_id", null);
  } else if (actor) {
    query = query.eq("actor_id", actor);
  }

  if (period !== "all") {
    const since = addDays(todayInAppZone(), -Number(period));
    // The offset is explicit because `created_at` is `timestamptz` and a bare
    // date reaches Postgres in the session zone (UTC), which is eight hours off
    // Manila — enough to drop most of the first day of the window on a screen
    // whose whole promise is "the last 30 days".
    if (since) query = query.gte("created_at", `${since}T00:00:00+08:00`);
  }

  // A pasted id is an exact `entity_id` lookup, because `entity_id` is a uuid
  // column and Postgres has no `uuid ~~ text` operator — an ilike against it is
  // a 400 the reader would read as "search is broken". Everything else goes to
  // the text columns, escaped in lib/search.ts.
  if (term) {
    if (isUuid(term)) query = query.eq("entity_id", term);
    else {
      const searchFilter = ilikeAnyOf(["action", "entity_type"], term);
      if (searchFilter) query = query.or(searchFilter);
    }
  }

  const [{ data: entries, count, error }, { data: people }, { data: leaveTypes }, { data: departments }] =
    await Promise.all([
      query,
      // Every user, active or not. A deactivated account's past actions are
      // still in the trail and still need a name against them — and "who did
      // this" is asked about leavers more often than about anyone else.
      supabase.from("vizserve_pms_users").select("id, full_name").order("full_name"),
      // The two other tables whose ids appear INSIDE payloads. Leave types are
      // the keys of the allocation map; departments arrive as `department_id`.
      // Fetched once for the whole page rather than per row.
      supabase.from("vizserve_pms_leave_types").select("id, label"),
      supabase.from("vizserve_pms_departments").select("id, name"),
    ]);

  const actors = people ?? [];

  /**
   * uuid → the name of the thing it points at.
   *
   * Without this the trail shows its own plumbing: an "Assignee id" cell
   * reading `2105d7f9-366e-…`, and a leave allocation whose nine rows are all
   * keyed by a leave type id. Both are answers to nobody's question.
   */
  const lookup: AuditLookup = {
    ...Object.fromEntries(actors.map((person) => [person.id, person.full_name])),
    ...Object.fromEntries((leaveTypes ?? []).map((type) => [type.id, type.label])),
    ...Object.fromEntries((departments ?? []).map((department) => [department.id, department.name])),
  };

  const total = count ?? 0;
  const rows: AuditEntry[] = (entries ?? []).map((entry) => {
    const hasBefore = isRecord(entry.before) && Object.keys(entry.before).length > 0;
    const hasAfter = isRecord(entry.after) && Object.keys(entry.after).length > 0;

    // The shape is read off the PAYLOAD, not off the action string. `created`
    // is not the only action that records one side — `submitted`, `punch_in`
    // and `deleted` all do — and an action-name check would have to be kept in
    // step with every migration that adds one.
    const shape = !hasBefore && !hasAfter ? "empty" : hasBefore && hasAfter ? "diff" : hasBefore ? "deleted" : "created";

    return {
      id: entry.id,
      entity_type: entry.entity_type,
      entity_id: entry.entity_id,
      action: entry.action,
      action_label: auditActionLabel(entry.action),
      entity_label: auditEntityLabel(entry.entity_type),
      // Null actor is the system — the Phase 4 auto-complete cron, or a client
      // acting through a token with no account. Both are real; neither is a gap.
      actor_name: entry.actor_id ? (lookup[entry.actor_id] ?? null) : null,
      when: formatDateTime(entry.created_at),
      shape,
      // Flattened and formatted HERE. The dialog is a client component and the
      // lookup is a database read; shipping the map to the browser once per row
      // would send the same names twenty times to do work the server has
      // already done.
      fields: auditFields(entry.before, entry.after, lookup),
    };
  });

  const isFiltered = Boolean(term) || Boolean(entity) || Boolean(actor) || period !== DEFAULT_PERIOD;

  function hrefFor(target: number) {
    const next = new URLSearchParams();
    if (term) next.set("q", term);
    if (entity) next.set("entity", entity);
    if (actor) next.set("actor", actor);
    if (period !== DEFAULT_PERIOD) next.set("period", period);
    // Defaults stay out of the URL, so the everyday link is just /admin/audit.
    if (pageSize !== PAGE_SIZES[0]) next.set("size", String(pageSize));
    if (target > 1) next.set("page", String(target));
    const query = next.toString();
    return query ? `/admin/audit?${query}` : "/admin/audit";
  }

  const columns: Column<AuditEntry>[] = [
    {
      key: "when",
      header: "When",
      className: "whitespace-nowrap text-xs text-muted-foreground tabular-nums",
      cell: (entry) => entry.when,
    },
    {
      key: "who",
      header: "Who",
      className: "whitespace-nowrap",
      cell: (entry) =>
        entry.actor_name ? (
          <span className="text-sm">{entry.actor_name}</span>
        ) : (
          // Italic AND worded, not a grey dash: an entry with no actor is a
          // statement (the cron did this), not a missing value, and the two must
          // not look the same on a page people read for accountability.
          <span className="text-sm text-muted-foreground italic">System</span>
        ),
    },
    {
      key: "action",
      header: "Action",
      cell: (entry) => <Chip tone={auditActionTone(entry.action)} label={entry.action_label} />,
    },
    {
      key: "record",
      header: "Record",
      className: "whitespace-nowrap",
      cell: (entry) => {
        const href = auditEntityHref(entry.entity_type, entry.entity_id);
        const label = auditEntityLabel(entry.entity_type);

        // Linked only where a detail route exists. A link to a page that does
        // not exist is worse than plain text, and the map in lib/audit.ts is
        // the one place to extend when a route lands.
        return href ? (
          <Link href={href} className="text-sm text-primary hover:underline">
            {label}
          </Link>
        ) : (
          <span className="text-sm">{label}</span>
        );
      },
    },
    {
      key: "changes",
      header: "Changed",
      className: "hidden lg:table-cell max-w-xs whitespace-normal text-xs text-muted-foreground",
      cell: (entry) => {
        // The LEAF names, so a leave allocation change reads "Vacation Leave"
        // rather than "Allocations" — the field that moved, not the container
        // it moved inside. The group is on the dialog's rows, where there is
        // room for it.
        const names = entry.fields.filter((field) => field.changed).map((field) => field.label);
        if (names.length === 0) return <span className="text-foreground-faint">—</span>;

        // Three then a count. The user editor writes eight fields and the leave
        // allocation one writes nine — listing all of them turns a scannable
        // column into a paragraph, and the dialog is one click away.
        const shown = names.slice(0, 3).join(", ");
        return names.length > 3 ? `${shown} +${names.length - 3} more` : shown;
      },
    },
    {
      key: "details",
      header: <span className="sr-only">Details</span>,
      align: "end",
      className: "w-px whitespace-nowrap",
      cell: (entry) => <AuditDetails entry={entry} />,
    },
  ];

  return (
    <PageShell>
      {/* No <h1> — the breadcrumb says "Admin / Audit trail". This paragraph
          carries the two things the table cannot: that the record is written by
          the database rather than by this screen, and that it is append-only. */}
      <p className="text-xs text-muted-foreground">
        Every change the app makes, as it was recorded at the time — who did it, what moved, and
        what the values were before and after.{" "}
        <strong className="font-medium text-foreground">Nothing here can be edited.</strong> Entries
        are written by the database as changes happen, and there is no delete path for them.
      </p>

      {error ? (
        <QueryError what="the audit trail" message={error.message} />
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <ListSearch
              initial={term}
              basePath="/admin/audit"
              id="audit-search"
              placeholder="Action, or paste a record id"
              className="w-full sm:w-64 lg:w-72"
            />

            <AuditFilters entity={entity} actor={actor} period={period} actors={actors} />
          </div>

          {/* The readout for the filters directly above it. The window is named
              even when nothing else is filtering, because "412 entries" without
              "in the last 30 days" is a number that means the wrong thing. */}
          <p className="-mt-1 text-xs text-muted-foreground">
            <span className="tabular-nums">{total}</span> {total === 1 ? "entry" : "entries"}
            {term ? <> matching &ldquo;{term}&rdquo;</> : null}
            {period === "all" ? " in total" : ` in the last ${period} days`}
          </p>

          <DataTable
            columns={columns}
            rows={rows}
            getRowKey={(entry) => entry.id}
            empty={
              isFiltered ? (
                <EmptyState
                  icon={<SearchX />}
                  title="Nothing matches those filters"
                  description="Widen the period first — the trail opens on the last 30 days, and older entries are still there. Search covers the action and the record type, or paste a record id to see one record's history."
                  action={
                    // A link, not a Button — this navigates, and Button here no
                    // longer supports asChild.
                    <Link
                      href="/admin/audit"
                      className={buttonVariants({ variant: "outline", size: "sm" })}
                    >
                      Clear filters
                    </Link>
                  }
                />
              ) : (
                <EmptyState
                  icon={<History />}
                  title="Nothing recorded yet"
                  description="Entries appear here as people work — an account edited, a request approved, a task deleted. On a new install there is genuinely nothing to show."
                />
              )
            }
          />

          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            hrefFor={hrefFor}
            basePath="/admin/audit"
          />
        </>
      )}
    </PageShell>
  );
}
