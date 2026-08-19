"use client";

import { createContext, useContext, useMemo, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Trash2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import { deleteTasks } from "./actions";

/**
 * P7-19 — picking several tasks and acting on them at once.
 *
 * ClickUp's version of this bar carries nine actions. This one carries one,
 * deliberately: Delete is the thing that was missing, and the other eight
 * (status, assignees, dates, tags, move, convert to subtask, copy, duplicate)
 * either already exist inline on the row or are not features this app has. A bar
 * of mostly-disabled buttons teaches people to stop reading it.
 *
 * ⚠️ ONLY DELETABLE ROWS GET A CHECKBOX. `canDelete()` on the page mirrors
 * `vizserve_pms_can_delete_task`, so a client-backed task or a colleague's work
 * has no checkbox to tick — the same rule as the per-row trash. Offering a
 * checkbox that can only ever produce a refusal is the sidebar's forbidden-page
 * mistake in a different shape.
 */

type SelectionState = {
  selected: Set<string>;
  toggle: (taskId: string, title: string) => void;
  isSelected: (taskId: string) => boolean;
};

const SelectionContext = createContext<SelectionState | null>(null);

export function TaskSelectionProvider({ children }: { children: ReactNode }) {
  // Title alongside the id, so the confirm dialog can name what it is about to
  // delete without a second round trip for rows that are already on screen.
  const [picked, setPicked] = useState<Map<string, string>>(new Map());

  const value = useMemo<SelectionState>(
    () => ({
      selected: new Set(picked.keys()),
      isSelected: (taskId) => picked.has(taskId),
      toggle: (taskId, title) =>
        setPicked((current) => {
          const next = new Map(current);
          if (next.has(taskId)) next.delete(taskId);
          else next.set(taskId, title);
          return next;
        }),
    }),
    [picked],
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
      <SelectionBar picked={picked} onClear={() => setPicked(new Map())} />
    </SelectionContext.Provider>
  );
}

export function TaskSelectCheckbox({ taskId, title }: { taskId: string; title: string }) {
  const selection = useContext(SelectionContext);
  if (!selection) return null;

  return (
    <Checkbox
      checked={selection.isSelected(taskId)}
      onCheckedChange={() => selection.toggle(taskId, title)}
      aria-label={`Select ${title}`}
    />
  );
}

function SelectionBar({
  picked,
  onClear,
}: {
  picked: Map<string, string>;
  onClear: () => void;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startDelete] = useTransition();

  const count = picked.size;
  if (count === 0) return null;

  function remove() {
    startDelete(async () => {
      const result = await deleteTasks([...picked.keys()]);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      const { deleted, failures } = result.data;

      /*
       * Reported honestly, per outcome rather than per attempt.
       *
       * `deleteTasks` decides each task on its own instead of wrapping the lot
       * in a transaction, so a selection can partly succeed — and saying
       * "Deleted" over a run where three of eight were refused is the kind of
       * lie that gets found out a week later.
       */
      if (deleted > 0) {
        toast.success(`${deleted} ${deleted === 1 ? "task" : "tasks"} deleted`);
      }
      for (const reason of failures) toast.error(reason);

      setConfirming(false);
      onClear();
      router.refresh();
    });
  }

  return (
    <>
      {/*
        Fixed to the bottom of the viewport, like the reference. `pointer-events-none`
        on the positioner and back on for the bar itself, so the strip does not
        eat clicks on the rows either side of it.
      */}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
        {/*
          BRAND, not a white card. This bar exists only while a selection does,
          and a floating white panel over a white page reads as part of the page
          — something that drifted loose rather than a mode you are currently
          in. The brand fill says "something is selected" before a word is read.

          `grade-primary` layered over `bg-primary`, never instead of it: the
          grade utilities are deliberately outside the `bg-` namespace because
          cn is tailwind-merge and would otherwise keep only one of the two.
        */}
        <div
          role="status"
          className="pointer-events-auto flex items-center gap-1 rounded-lg border border-primary/40 bg-primary grade-primary px-2 py-1.5 text-primary-foreground shadow-overlay"
        >
          <span className="px-2 text-xs font-medium tabular-nums">
            {count} {count === 1 ? "task" : "tasks"} selected
          </span>

          {/*
            A FILLED destructive button rather than red text. `--destructive` on
            `--primary` is two mid-tone colours against each other and fails as
            text; the button brings its own dark fill and white label, which
            passes and also reads as the one committing action on the bar.

            The word and the icon carry the danger either way — the colour is
            never the only thing saying so.
          */}
          <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
            <Trash2 />
            Delete
          </Button>

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear selection"
            onClick={onClear}
            // Ghost defaults to a foreground-coloured label on a light hover —
            // both wrong on a brand fill, so both are restated.
            className="text-primary-foreground hover:bg-primary-foreground/15 hover:text-primary-foreground"
          >
            <X />
          </Button>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {count} {count === 1 ? "task" : "tasks"}?
            </DialogTitle>
            <DialogDescription>
              Subtasks, logged time, comments and files on them go too. This cannot be undone.
            </DialogDescription>
          </DialogHeader>

          {/*
            The titles, not just a count. "Delete 8 tasks?" is a number; the list
            is what lets somebody notice the one they did not mean to tick.
            Capped, because a 200-row selection would push the buttons off screen.
          */}
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-sm border p-2 text-xs">
            {[...picked.values()].slice(0, 12).map((title, index) => (
              <li key={`${title}-${index}`} className="truncate text-muted-foreground">
                {title}
              </li>
            ))}
            {count > 12 ? (
              <li className="text-muted-foreground">and {count - 12} more…</li>
            ) : null}
          </ul>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove} loading={pending}>
              Delete {count}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
