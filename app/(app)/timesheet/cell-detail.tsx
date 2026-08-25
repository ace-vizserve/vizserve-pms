"use client";

import { AlignLeft, Clock, MessageSquareText, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { formatDate, formatWeekday } from "@/lib/dates";
import {
  type EntryDraft,
  clockAt,
  draftToEntry,
  formatCellDuration,
  parseCellDuration,
  withDuration,
  withEnd,
  withStart,
} from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { deleteTimeEntry, logTime, updateTimeEntry } from "./actions";
import { ClockSelect, clockLabel, normaliseClock } from "./clock-select";
import { DurationSuggestion } from "./duration-suggestion";
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
 *
 * ── ONE FORM, THREE QUESTIONS ───────────────────────────────────────────────
 * How long · what was it · when in the day. In that order, always on screen,
 * and that is the whole popover.
 *
 * It used to be two forms. Every existing entry carried its own length field
 * and its own note field, and the add form underneath carried a second copy of
 * both — so a cell with one entry showed two length boxes and two note boxes,
 * and nothing on screen said which was which. The entries are now a LIST: click
 * one and it loads into the same form that adds them.
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
   * the bin and the form would still be sitting one click behind it. The
   * database refuses all three writes either way; this is about not offering
   * them.
   *
   * It still opens. Notes are why the popover exists, and a submitted week is
   * exactly when somebody goes back to read what they wrote.
   */
  locked?: boolean;
}) {
  /*
   * WHICH ENTRY THE FORM IS EDITING, OR NULL FOR A NEW ONE.
   *
   * ⚠️ IT OPENS ON NULL, ALWAYS — even on a cell holding exactly one entry,
   * where pointing the form at it looks like the helpful thing to do. It is
   * not: the entry is already on screen a line above, so a form pre-filled with
   * the same `2h` shows the number twice and highlights a row nobody clicked.
   * Opening blank says what the popover is for — logging time — and editing
   * what is there is one click on the row that holds it.
   *
   * `nonce` is bumped by Cancel, which resets the form by remounting it on its
   * key. Cancelling back to the same target has to change the key too, or every
   * edited field would stay exactly where it was.
   */
  const [editing, setEditing] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const split = entries.length > 1;
  const noted = entries.some((entry) => entry.note);
  // P7-21. Times are the third thing a cell total cannot show, so they pin the
  // marker open for the same reason a note does — otherwise the only sign the
  // entry carries them is hovering the cell that hides them.
  const timed = entries.some((entry) => entry.started_at);

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Closing abandons an edit. Reopening on a half-changed row would show
        // a form claiming to be editing something the person has stopped
        // thinking about.
        if (!next) setEditing(null);
        onOpenChange(next);
      }}>
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
        )}>
        {/* A CLOCK, NOT A COUNT.
            The number of entries in a cell used to be the marker on a split,
            back when a split was the only reason a cell held more than its
            total. Now every duration carries a start and an end, so the thing
            behind the marker is the same on every cell — times, and sometimes
            a note — and a bare `2` in the corner of a grid full of hours reads
            as another number rather than a way in. */}
        {noted ? <MessageSquareText className="size-3" /> : <Clock className="size-3" />}
        <span className="sr-only">
          {taskTitle} — {formatWeekday(day)} {formatDate(day)}: notes, times and split entries
        </span>
      </PopoverTrigger>

      {/* `w-max` with a floor: the resting state is a length, a note and a line
          of text, and it should not be padded out to the width of two clock
          controls that only appear once somebody clicks the times. */}
      <PopoverContent align="end" className="w-max min-w-88">
        <PopoverHeader>
          <PopoverTitle className="truncate text-sm">{taskTitle}</PopoverTitle>
          {/* The date, stated ONCE — and normally by the time row in the form,
              which is where it means something ("this is when you did it").
              A locked week has no form, so it comes back up here. */}
          {locked ? (
            <p className="text-xs text-muted-foreground">
              {formatWeekday(day)} · {formatDate(day)}
            </p>
          ) : null}
        </PopoverHeader>

        {entries.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {entries.map((entry) => (
              <li key={entry.id}>
                <EntryRow
                  entry={entry}
                  locked={locked}
                  selected={editing === entry.id}
                  onEdit={() => setEditing(editing === entry.id ? null : entry.id)}
                />
              </li>
            ))}
          </ul>
        ) : null}

        {/* Above the form, not below it. `EntryForm` is pulled out to the
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
          <p className="text-2xs text-muted-foreground">The cell shows the total of these. Tap one to edit it.</p>
        ) : null}

        {locked ? null : (
          <EntryForm
            // Remounting is the reset. Switching between adding and editing
            // swaps four fields at once, and a `key` does it without four
            // effects that each have to remember not to clobber a keystroke.
            key={`${editing ?? "new"}-${nonce}`}
            entry={entries.find((entry) => entry.id === editing) ?? null}
            taskId={taskId}
            day={day}
            canCancel={entries.length > 0}
            onDone={() => {
              setEditing(null);
              setNonce((value) => value + 1);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/**
 * One entry, as a line of text.
 *
 * No inputs. This row's job is to say what is already recorded and to hand it
 * to the form; a row that edits itself is the second form this popover used to
 * carry, and it is why a one-entry cell had two length fields in it.
 */
function EntryRow({
  entry,
  locked,
  selected,
  onEdit,
}: {
  entry: CellEntry;
  locked: boolean;
  selected: boolean;
  onEdit: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const span =
    entry.started_at && entry.ended_at ? `${clockLabel(entry.started_at)} – ${clockLabel(entry.ended_at)}` : null;

  const body = (
    <>
      <span className="w-14 shrink-0 text-left font-medium tabular-nums">{formatCellDuration(entry.minutes)}</span>
      <span className={cn("flex-1 truncate text-left", entry.note ? "text-foreground-muted" : "text-muted-foreground")}>
        {entry.note ?? "No note"}
      </span>
      {span ? <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">{span}</span> : null}
    </>
  );

  return (
    <div className="flex items-center gap-1">
      {locked ? (
        <div className="flex flex-1 items-center gap-2 px-2 py-1.5 text-sm">{body}</div>
      ) : (
        <button
          type="button"
          aria-pressed={selected}
          onClick={onEdit}
          className={cn(
            "flex flex-1 items-center gap-2 rounded-md border px-2 py-1.5 text-sm",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            selected ? "border-accent-border bg-accent" : "border-transparent hover:bg-muted",
          )}>
          {body}
          <span className="sr-only">— edit this entry</span>
        </button>
      )}

      {/* The bin goes away entirely on a locked week. Greying it out would
          leave the one control in this row whose whole meaning is "this is gone
          now" sitting on a week that cannot lose anything. */}
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
          }>
          <Trash2 />
          <span className="sr-only">Remove this entry</span>
        </Button>
      )}
    </div>
  );
}

