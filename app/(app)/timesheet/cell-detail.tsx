"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlignLeft, Clock, MessageSquareText, Plus, Timer, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TimePicker } from "@/components/ui/time-picker";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDate, formatWeekday } from "@/lib/dates";
import { formatCellDuration, minutesBetween, parseCellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { deleteTimeEntry, logTime, updateTimeEntry } from "./actions";
import type { CellEntry } from "./week-grid";

/**
 * What a cell cannot say on its own.
 *
 * A grid cell holds one number, and this table deliberately holds more than one
 * fact per cell: the migration allows several entries per task per day BECAUSE
 * the notes differ — "an hour before lunch and two after is two facts with two
 * notes". Summing them is right for reading and wrong for editing, so the split
 * lives here.
 *
 * This is therefore the ONLY editor for a cell holding more than one entry. The
 * cell itself goes read-only in that case rather than guessing which of the two
 * entries a newly typed number was meant to replace.
 */
export function CellDetail({
  open,
  onOpenChange,
  taskId,
  taskTitle,
  day,
  entries,
  locked = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  taskTitle: string;
  day: string;
  entries: CellEntry[];
  /**
   * P7-05 — the week has been handed in.
   *
   * This popover is the ONLY editor for a split cell, so it is also the only
   * way round a locked grid: the cell above goes read-only, and without this
   * the bin and the note field would still be sitting one click behind it. The
   * database refuses all three writes either way; this is about not offering
   * them.
   *
   * It still opens. Notes are why the popover exists, and a submitted week is
   * exactly when somebody goes back to read what they wrote.
   */
  locked?: boolean;
}) {
  const split = entries.length > 1;
  const noted = entries.some((entry) => entry.note);
  // P7-21. Times are the third thing a cell total cannot show, so they pin the
  // marker open for the same reason a note does — otherwise the only sign the
  // entry carries them is hovering the cell that hides them.
  const timed = entries.some((entry) => entry.started_at);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        // Hidden until the cell is hovered or focused, UNLESS it is carrying
        // something the sum does not show. Seven permanent buttons per row is
        // noise; a grid that silently hides a note is worse than noise.
        className={cn(
          "absolute top-0.5 right-0.5 flex h-4 min-w-4 items-center justify-center rounded px-0.5",
          "text-2xs leading-none font-medium text-muted-foreground",
          "hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          split || noted || timed
            ? "opacity-100"
            : "opacity-0 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100",
        )}
      >
        {split ? (
          entries.length
        ) : timed && !noted ? (
          <Clock className="size-3" />
        ) : (
          <MessageSquareText className="size-3" />
        )}
        <span className="sr-only">
          {taskTitle} — {formatWeekday(day)} {formatDate(day)}: notes, times and split entries
        </span>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-80">
        <PopoverHeader>
          <PopoverTitle className="truncate text-sm">{taskTitle}</PopoverTitle>
          <p className="text-xs text-muted-foreground">
            {formatWeekday(day)} · {formatDate(day)}
          </p>
        </PopoverHeader>

        {entries.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {entries.map((entry) => (
              <li key={entry.id}>
                <EntryRow entry={entry} taskId={taskId} day={day} locked={locked} />
              </li>
            ))}
          </ul>
        ) : null}

        {/* Above the form, not below it. `AddEntry` is pulled out to the
            popover's edges, so anything after it would sit under a full-bleed
            card and read as a footnote to the wrong thing.

            The locked sentence replaces the editing one rather than joining it:
            "edit them here" is false once the week is in. */}
        {locked ? (
          <p className="text-2xs text-muted-foreground">
            {split ? "The cell shows the total of these. " : null}
            Handed in — read-only until your lead decides.
          </p>
        ) : split ? (
          <p className="text-2xs text-muted-foreground">
            The cell shows the total of these. Edit them here.
          </p>
        ) : null}

        {locked ? null : <AddEntry taskId={taskId} day={day} />}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One entry, saved on blur.
 *
 * Blur rather than a Save button: this popover exists to fix a note or split an
 * hour in two, and a confirm step per row turns a ten-second correction into a
 * form. `dirty` is what stops the blur firing an identical UPDATE every time
 * somebody tabs through.
 */
function EntryRow({
  entry,
  taskId,
  day,
  locked,
}: {
  entry: CellEntry;
  taskId: string;
  day: string;
  locked: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [duration, setDuration] = useState(formatCellDuration(entry.minutes));
  const [note, setNote] = useState(entry.note ?? "");
  // P7-21. Empty string rather than null, because that is what an untouched
  // `<input type="time">` holds and a controlled input cannot take null.
  const [startTime, setStartTime] = useState(entry.started_at ?? "");
  const [endTime, setEndTime] = useState(entry.ended_at ?? "");

  /*
   * THE TIMES WIN WHEN BOTH ARE SET.
   *
   * `vizserve_pms_timesheet_entries_times_match_minutes` refuses a row whose
   * duration disagrees with its span, so the editor cannot offer two fields
   * that can disagree. When both times are present the length is derived and
   * the length field goes read-only; clearing either hands it back.
   *
   * This is the same move as deriving a task's department from its assignee:
   * remove the disagreement rather than validate it after the fact.
   */
  const timed = Boolean(startTime && endTime);
  const derived = timed ? minutesBetween(startTime, endTime) : null;
  const shownDuration = derived !== null && derived > 0 ? formatCellDuration(derived) : duration;

  function save() {
    // Belt and braces with the `readOnly` below: blur fires on a read-only
    // field too, and this is the one path in the app that can UPDATE an entry
    // inside a locked week.
    if (locked) return;

    // Half a pair is not a state the row can be saved in, and it is a state the
    // person is mid-way through typing — so it waits rather than complaining.
    if (Boolean(startTime) !== Boolean(endTime)) return;

    const minutes = derived ?? parseCellDuration(duration);

    if (minutes === null) {
      toast.error(`"${duration}" is not a length of time.`);
      setDuration(formatCellDuration(entry.minutes));
      return;
    }

    if (timed && minutes <= 0) {
      toast.error("The end time has to be after the start.");
      return;
    }

    // Zero here is a deletion typed into the wrong control. The bin is one
    // control away, and deleting on a cleared field is how somebody loses a
    // note they were halfway through rewriting.
    if (minutes === 0) {
      toast.error("Remove the entry with the bin, or give it a length.");
      setDuration(formatCellDuration(entry.minutes));
      return;
    }

    const nextNote = note.trim() ? note.trim() : null;
    const nextStart = startTime || null;
    const nextEnd = endTime || null;

    if (
      minutes === entry.minutes &&
      nextNote === entry.note &&
      nextStart === entry.started_at &&
      nextEnd === entry.ended_at
    ) {
      return;
    }

    startTransition(async () => {
      const result = await updateTimeEntry({
        id: entry.id,
        task_id: taskId,
        work_date: day,
        minutes,
        note: nextNote,
        started_at: nextStart,
        ended_at: nextEnd,
      });

      if (!result.ok) {
        toast.error(result.error);
        setDuration(formatCellDuration(entry.minutes));
        setNote(entry.note ?? "");
        setStartTime(entry.started_at ?? "");
        setEndTime(entry.ended_at ?? "");
        return;
      }

      router.refresh();
    });
  }

  // A locked week keeps its times on screen — they are part of the record — but
  // an empty pair of time inputs on a row that never had any is furniture.
  const showTimes = !locked || Boolean(entry.started_at);

  return (
    <div className="space-y-1.5">
    <div className="flex items-center gap-1.5">
      {/* `readOnly`, not `disabled`. A disabled input drops out of the tab order
          and is skipped by most screen readers — on a locked week these fields
          are the record, and the record has to stay readable. */}
      <Input
        value={shownDuration}
        disabled={pending}
        readOnly={locked || timed}
        aria-label="Length"
        title={timed ? "Worked out from the start and end times." : undefined}
        className={cn(
          "h-9 w-18 text-center tabular-nums",
          timed && "text-muted-foreground",
        )}
        onChange={(event) => setDuration(event.target.value)}
        onBlur={save}
      />
      <Input
        value={note}
        disabled={pending}
        readOnly={locked}
        placeholder={locked ? "" : "Note"}
        aria-label="Note"
        className="h-9 flex-1"
        onChange={(event) => setNote(event.target.value)}
        onBlur={save}
      />

      {/* The bin goes away entirely. Greying it out would leave the one control
          in this row whose whole meaning is "this is gone now" sitting on a week
          that cannot lose anything. */}
      {locked ? null : (
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await deleteTimeEntry(entry.id);
              if (!result.ok) {
                toast.error(result.error);
                return;
              }
              router.refresh();
            })
          }
        >
          <Trash2 />
          <span className="sr-only">Remove this entry</span>
        </Button>
      )}
    </div>

      {/* P7-21 — when in the day this happened. Optional, and indented under
          the row it belongs to rather than beside it: the length and the note
          are what most people came here for, and three controls on one line
          turns a quick correction into a form. */}
      {showTimes ? (
        <div className="flex items-center gap-1.5 pl-1 text-xs text-muted-foreground">
          <Clock className="size-3.5 shrink-0 text-foreground-faint" aria-hidden />
          <TimePicker
            size="sm"
            label="Start time"
            value={startTime}
            disabled={pending}
            readOnly={locked}
            onChange={(next) => setStartTime(next ?? "")}
            onBlur={save}
          />
          <span aria-hidden>–</span>
          <TimePicker
            size="sm"
            label="End time"
            value={endTime}
            disabled={pending}
            readOnly={locked}
            onChange={(next) => setEndTime(next ?? "")}
            onBlur={save}
          />
          {/* The one error the pair can be in that the person has to fix
              themselves. Everything else either waits (half a pair, mid-typing)
              or is derived. */}
          {timed && derived !== null && derived <= 0 ? (
            <span className="text-destructive">End must be after the start.</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What the field understood, in words.
 *
 * Kept beside the form rather than inside `parseCellDuration` because the
 * parser is the CONTRACT — it returns minutes or null and is shared with the
 * server action. This is presentation, and it is the only place that knows the
 * difference between "nothing typed yet" and "typed something that rounds to
 * nothing", which the parser deliberately collapses to 0.
 */
function describeDuration(raw: string): { text: string; tone: "ok" | "error" } {
  const minutes = parseCellDuration(raw);

  if (minutes === null) {
    // A colon is the one wrong answer worth naming, because it used to work and
    // because it is the reason it no longer does: `1:30` reads as one-thirty to
    // half the people who type it. Guess at what they meant rather than making
    // them work it out.
    const colon = /^(\d{1,2})\s*:\s*([0-5]?\d)$/.exec(raw.trim());
    if (colon) {
      return {
        text: `Times are written in units now. Did you mean ${colon[1]}h ${Number(colon[2])}m?`,
        tone: "error",
      };
    }

    return { text: "Not a length of time. Try 1h 30m, 90m or 1.5.", tone: "error" };
  }

  // The parser returns 0 for an empty field AND for `20s`. Only the second is
  // worth saying anything about, and the caller has already checked for a blank.
  if (minutes === 0) {
    return { text: "Under a minute — too short to record.", tone: "error" };
  }

  return { text: `= ${formatCellDuration(minutes)}`, tone: "ok" };
}

/** Splitting one task's day into two entries, because the notes differ. */
function AddEntry({ taskId, day }: { taskId: string; day: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [duration, setDuration] = useState("");
  const [note, setNote] = useState("");
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");

  // Same rule as the rows above: both times present means the length is theirs
  // to state, and the length field stops being an independent number that could
  // contradict them.
  const timed = Boolean(startTime && endTime);
  const derived = timed ? minutesBetween(startTime, endTime) : null;

  function add() {
    if (Boolean(startTime) !== Boolean(endTime)) {
      toast.error("Give both a start and an end time, or neither.");
      return;
    }

    if (timed && (derived === null || derived <= 0)) {
      toast.error("The end time has to be after the start.");
      return;
    }

    const minutes = derived ?? parseCellDuration(duration);

    if (minutes === null || minutes === 0) {
      toast.error("How long was it? Try 1h 30m, 90m or 1.5.");
      return;
    }

    startTransition(async () => {
      const result = await logTime({
        task_id: taskId,
        work_date: day,
        minutes,
        note: note.trim() ? note.trim() : null,
        started_at: startTime || null,
        ended_at: endTime || null,
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setDuration("");
      setNote("");
      setStartTime("");
      setEndTime("");
      router.refresh();
    });
  }

  const preview = describeDuration(duration);

  return (
    <div className="-mx-2.5 -mb-2.5 border-t">
      {/*
        The time field leads, full width and unadorned — it is the only thing
        most people came here to type, and the example in the placeholder is the
        documentation. The formats are OURS (`parseCellDuration`): 1h 30m 5s,
        1h 30m 5s, 90m and 1.5 all parse, and a bare number is hours.
      */}
      <Input
        value={timed && derived !== null && derived > 0 ? formatCellDuration(derived) : duration}
        disabled={pending}
        readOnly={timed}
        placeholder="Enter time — 1h 30m 5s, 90m or 1.5"
        aria-label="Length of the new entry"
        title={timed ? "Worked out from the start and end times." : undefined}
        className={cn(
          "h-11 rounded-none border-x-0 border-t-0 bg-transparent px-3 text-base shadow-none focus-visible:ring-0",
          timed && "text-muted-foreground",
        )}
        onChange={(event) => setDuration(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && add()}
      />

      {/*
        What it understood, echoed back as you type.

        The parser accepts several spellings of the same length of time, so the
        only way to know it read `1h 30m 5s` the way you meant is to be shown.
        It also says when seconds fall off — the column stores minutes, and
        silently discarding part of what somebody typed into a payroll record is
        the failure this whole field exists to avoid.

        `aria-live="polite"` because it changes under the cursor while typing;
        polite waits for a pause rather than interrupting every keystroke.
      */}
      {duration.trim() && !timed ? (
        <p
          aria-live="polite"
          className={cn(
            "border-b px-3 py-1.5 text-xs",
            preview.tone === "error" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {preview.text}
        </p>
      ) : null}

      {/* Icon-led rows, the shape the team already reads in ClickUp. The date is
          a statement, not a control: the cell you opened decides it, and a date
          picker here would let somebody file an hour on a day they are not
          looking at. */}
      <div className="flex items-center gap-2.5 border-b px-3 py-2 text-sm text-foreground-muted">
        <Clock className="size-4 shrink-0 text-foreground-faint" aria-hidden />
        <span>
          {formatWeekday(day)} · {formatDate(day)}
        </span>
      </div>

      {/* P7-21 — WHEN in the day, optional. Sits under the date because it
          qualifies it: the date says which day, this says where in it. Leave
          both empty and the entry is a duration exactly as it was before, which
          is still the fast path. */}
      <div className="flex items-center gap-2.5 border-b px-3 py-2 text-sm">
        <Timer className="size-4 shrink-0 text-foreground-faint" aria-hidden />
        <TimePicker
          size="sm"
          label="Start time"
          value={startTime}
          disabled={pending}
          onChange={(next) => setStartTime(next ?? "")}
        />
        <span className="text-foreground-muted" aria-hidden>
          –
        </span>
        <TimePicker
          size="sm"
          label="End time"
          value={endTime}
          disabled={pending}
          onChange={(next) => setEndTime(next ?? "")}
        />
        {timed && derived !== null && derived <= 0 ? (
          <span className="text-xs text-destructive">End must be after the start.</span>
        ) : !startTime && !endTime ? (
          <span className="text-xs text-muted-foreground">Optional</span>
        ) : null}
      </div>

      <div className="flex items-center gap-2.5 px-3">
        <AlignLeft className="size-4 shrink-0 text-foreground-faint" aria-hidden />
        <Input
          value={note}
          disabled={pending}
          placeholder="Notes"
          aria-label="Note for the new entry"
          className="h-10 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && add()}
        />
      </div>

      <div className="flex items-center justify-end border-t bg-muted/40 px-3 py-2">
        <Button size="sm" loading={pending} onClick={add}>
          <Plus />
          Add entry
        </Button>
      </div>
    </div>
  );
}
