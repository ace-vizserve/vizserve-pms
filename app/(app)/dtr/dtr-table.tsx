"use client";

import Link from "next/link";

import { DataTable, type Column } from "@/components/data-table";
import {
  useColumnVisibility,
} from "@/components/data-table-columns";
import { TableCell, TableHead, TableRow } from "@/components/ui/table";
import { InternalStatusBadge } from "@/components/status-badge";
import {
  formatAppTime,
  formatDate,
  formatDuration,
  workedMinutes,
} from "@/lib/dates";
import {
  correctionTypeFor,
  describeDeviation,
  type Deviation,
} from "@/lib/dtr-schedule";
import {
  INTERNAL_REQUEST_LABELS,
  isTimeCorrectionType,
  type TimeCorrectionType,
} from "@/lib/schemas/internal-requests";
import {
  describeLeaveDay,
  LEAVE_PORTION_LABELS,
  type LeaveDay,
} from "@/lib/leave";

/**
 * P7-64 — the columns, in a client component, because the table is one now.
 *
 * `cell` is a function and a function cannot cross the RSC boundary. This page
 * had the most tangled extraction of the eight: the row types were declared
 * inside the page function, `isMine` closed over the signed-in user, and
 * `CorrectionLink` sat at module scope beside them. All three moved here
 * together — `viewerId` arrives as a plain string, which is all `isMine` ever
 * needed.
 *
 * ⚠️ P7-65 — `urlSort` IS SET. The range is capped at `DTR_PAGE_SIZE + 1`, so
 * the page does not hold every day it is describing and the ordering has to
 * happen in Postgres. Date, time-in and time-out are sortable; the derived
 * columns (worked minutes, the request chips) are not, because neither exists
 * as a column to order by.
 */

export type PunchRow = {
  id: string;
  work_date: string;
  time_in: string | null;
  time_out: string | null;
  corrected_at: string | null;
  user_id: string;
  vizserve_pms_users: {
    full_name: string;
    /** P7-36. `HH:MM:SS` or null — normalised through `scheduleFor`. */
    work_start: string | null;
    work_end: string | null;
  } | null;
};

/** P7-40. A correction or an approved overtime filed against a day. */
export type DayRequest = {
  id: string;
  request_type: string;
  status: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  work_date: string | null;
  requester_id: string;
  correction_at: string | null;
  overtime_minutes: number | null;
};

/**
 * A row on this list is now either a punch or an approved absence.
 *
 * `leave` hangs off both. On a punched row it annotates — a half day worked
 * and half taken is ONE day and one row, and splitting it would make the
 * record show two entries for a date that only happened once. On a row with
 * no punch it is the whole reason the row exists.
 */
export type Entry = PunchRow & {
  leave: LeaveDay | null;
  isLeaveOnly: boolean;
  /** Every request filed against this person on this day, newest first. */
  requests: DayRequest[];
  /**
   * P7-40. How far off schedule the punches landed, once grace and approved
   * overtime are accounted for. Null in both slots is the ordinary case AND
   * the no-schedule case — deliberately indistinguishable here, because the
   * table has nothing to say about either.
   */
  deviationIn: Deviation | null;
  deviationOut: Deviation | null;
};

