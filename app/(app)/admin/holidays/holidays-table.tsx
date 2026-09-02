"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarOff, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button, buttonVariants } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataTable, type Column } from "@/components/data-table";
import { DataTableColumns, useColumnVisibility } from "@/components/data-table-columns";
import { EmptyState } from "@/components/empty-state";
import { formatDate } from "@/lib/dates";
import { isClosedYear } from "@/lib/schemas/holidays";

import { createHoliday, deleteHoliday, renameHoliday } from "./actions";

export type Holiday = { holiday_date: string; name: string; created_at: string };

/** `2027-01-01` → `Friday`. The weekday is why an admin is checking the list. */
function weekdayOf(holidayDate: string): string {
  const [year, month, day] = holidayDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
}

/** Saturday or Sunday. Legal, and worth pointing out — see the column comment. */
function fallsOnWeekend(holidayDate: string): boolean {
  const [year, month, day] = holidayDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * P7-35 — the holiday list for one year.
 *
 * Server-rendered per year rather than filtered in the browser, unlike the user
 * table beside it. That table is bounded — the staff of one company, a few dozen
 * rows — and this one is not: it grows by roughly twenty rows a year forever, so
 * the year lives in the URL and the query does the narrowing.
 */
export function HolidaysTable({
  holidays,
  year,
  currentYear,
}: {
  holidays: Holiday[];
  year: number;
  /** Manila's year, from the server. Decides which years read as closed. */
  currentYear: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<Holiday | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [removing, setRemoving] = useState<Holiday | undefined>();
  const [pendingDelete, startDelete] = useTransition();

  const closed = year < currentYear;

  const weekendCount = useMemo(
    () => holidays.filter((holiday) => fallsOnWeekend(holiday.holiday_date)).length,
    [holidays],
  );

  function openCreate() {
    setEditing(undefined);
    setEditorOpen(true);
  }

  function openEdit(holiday: Holiday) {
    setEditing(holiday);
    setEditorOpen(true);
  }

  function confirmDelete() {
    if (!removing) return;

    startDelete(async () => {
      const result = await deleteHoliday({ holiday_date: removing.holiday_date });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(`${removing.name} removed from the calendar.`);
      setRemoving(undefined);
      router.refresh();
    });
  }

  const columns: Column<Holiday>[] = [
    {
      key: "date",
      sortKey: "date",
      header: "Date",
      cell: (holiday) => (
        <>
          <div className="font-medium tabular-nums">{formatDate(holiday.holiday_date)}</div>
          <div className="text-xs text-muted-foreground">{weekdayOf(holiday.holiday_date)}</div>
        </>
      ),
    },
    {
      key: "name",
      sortKey: "name",
      header: "Holiday",
      cell: (holiday) => holiday.name,
    },
    {
      key: "effect",
      header: "Effect",
      className: "hidden md:table-cell",
      // A holiday on a Saturday is perfectly legal and changes nothing, because
      // the weekend was already not a working day. Saying so stops an admin
      // concluding the entry failed to take — and stops anyone expecting a leave
      // request to get a day shorter when it will not.
      cell: (holiday) =>
        fallsOnWeekend(holiday.holiday_date) ? (
          <span className="text-xs text-muted-foreground">
            Falls on a weekend — no change to leave or deadlines
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">Skipped by leave and deadlines</span>
        ),
    },
    {
      /*
       * P7-66. The weekday already sits under the date — it is why an admin
       * opens this list at all — so the only fact this table was not showing is
       * WHEN a holiday was declared. Useful when a date appears that nobody
       * remembers agreeing to.
       */
      key: "added",
      sortKey: "added",
      header: "Added",
      hideable: true,
      defaultHidden: true,
      className: "hidden lg:table-cell whitespace-nowrap text-muted-foreground tabular-nums",
      cell: (holiday) => formatDate(holiday.created_at),
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (holiday) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => openEdit(holiday)}>
            <Pencil />
            <span className="sr-only">Rename {holiday.name}</span>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(holiday)}>
            <Trash2 />
            <span className="sr-only">Remove {holiday.name}</span>
          </Button>
        </div>
      ),
    },
  ];

  const { visibility, onVisibilityChange } = useColumnVisibility("admin-holidays", columns);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {/* Real links, not buttons. The year is in the URL so the view is
            linkable, and a link is what lets an admin open 2027 in a second tab
            beside the proclamation they are checking it against. */}
        <div className="flex items-center gap-1.5">
          <Link
            href={`/admin/holidays?year=${year - 1}`}
            aria-label={`Go to ${year - 1}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronLeft />
          </Link>
          <span className="min-w-14 text-center text-sm font-semibold tabular-nums">{year}</span>
          <Link
            href={`/admin/holidays?year=${year + 1}`}
            aria-label={`Go to ${year + 1}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronRight />
          </Link>
        </div>

        <p className="text-xs text-muted-foreground">
          {holidays.length} {holidays.length === 1 ? "day" : "days"}
          {weekendCount > 0 ? `, ${weekendCount} on a weekend` : ""}
        </p>

        <Button size="sm" className="shrink-0 sm:ml-auto" onClick={openCreate}>
          <Plus />
          Add holiday
        </Button>
      </div>

      {/* The warning that matters, and it is shown on the LIST rather than only
          in the dialog — an admin who has navigated to a closed year should know
          before they start editing, not after they have pressed Save. */}
      {closed ? (
        <p
          role="note"
          className="rounded-sm border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning"
        >
          {year} has closed. Leave figures for that year are worked out from this calendar every
          time they are read, so changing a date here moves used and unused days that have already
          been reported — and possibly paid. Every change is written to the audit log.
        </p>
      ) : null}

      <div className="flex justify-end">
        <DataTableColumns
          columns={columns}
          visibility={visibility}
          onVisibilityChange={onVisibilityChange}
        />
      </div>

      <DataTable
        columnVisibility={visibility}
        onColumnVisibilityChange={onVisibilityChange}
        columns={columns}
        rows={holidays}
        getRowKey={(holiday) => holiday.holiday_date}
        empty={
          <EmptyState
            icon={<CalendarOff />}
            title={`No holidays set for ${year}`}
            description={
              year > currentYear
                ? "Philippine holidays are proclaimed annually, so next year's list has to be entered by hand once it is published."
                : "Add the regular holidays and any special non-working days. Until they are here, leave requests count those days as worked."
            }
          />
        }
      />

      <HolidayEditor
        holiday={editing}
        year={year}
        currentYear={currentYear}
        open={editorOpen}
        onOpenChange={setEditorOpen}
      />

      <Dialog
        open={Boolean(removing)}
        onOpenChange={(next) => {
          if (!next) setRemoving(undefined);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove this holiday?</DialogTitle>
            <DialogDescription>
              {removing ? `${removing.name} — ${formatDate(removing.holiday_date)}.` : ""}
            </DialogDescription>
          </DialogHeader>

          {/* Says what actually happens, not "this cannot be undone". It CAN be
              undone — add it back — and the consequence worth naming is the one
              nobody expects: approved leave spanning that date gets a day longer. */}
          <p className="text-sm text-muted-foreground">
            Everybody will be scheduled to work that day. Leave already approved across it will
            count one working day more, which changes used and unused figures for{" "}
            {removing ? removing.holiday_date.slice(0, 4) : "that year"}.
            {removing && isClosedYear(removing.holiday_date, currentYear)
              ? " That year has closed, so those figures have already been reported."
              : ""}
          </p>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(undefined)} disabled={pendingDelete}>
              Cancel
            </Button>
            <Button variant="destructive" loading={pendingDelete} onClick={confirmDelete}>
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function HolidayEditor({
  holiday,
  year,
  currentYear,
  open,
  onOpenChange,
}: {
  /** Absent for create. */
  holiday?: Holiday;
  year: number;
  currentYear: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Keyed and unmounted while closed, so the form state is SEEDED rather
            than SYNCED — the same reason `UserEditor` does it. Editing one
            holiday and then another otherwise leaves the first one's name in the
            field for a frame, and that stale value is what saves if the admin is
            quick. */}
        {open ? (
          <HolidayForm
            key={holiday?.holiday_date ?? "new"}
            holiday={holiday}
            year={year}
            currentYear={currentYear}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function HolidayForm({
  holiday,
  year,
  currentYear,
  onDone,
}: {
  holiday?: Holiday;
  year: number;
  currentYear: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Seeded to the first of the year being viewed, so adding January's holidays
  // to 2027 does not start the picker in whatever month today happens to be.
  const [date, setDate] = useState<string | null>(holiday?.holiday_date ?? `${year}-01-01`);
  const [name, setName] = useState(holiday?.name ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function submit() {
    setFormError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = holiday
        ? // The date is not sent as editable — see `updateHolidaySchema`. Moving
          // a wrongly-entered date is a delete and an add, because that is what
          // it is.
          await renameHoliday({ holiday_date: holiday.holiday_date, name })
        : await createHoliday({ holiday_date: date ?? "", name });

      if (!result.ok) {
        setFormError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      toast.success(holiday ? "Holiday renamed" : "Holiday added");
      onDone();
      router.refresh();
    });
  }

  const closedYear = isClosedYear(holiday?.holiday_date ?? date ?? `${year}-01-01`, currentYear);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{holiday ? "Rename holiday" : "Add a holiday"}</DialogTitle>
        <DialogDescription>
          Nobody is scheduled to work on this day, and leave requests skip it.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        {holiday ? (
          <div className="space-y-1">
            <Label>Date</Label>
            <p className="text-sm tabular-nums">{formatDate(holiday.holiday_date)}</p>
            {/* Not an oversight — see lib/schemas/holidays.ts. */}
            <p className="text-xs text-muted-foreground">
              Not editable. The date is what identifies a holiday, so moving one is a remove and an
              add rather than an edit — and the audit log should say so.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="holiday_date">Date</Label>
            <DatePicker
              id="holiday_date"
              value={date}
              onChange={setDate}
              clearable={false}
              invalid={Boolean(fieldErrors.holiday_date)}
            />
            {fieldErrors.holiday_date ? (
              <p className="text-xs text-destructive">{fieldErrors.holiday_date[0]}</p>
            ) : null}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="holiday_name">Name</Label>
          <Input
            id="holiday_name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Araw ng Kagitingan"
            aria-invalid={Boolean(fieldErrors.name)}
          />
          {fieldErrors.name ? (
            <p className="text-xs text-destructive">{fieldErrors.name[0]}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Everybody sees this on the shared calendar.
            </p>
          )}
        </div>

        {closedYear ? (
          <p
            role="note"
            className="rounded-sm border border-warning-border bg-warning-subtle px-3 py-2 text-xs text-warning"
          >
            This is in a year that has closed. Leave figures for it are recalculated from this
            calendar on every read, so a change here moves days already reported.
          </p>
        ) : null}

        {formError ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {formError}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button onClick={submit} loading={pending}>
          {holiday ? "Save name" : "Add holiday"}
        </Button>
      </DialogFooter>
    </>
  );
}