/**
 * What the field got wrong, in words — and NOTHING when it got it right.
 *
 * Kept beside the form rather than inside `parseCellDuration` because the
 * parser is the CONTRACT — it returns minutes or null and is shared with the
 * server action. This is presentation, and it is the only place that knows the
 * difference between "nothing typed yet" and "typed something that rounds to
 * nothing", which the parser deliberately collapses to 0.
 */
function describeDuration(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const minutes = parseCellDuration(trimmed);

  if (minutes === null) {
    // A colon is the one wrong answer worth naming, because it used to work and
    // because it is the reason it no longer does: `1:30` reads as one-thirty to
    // half the people who type it. Guess at what they meant rather than making
    // them work it out.
    const colon = /^(\d{1,2})\s*:\s*([0-5]?\d)$/.exec(trimmed);
    if (colon) return `Times are written in units now. Did you mean ${colon[1]}h ${Number(colon[2])}m?`;

    return "Not a length of time. Try 1h 30m, 90m or 1.5.";
  }

  // The parser returns 0 for an empty field AND for `20s`. Only the second is
  // worth saying anything about, and the blank was returned above.
  if (minutes === 0) return "Under a minute — too short to record.";

  return null;
}

/**
 * How long, what was it, and when.
 *
 * ── THE LENGTH IS THE MASTER, AND THE CLOCK FOLLOWS IT ──────────────────────
 * `vizserve_pms_timesheet_entries_times_match_minutes` refuses a row whose
 * duration disagrees with its span, so the three fields here are really two
 * facts and a derivation. The old editor resolved that by making the length
 * READ-ONLY whenever both times were set — which, now that the times are always
 * on screen, would mean the one field everybody came here to type could not be
 * typed into.
 *
 * So it derives the other way, which is also the way people work:
 *
 *   start defaults to NOW — you log the work you just finished
 *   type a length      → the end moves            (2:41pm + 2h = 4:41pm)
 *   move the start     → the end moves with it, the length is kept
 *   move the end       → the LENGTH is recomputed from the span
 *
 * Two of the three are always yours; the third is worked out. Nothing on screen
 * can contradict anything else on screen, so nothing needs validating after the
 * fact — the same move as deriving a task's department from its assignee.
 *
 * ── WHY THE CLOCK CAN STILL BE EMPTY ────────────────────────────────────────
 * `now` is only an honest default on the day it is now. Open Monday's cell on
 * Friday and the times start blank rather than claiming Monday's work happened
 * at this afternoon's clock time. Times are optional in the schema (both or
 * neither) and a blank pair still saves as a plain duration, which is what
 * every entry was before P7-21.
 */
