"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { DataTable, type Column } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { formatDate } from "@/lib/dates";
import {
  EVENT_CATEGORIES,
  EVENT_CATEGORY_LABELS,
  EVENT_CATEGORY_TONE,
  eventScopeLabel,
  type EventCategory,
} from "@/lib/schemas/events";
import { cn } from "@/lib/utils";

import { createEvent, deleteEvent, updateEvent } from "./actions";

export type Department = { id: string; name: string };

export type EventRecord = {
  id: string;
  title: string;
  description: string | null;
  category: EventCategory;
  department_id: string | null;
  start_date: string;
  end_date: string;
};

/** `12 Mar 2027`, or `12 – 14 Mar 2027` for a span. */
function formatSpan(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

/**
 * P7-46 — the event list for one year.
 *
 * Server-rendered per year like the holiday list beside it, and for the same
 * reason: this table grows forever, so the year lives in the URL and the query
 * does the narrowing rather than the browser.
 */
export function EventsTable({
  events,
  departments,
  year,
  currentYear,
}: {
  events: EventRecord[];
  departments: Department[];
  year: number;
  currentYear: number;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<EventRecord | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [removing, setRemoving] = useState<EventRecord | undefined>();
  const [pendingDelete, startDelete] = useTransition();

  const departmentName = new Map(departments.map((d) => [d.id, d.name]));

  function openCreate() {
    setEditing(undefined);
    setEditorOpen(true);
  }

  function confirmDelete() {
    if (!removing) return;

    startDelete(async () => {
      const result = await deleteEvent({ id: removing.id });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(`${removing.title} removed from the calendar.`);
      setRemoving(undefined);
      router.refresh();
    });
  }

  const columns: Column<EventRecord>[] = [
    {
      key: "when",
      header: "When",
      cell: (event) => (
        <div className="font-medium tabular-nums whitespace-nowrap">
          {formatSpan(event.start_date, event.end_date)}
        </div>
      ),
    },
    {
      key: "event",
      header: "Event",
      cell: (event) => (
        <>
          <div className="font-medium">{event.title}</div>
          {event.description ? (
            <div className="mt-0.5 max-w-md truncate text-xs text-muted-foreground">
              {event.description}
            </div>
          ) : null}
        </>
      ),
    },
    {
      key: "category",
      header: "Category",
      // The pill carries its own LABEL, not just the tone — state is never
      // conveyed by colour alone, and this is the swatch the calendar legend
      // has to match.
      cell: (event) => {
        const tone = EVENT_CATEGORY_TONE[event.category];
        return (
          <span
            className={cn(
              "inline-flex rounded-full border px-2 py-0.5 text-2xs font-medium",
              tone.surface,
              tone.border,
              tone.text,
            )}
          >
            {eventScopeLabel(event.category, departmentName.get(event.department_id ?? ""))}
          </span>
        );
      },
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (event) => (
        <div className="flex justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => {
              setEditing(event);
              setEditorOpen(true);
            }}
          >
            <Pencil />
            <span className="sr-only">Edit {event.title}</span>
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => setRemoving(event)}>
            <Trash2 />
            <span className="sr-only">Remove {event.title}</span>
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {/* Real links, so the year is shareable — an admin can send somebody
            next year's calendar rather than describing it. */}
        <div className="flex items-center gap-1.5">
          <Link
            href={`/admin/events?year=${year - 1}`}
            aria-label={`Go to ${year - 1}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronLeft />
          </Link>
          <span className="min-w-14 text-center text-sm font-semibold tabular-nums">{year}</span>
          <Link
            href={`/admin/events?year=${year + 1}`}
            aria-label={`Go to ${year + 1}`}
            className={buttonVariants({ variant: "outline", size: "icon-sm" })}
          >
            <ChevronRight />
          </Link>
        </div>

        <p className="text-xs text-muted-foreground">
          {events.length} {events.length === 1 ? "event" : "events"}
        </p>

        <Button size="sm" className="shrink-0 sm:ml-auto" onClick={openCreate}>
          <Plus />
          Add event
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={events}
        getRowKey={(event) => event.id}
        empty={
          <EmptyState
            icon={<CalendarDays />}
            title={`Nothing scheduled for ${year}`}
            description={
              year > currentYear
                ? "Next year's calendar is empty. Add the fixed dates — the Christmas party, the planning offsite — as soon as they are agreed."
                : "Town halls, offsites, team lunches. Everyone sees these on the shared calendar, colour-coded by category."
            }
          />
        }
      />

      <EventEditor
        event={editing}
        departments={departments}
        year={year}
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
            <DialogTitle>Remove this event?</DialogTitle>
            <DialogDescription>
              {removing ? `${removing.title} — ${formatSpan(removing.start_date, removing.end_date)}.` : ""}
            </DialogDescription>
          </DialogHeader>

          {/* Plainly stated, and deliberately NOT the warning the holiday
              version carries. Removing a holiday rewrites leave figures that
              may already have been reported; removing an event takes a thing
              off a calendar and changes no number anywhere. */}
          <p className="text-sm text-muted-foreground">
            It disappears from everyone&rsquo;s calendar. Nothing else changes — events do not
            affect leave counts or client deadlines.
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

function EventEditor({
  event,
  departments,
  year,
  open,
  onOpenChange,
}: {
  event?: EventRecord;
  departments: Department[];
  year: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        {/* Keyed and unmounted while closed so the form state is SEEDED rather
            than SYNCED — the same reason `UserEditor` and `HolidayEditor` do it.
            Editing one event then another otherwise leaves the first one's title
            in the field for a frame, and that stale value is what saves. */}
        {open ? (
          <EventForm
            key={event?.id ?? "new"}
            event={event}
            departments={departments}
            year={year}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function EventForm({
  event,
  departments,
  year,
  onDone,
}: {
  event?: EventRecord;
  departments: Department[];
  year: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [category, setCategory] = useState<EventCategory>(event?.category ?? "COMPANY");
  const [departmentId, setDepartmentId] = useState<string | null>(event?.department_id ?? null);
  // Seeded to the first of the year being viewed, so adding January's events to
  // next year does not start the picker in whatever month today happens to be.
  const [startDate, setStartDate] = useState<string | null>(event?.start_date ?? `${year}-01-01`);
  const [endDate, setEndDate] = useState<string | null>(event?.end_date ?? `${year}-01-01`);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const categoryItems = Object.fromEntries(
    EVENT_CATEGORIES.map((option) => [option, EVENT_CATEGORY_LABELS[option].label]),
  );
  const departmentItems = Object.fromEntries(departments.map((d) => [d.id, d.name]));

  const needsDepartment = category === "DEPARTMENT";

  function submit() {
    setFormError(null);
    setFieldErrors({});

    const payload = {
      title,
      description,
      category,
      // Dropped for the other two categories rather than sent and refused: a
      // stale department left over from switching category is the form's fault,
      // not the admin's, and the server coerces it away too.
      department_id: needsDepartment ? departmentId : null,
      start_date: startDate ?? "",
      end_date: endDate ?? "",
    };

    startTransition(async () => {
      const result = event
        ? await updateEvent({ ...payload, id: event.id })
        : await createEvent(payload);

      if (!result.ok) {
        setFormError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      toast.success(event ? "Event updated" : "Event added");
      onDone();
      router.refresh();
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>{event ? "Edit event" : "Add an event"}</DialogTitle>
        <DialogDescription>
          Everyone sees this on the shared calendar. It is not a day off.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="event_title">Title</Label>
          <Input
            id="event_title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Year-end party"
            aria-invalid={Boolean(fieldErrors.title)}
          />
          {fieldErrors.title ? (
            <p className="text-xs text-destructive">{fieldErrors.title[0]}</p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="event_category">Category</Label>
          <Select
            items={categoryItems}
            value={category}
            onValueChange={(value) => value !== null && setCategory(value as EventCategory)}
          >
            <SelectTrigger id="event_category" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EVENT_CATEGORIES.map((option) => (
                <SelectItem key={option} value={option}>
                  {EVENT_CATEGORY_LABELS[option].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{EVENT_CATEGORY_LABELS[category].hint}</p>
        </div>

        {/* Only for a department event. Rendered conditionally rather than
            disabled: a greyed-out select still reads as a thing you were
            supposed to fill in. */}
        {needsDepartment ? (
          <div className="space-y-2">
            <Label htmlFor="event_department">Which department</Label>
            <Select
              items={departmentItems}
              value={departmentId}
              onValueChange={(value) => value !== null && setDepartmentId(value)}
            >
              <SelectTrigger id="event_department" className="w-full">
                <SelectValue placeholder="Choose one…" />
              </SelectTrigger>
              <SelectContent>
                {departments.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fieldErrors.department_id ? (
              <p className="text-xs text-destructive">{fieldErrors.department_id[0]}</p>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="event_start">Starts</Label>
            <DatePicker
              id="event_start"
              value={startDate}
              onChange={(value) => {
                setStartDate(value);
                // Drag the end along rather than leaving an invalid pair the
                // admin has to notice and fix. Only when it would go backwards.
                if (value && endDate && endDate < value) setEndDate(value);
              }}
              clearable={false}
              invalid={Boolean(fieldErrors.start_date)}
            />
            {fieldErrors.start_date ? (
              <p className="text-xs text-destructive">{fieldErrors.start_date[0]}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="event_end">Ends</Label>
            <DatePicker
              id="event_end"
              value={endDate}
              onChange={setEndDate}
              min={startDate ?? undefined}
              clearable={false}
              invalid={Boolean(fieldErrors.end_date)}
            />
            <p className="text-xs text-muted-foreground">
              Same day for a one-day event.
            </p>
            {fieldErrors.end_date ? (
              <p className="text-xs text-destructive">{fieldErrors.end_date[0]}</p>
            ) : null}
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="event_description">Description</Label>
          <Textarea
            id="event_description"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional — a venue, a time, who to ask."
          />
          {fieldErrors.description ? (
            <p className="text-xs text-destructive">{fieldErrors.description[0]}</p>
          ) : null}
        </div>

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
          {event ? "Save changes" : "Add event"}
        </Button>
      </DialogFooter>
    </>
  );
}