export function DtrTable({
  rows,
  viewerId,
  showPerson,
  empty,
  totalLabel,
  totalMinutes,
  className,
}: {
  rows: Entry[];
  /** Whose record this is being read by — `isMine` is the whole use. */
  viewerId: string;
  /** A lead reading the whole team gets a Person column; one person's own record does not. */
  showPerson: boolean;
  empty: React.ReactNode;
  /** "Total in range", or the truncated wording when the cap was hit. */
  totalLabel: string;
  totalMinutes: number;
  className?: string;
}) {
  const { visibility, onVisibilityChange } = useColumnVisibility("dtr");

  /*
   * OWN ROWS ONLY. The correction dialog submits as the signed-in person, so
   * offering the link on somebody else's row would open a form that can only
   * fail — RLS refuses it on arrival.
   */
  const isMine = (entry: Entry) => entry.user_id === viewerId;

  const columns: Column<Entry>[] = [
    {
      key: "date",
      pin: "left",
      sortKey: "date",
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
          {/* The absence, named. Colour alone would not do it here any more
              than it does on a status pill, and the portion matters: half a day
              off is a different fact from a whole one. */}
          {entry.leave ? (
            <p className="mt-0.5 text-2xs font-medium text-info">
              {entry.leave.portion === "full"
                ? "On leave"
                : `On leave · ${LEAVE_PORTION_LABELS[entry.leave.portion]}`}
              {entry.leave.typeNames.length > 0 ? (
                <span className="font-normal text-muted-foreground">
                  {" "}
                  {entry.leave.typeNames.join(", ")}
                </span>
              ) : null}
            </p>
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
      sortKey: "in",
      header: "Time in",
      className: "tabular-nums whitespace-nowrap",
      cell: (entry) => (
        <>
          {formatAppTime(entry.time_in)}
          {/* F — the route to the correction, from the row showing the problem.
              A row with no time-in is exactly the case NO_TIME_IN exists for.

              EXCEPT on a day somebody was approved to be away. Offering "Time-in
              missing?" there tells a person on holiday to file a correction for
              a gap that is not a gap — and a correction they should never file
              is worse than no link, because filing it puts a punch on a day they
              did not work. */}
          {!entry.time_in && !entry.isLeaveOnly && isMine(entry) ? (
            <CorrectionLink
              type="NO_TIME_IN"
              date={entry.work_date}
              label="Time-in missing?"
            />
          ) : null}
          {/* P7-40. The deviation, in words, on the number it describes. THE
              LABEL CARRIES THE STATE — an amber tint alone would leave a
              colour-blind reader with a time and no idea it was flagged. */}
          {entry.deviationIn ? (
            <p className="mt-0.5 text-2xs font-medium text-warning">
              {describeDeviation(entry.deviationIn)}
            </p>
          ) : null}
        </>
      ),
    },
    {
      key: "out",
      sortKey: "out",
      header: "Time out",
      className: "tabular-nums whitespace-nowrap",
      cell: (entry) => (
        <>
          {formatAppTime(entry.time_out)}
          {Boolean(entry.time_in) && !entry.time_out ? (
            <>
              <p className="mt-0.5 text-2xs font-medium text-warning">
                Still open
              </p>
              {/* This is the case the 18-hour stale-shift refusal already tells
                  people to fix, and until now it told them without giving them
                  any way to do it. */}
              {isMine(entry) ? (
                <CorrectionLink
                  type="NO_TIME_OUT"
                  date={entry.work_date}
                  label="Never timed out?"
                />
              ) : null}
            </>
          ) : null}
          {entry.deviationOut ? (
            <p className="mt-0.5 text-2xs font-medium text-warning">
              {describeDeviation(entry.deviationOut)}
            </p>
          ) : null}
        </>
      ),
    },
    /*
     * P7-40 — THE PAPERWORK ON THIS DAY.
     *
     * Placed BEFORE `worked` on purpose. The footer renders the range total in
     * the LAST cell and spans everything before it with
     * `colSpan={columns.length - 1}`; a column appended after `worked` would
     * quietly put the total under the wrong heading.
     *
     * What appears here is scoped by RLS, not by anything below. A member sees
     * only rows they filed; a team leader, manager or admin sees their
     * department's. There is no role check in this cell because there is no
     * role check in the query — the rows that arrive are already the rows this
     * viewer may see.
     */
    {
      key: "request",
      hideable: true,
      header: "Request",
      className: "whitespace-nowrap",
      cell: (entry) => {
        // Newest first, and at most two shown: a day realistically carries a
        // time-in correction and a time-out correction. More than that is a
        // person iterating on a request, and the detail page is where that
        // history belongs.
        const shown = entry.requests.slice(0, 2);

        if (shown.length > 0) {
          return (
            <div className="flex flex-col gap-1">
              {shown.map((request) => (
                <Link
                  key={request.id}
                  href={`/approvals/${request.id}`}
                  className="group flex items-center gap-1.5 text-2xs underline-offset-2 hover:underline"
                >
                  <InternalStatusBadge status={request.status} />
                  <span className="text-muted-foreground group-hover:text-foreground">
                    {INTERNAL_REQUEST_LABELS[
                      request.request_type as keyof typeof INTERNAL_REQUEST_LABELS
                    ] ?? request.request_type}
                    {/* What it is asking for, so a lead can compare the claim
                        against the recorded time without opening it. */}
                    {isTimeCorrectionType(request.request_type) &&
                    request.correction_at
                      ? ` · ${formatAppTime(request.correction_at)}`
                      : null}
                    {request.request_type === "OVERTIME" &&
                    request.overtime_minutes
                      ? ` · ${formatDuration(request.overtime_minutes)}`
                      : null}
                  </span>
                </Link>
              ))}
              {entry.requests.length > shown.length ? (
                <span className="text-2xs text-muted-foreground">
                  +{entry.requests.length - shown.length} more
                </span>
              ) : null}
            </div>
          );
        }

        /*
         * Nothing filed yet, and the row is off schedule — so offer the fix.
         *
         * OWN ROWS ONLY, for the reason `isMine` documents: the submit function
         * resolves the requester from the caller, so a lead clicking this on a
         * member's row would file a correction against their own record.
         *
         * The time carried in the URL is the SCHEDULED one, which is a
         * suggestion the dialog leaves editable — not a claim. See
         * `narrowRequestPrefill`.
         */
        const pending = entry.deviationIn ?? entry.deviationOut;

        if (pending && isMine(entry)) {
          return (
            <CorrectionLink
              type={correctionTypeFor(pending.side)}
              date={entry.work_date}
              time={pending.scheduled}
              label="Request correction"
            />
          );
        }

        return <span className="text-muted-foreground">—</span>;
      },
    },
    {
      key: "worked",
      hideable: true,
      header: "Worked",
      className: "tabular-nums whitespace-nowrap",
      // A leave-only row has no hours and never will. "—" would read as a day
      // that recorded nothing, which is precisely the confusion this row exists
      // to end, so it says what the day was instead.
      cell: (entry) =>
        entry.isLeaveOnly ? (
          <span className="text-2xs text-muted-foreground">
            {entry.leave ? describeLeaveDay(entry.leave) : "On leave"}
          </span>
        ) : (
          formatDuration(workedMinutes(entry.time_in, entry.time_out))
        ),
    },
  ];

  return (
    <DataTable
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
        className={className}
        columns={columns}
        rows={rows}
        getRowKey={(entry) => entry.id}
        /* The range is capped at DTR_PAGE_SIZE, so the browser must not pretend
         to order days it never received. */
        urlSort
        /* The order the page has ALREADY applied when the URL names none —
           `DTR_DEFAULT_SORT` in page.tsx, and the two have to move together.
           It never reaches the query string; it stops the Date header drawing
           the neutral glyph over rows that are plainly newest-first, and seeds
           the toggle so the first click REVERSES the order rather than
           re-requesting the one on screen. */
        defaultSort={{ key: "date", dir: "desc" }}
        empty={empty}
        footer={
          <TableRow className="hover:bg-transparent">
            {/* `columns.length - 1` is why the footer lives in here: the page has
              no way to know how many columns were drawn once `showPerson`
              started adding one conditionally. */}
            <TableHead scope="row" colSpan={columns.length - 1}>
              {totalLabel}
            </TableHead>
            <TableCell className="font-semibold tabular-nums">
              {formatDuration(totalMinutes)}
            </TableCell>
          </TableRow>
        }
      />
  );
}

function CorrectionLink({
  type,
  date,
  time,
  label,
}: {
  /**
   * P7-39 widened this from the missing-punch pair. The four types differ in
   * what they claim, not in what this link does with them — narrowing happens
   * again on arrival, so an unknown value opens the plain dialog.
   */
  type: TimeCorrectionType;
  date: string;
  /** P7-40. The scheduled time, prefilled as a SUGGESTION the dialog keeps editable. */
  time?: string;
  label: string;
}) {
  return (
    <Link
      href={`/approvals?type=${type}&date=${date}${time ? `&time=${encodeURIComponent(time)}` : ""}`}
      className="mt-0.5 block text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
    >
      {label}
      {/* The visible label is deliberately short enough to sit in a numeric
          column; the full sentence is here for anyone who cannot see which row
          it belongs to. */}
      <span className="sr-only">
        {" "}
        Raise a correction for {formatDate(date)}.
      </span>
    </Link>
  );
}