function EntryForm({
  entry,
  taskId,
  day,
  canCancel,
  onDone,
}: {
  entry: CellEntry | null;
  taskId: string;
  day: string;
  /**
   * Whether there is anything to go back TO.
   *
   * Cancel on the only form a cell has ever shown would be a button that empties
   * four fields and calls it an escape. With entries above it, it is a real way
   * out of both "adding another" and a half-finished correction.
   */
  canCancel: boolean;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const durationRef = useRef<HTMLInputElement>(null);

  const [draft, setDraft] = useState<EntryDraft>(() => ({
    duration: entry ? formatCellDuration(entry.minutes) : "",
    note: entry?.note ?? "",
    // An existing entry keeps whatever it was saved with, blank included — its
    // times are a record, not a default. Only a new entry gets the clock, from
    // the same function the grid stamps a typed duration with, so the two
    // cannot drift into disagreeing about what "now" means.
    start: entry ? normaliseClock(entry.started_at) : normaliseClock(clockAt()),
    end: normaliseClock(entry?.ended_at),
  }));

  const { duration, note, start, end } = draft;

  /**
   * Taking the suggestion FILLS THE CLOCKS.
   *
   * Clicking "1 hour" when the length field already says `1h` would otherwise
   * be a control that visibly does nothing. What it is actually for is the rest
   * of the row: it seeds a start and works out the end, so one click turns a
   * typed length into a logged hour with a place in the day.
   *
   * Nothing has been guessed on somebody's behalf here — they clicked — and
   * both clocks are theirs to correct afterwards.
   */
  function acceptSuggestion(minutes: number) {
    setDraft((current) =>
      withDuration({ ...current, start: current.start || normaliseClock(clockAt()) }, formatCellDuration(minutes)),
    );
  }

  function submit() {
    const built = draftToEntry(draft);

    if (!built.ok) {
      toast.error(built.error);
      return;
    }

    const payload = { task_id: taskId, work_date: day, ...built.entry };

    startTransition(async () => {
      const result = entry ? await updateTimeEntry({ id: entry.id, ...payload }) : await logTime(payload);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      onDone();
      router.refresh();
    });
  }

  const problem = describeDuration(duration);

  return (
    <div className="-mx-2.5 -mb-2.5 border-t">
      {/*
        The formats are OURS (`parseCellDuration`): `1h 30m 5s`, `90m` and `1.5`
        all parse, and a bare number is hours. The placeholder shows one of them
        rather than listing all three — the full set is in the correction below,
        which is where somebody actually needs it.
      */}
      <div className="relative">
        <Input
          ref={durationRef}
          value={duration}
          disabled={pending}
          autoFocus
          placeholder="Enter time (ex: 3h 20m)"
          aria-label={entry ? "Length" : "Length of the new entry"}
          aria-invalid={problem ? true : undefined}
          className="h-11 rounded-none border-x-0 border-t-0 bg-transparent px-3 text-base shadow-none focus-visible:ring-0"
          onChange={(event) => setDraft(withDuration(draft, event.target.value))}
          onKeyDown={(event) => event.key === "Enter" && submit()}
        />

        {/* What the field heard, in words. Accepting it writes the canonical
            spelling back, which is also what makes the reading of a bare `1.5`
            visible in the place it was typed. */}
        <DurationSuggestion inline anchor={durationRef} value={duration} onAccept={acceptSuggestion} />
      </div>

      {/* `aria-live="polite"` because it changes under the cursor while typing;
          polite waits for a pause rather than interrupting every keystroke. */}
      {problem ? (
        <p aria-live="polite" className="border-b px-3 py-1.5 text-xs text-destructive">
          {problem}
        </p>
      ) : null}

      <div className="flex items-center gap-2.5 border-b px-3">
        <AlignLeft className="size-4 shrink-0 text-foreground-faint" aria-hidden />
        <Input
          value={note}
          disabled={pending}
          placeholder="Notes (optional)"
          aria-label="Note"
          className="h-10 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          onChange={(event) => setDraft({ ...draft, note: event.target.value })}
          onKeyDown={(event) => event.key === "Enter" && submit()}
        />
      </div>

      {/*
        P7-21 — WHEN in the day, and the row this popover was rebuilt around.

        The date is a statement and the two clocks are controls: the cell you
        opened decides the day, and nothing in here offers to move an hour onto
        a day you are not looking at. The clocks are prefilled and the end
        follows the length as it is typed, so the ordinary way to use this row
        is to read it and leave it alone.
      */}
      <div className="flex items-center gap-2.5 px-3 py-2 text-sm">
        <Clock className="size-4 shrink-0 text-foreground-faint" aria-hidden />
        <span className="shrink-0 text-foreground-muted">
          {formatWeekday(day)}, {formatDate(day)}
        </span>
        <ClockSelect
          label="Start time"
          value={start}
          disabled={pending}
          onChange={(next) => setDraft(withStart(draft, next))}
        />
        <span className="text-foreground-faint" aria-hidden>
          –
        </span>
        <ClockSelect
          label="End time"
          value={end}
          after={start}
          disabled={pending}
          onChange={(next) => setDraft(withEnd(draft, next))}
        />
      </div>

      <div className="flex items-center justify-end gap-2 border-t bg-muted/40 px-3 py-2">
        {canCancel ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        <Button size="sm" loading={pending} onClick={submit}>
          {entry ? null : <Plus />}
          {entry ? "Save changes" : "Log time"}
        </Button>
      </div>
    </div>
  );
}
