import type { Metadata } from "next";
import { Clock } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import {
  addDays,
  formatAppTime,
  formatDate,
  formatDuration,
  todayInAppZone,
  workedMinutes,
} from "@/lib/dates";
import { loadPunchState } from "@/lib/dtr-server";
import { createClient } from "@/utils/supabase/server";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { PageShell } from "@/components/page-shell";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { DtrToolbar } from "./dtr-toolbar";
import { PunchPanel } from "./punch-panel";

export const metadata: Metadata = { title: "DTR" };

/**
 * P5-04 — the daily time record.
 *
 * "Default view nyan, pag-click, is yung list view lang ng mga time in, time
 * out" (Amier, 19:10). A list of days, not a calendar and not a chart — this is
 * the screen someone opens to check whether yesterday recorded properly.
 *
 * SCOPE IS RLS'S JOB. This query carries no department filter and no
 * `user_id = me` clause: the policy returns your own rows plus your team's if
 * you lead one. Restating that here would imply the policy is optional, and
 * would drift from it the first time either changed.
 */
export default async function DtrPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; user?: string }>;
}) {
  const context = await requireAuthContext();
  const params = await searchParams;
  const supabase = await createClient();

  const today = todayInAppZone();
  // Default to the last 30 days rather than the calendar month: on the 1st, a
  // month-to-date view is one row and looks broken.
  const from = params.from ?? addDays(today, -29)!;
  const to = params.to ?? today;
  const selectedUser = params.user ?? null;

  const isLead = roleAtLeast(context.role, "team_leader");

  const [punchState, entriesResult, peopleResult] = await Promise.all([
    loadPunchState(context.userId),
    (() => {
      let query = supabase
        .from("vizserve_pms_dtr_entries")
        .select(
          "id, work_date, time_in, time_out, corrected_at, user_id, vizserve_pms_users!inner(full_name)",
        )
        .gte("work_date", from)
        .lte("work_date", to)
        .order("work_date", { ascending: false })
        .limit(500);

      if (selectedUser) query = query.eq("user_id", selectedUser);
      return query;
    })(),
    // The picker only makes sense for someone who can see more than themselves.
    // Reads through the same RLS as the list, so it cannot offer a person whose
    // rows would then come back empty.
    isLead
      ? supabase
          .from("vizserve_pms_users")
          .select("id, full_name")
          .eq("is_active", true)
          .order("full_name")
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
  ]);

  type Entry = {
    id: string;
    work_date: string;
    time_in: string | null;
    time_out: string | null;
    corrected_at: string | null;
    user_id: string;
    vizserve_pms_users: { full_name: string } | null;
  };

  const entries = (entriesResult.data ?? []) as unknown as Entry[];
  const people = peopleResult.data ?? [];
  const showPerson = isLead && !selectedUser;

  const totalMinutes = entries.reduce(
    (sum, entry) => sum + (workedMinutes(entry.time_in, entry.time_out) ?? 0),
    0,
  );

  const columns: Column<Entry>[] = [
    {
      key: "date",
      header: "Date",
      className: "whitespace-nowrap",
      cell: (entry) => (
        <>
          {formatDate(entry.work_date)}
          {/* Provenance in words. A corrected time is a different fact from a
              punched one, and this is the row someone points at in a payroll
              dispute. */}
          {entry.corrected_at ? (
            <p className="mt-0.5 text-2xs font-medium text-info">Corrected</p>
          ) : null}
        </>
      ),
    },
    // Only when the list spans more than one person. A column of your own name
    // repeated forty times is a column carrying no information.
    ...(showPerson
      ? [
          {
            key: "person",
            header: "Person",
            cell: (entry: Entry) => entry.vizserve_pms_users?.full_name ?? "—",
          },
        ]
      : []),
    {
      key: "in",
      header: "Time in",
      className: "tabular-nums whitespace-nowrap",
      cell: (entry) => formatAppTime(entry.time_in),
    },
    {
      key: "out",
      header: "Time out",
      className: "tabular-nums whitespace-nowrap",
      cell: (entry) => (
        <>
          {formatAppTime(entry.time_out)}
          {Boolean(entry.time_in) && !entry.time_out ? (
            <p className="mt-0.5 text-2xs font-medium text-warning">Still open</p>
          ) : null}
        </>
      ),
    },
    {
      key: "worked",
      header: "Worked",
      className: "tabular-nums whitespace-nowrap",
      cell: (entry) => formatDuration(workedMinutes(entry.time_in, entry.time_out)),
    },
  ];

  return (
    <PageShell>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_1fr] lg:items-start">
        <PunchPanel initial={punchState} />

        <div className="space-y-4">
          <DtrToolbar
            people={people}
            from={from}
            to={to}
            userId={selectedUser}
            canExport={isLead}
          />

          <DataTable
            columns={columns}
            rows={entries}
            getRowKey={(entry) => entry.id}
            empty={
              <EmptyState
                icon={<Clock />}
                title="No entries in this range"
                description="Days with no punch have no row at all. Widen the date range first; if a day is genuinely missing that should not be, raise a No Time-In request from Approvals."
              />
            }
            footer={
              <TableRow className="hover:bg-transparent">
                <TableHead scope="row" colSpan={columns.length - 1}>
                  Total in range
                </TableHead>
                <TableCell className="font-semibold tabular-nums">
                  {formatDuration(totalMinutes)}
                </TableCell>
              </TableRow>
            }
          />

          {/* Kept from the old page heading. It is not decoration: it is why two
              punches on one day collapse into one row, which is the first thing
              anyone asks about their own record. */}
          <p className="text-xs text-muted-foreground">
            Times are captured by the server — the earliest time-in and the latest time-out for each
            day are what stand.
          </p>
        </div>
      </div>
    </PageShell>
  );
}
