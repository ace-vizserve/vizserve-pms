"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquareText, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatDate, formatWeekday } from "@/lib/dates";
import { formatCellDuration, parseCellDuration } from "@/lib/schemas/timesheet";
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
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskId: string;
  taskTitle: string;
  day: string;
  entries: CellEntry[];
}) {
  const split = entries.length > 1;
  const noted = entries.some((entry) => entry.note);

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
          split || noted
            ? "opacity-100"
            : "opacity-0 group-hover/cell:opacity-100 group-focus-within/cell:opacity-100",
        )}
      >
        {split ? entries.length : <MessageSquareText className="size-3" />}
        <span className="sr-only">
          {taskTitle} — {formatWeekday(day)} {formatDate(day)}: notes and split entries
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
                <EntryRow entry={entry} taskId={taskId} day={day} />
              </li>
            ))}
          </ul>
        ) : null}

        <AddEntry taskId={taskId} day={day} />

        {split ? (
          <p className="text-2xs text-muted-foreground">
            The cell shows the total of these. Edit them here.
          </p>
        ) : null}
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
function EntryRow({ entry, taskId, day }: { entry: CellEntry; taskId: string; day: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [duration, setDuration] = useState(formatCellDuration(entry.minutes));
  const [note, setNote] = useState(entry.note ?? "");

  function save() {
    const minutes = parseCellDuration(duration);

    if (minutes === null) {
      toast.error(`"${duration}" is not a length of time.`);
      setDuration(formatCellDuration(entry.minutes));
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
    if (minutes === entry.minutes && nextNote === entry.note) return;

    startTransition(async () => {
      const result = await updateTimeEntry({
        id: entry.id,
        task_id: taskId,
        work_date: day,
        minutes,
        note: nextNote,
      });

      if (!result.ok) {
        toast.error(result.error);
        setDuration(formatCellDuration(entry.minutes));
        setNote(entry.note ?? "");
        return;
      }

      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1.5">
      <Input
        value={duration}
        disabled={pending}
        aria-label="Length"
        className="h-8 w-16 text-center tabular-nums"
        onChange={(event) => setDuration(event.target.value)}
        onBlur={save}
      />
      <Input
        value={note}
        disabled={pending}
        placeholder="Note"
        aria-label="Note"
        className="h-8 flex-1"
        onChange={(event) => setNote(event.target.value)}
        onBlur={save}
      />
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
    </div>
  );
}

/** Splitting one task's day into two entries, because the notes differ. */
function AddEntry({ taskId, day }: { taskId: string; day: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [duration, setDuration] = useState("");
  const [note, setNote] = useState("");

  function add() {
    const minutes = parseCellDuration(duration);

    if (minutes === null || minutes === 0) {
      toast.error("How long was it? Try 1:30, 90m or 1.5.");
      return;
    }

    startTransition(async () => {
      const result = await logTime({
        task_id: taskId,
        work_date: day,
        minutes,
        note: note.trim() ? note.trim() : null,
      });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      setDuration("");
      setNote("");
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-1.5 border-t pt-2">
      <Input
        value={duration}
        disabled={pending}
        placeholder="0:30"
        aria-label="Length of the new entry"
        className="h-8 w-16 text-center tabular-nums"
        onChange={(event) => setDuration(event.target.value)}
      />
      <Input
        value={note}
        disabled={pending}
        placeholder="Note"
        aria-label="Note for the new entry"
        className="h-8 flex-1"
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && add()}
      />
      <Button variant="ghost" size="icon-xs" loading={pending} onClick={add}>
        <Plus />
        <span className="sr-only">Add another entry to this day</span>
      </Button>
    </div>
  );
}
