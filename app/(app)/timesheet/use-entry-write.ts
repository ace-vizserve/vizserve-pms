"use client";

import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "@/components/ui/toast";

import { invalidateTimesheetWrite } from "@/lib/query/invalidate";
import { fromAction } from "@/lib/query/mutate";
import { placeholderId } from "@/lib/query/placeholder";
import {
  addPlaceholderEntry,
  beginTimesheetWrite,
  cancelTimesheetRefetches,
  patchEntry,
  removeEntry,
  rollbackTimesheetWrite,
} from "@/lib/query/timesheet-cache";

import { deleteTimeEntry, logTime, updateTimeEntry } from "./actions";

/**
 * P12-23 — WRITING AN HOUR, ONCE, FOR EVERY CONTROL THAT WRITES ONE.
 *
 * ------------------------------------------------------------------------
 * There are four: the grid cell (`week-grid.tsx`), the entry row underneath it,
 * that row's menu, and the cell popover (`cell-detail.tsx`). All four call the
 * same three actions, all four have to paint the same cached entry list, and all
 * four have to PUT THE OLD NUMBER BACK when the database refuses.
 *
 * ⚠️ THAT LAST ONE IS WHY THIS IS A HOOK AND NOT FOUR COPIES. The data is hours.
 * A refused write with no rollback leaves a saved-looking cell that did not save,
 * on the record somebody's pay is drawn from, with a toast that scrolls away —
 * and it is the one failure in the optimistic path that is completely SILENT
 * when it is wrong. Four hand-written rollbacks is four chances to write it
 * wrong once. `lib/query/write-cache.ts` was extracted from the tasks surface for
 * the same reason and says so at greater length.
 *
 * ⚠️ THE PAYLOAD IS BUILT BEFORE THE WRITE STARTS, AND `onMutate` PAINTS FROM
 * THE SAME OBJECT THE SERVER GETS. That is the whole shape of `EntryWrite`
 * below. `cellCommit` REINTERPRETS what was typed — "1.5" becomes 90m, "90m"
 * becomes 1h 30m — so painting the keystrokes would show a number the server was
 * never going to store, and a timesheet that displays a figure nobody saved is
 * worse than a slow one. One object, two consumers, no chance of them differing.
 *
 * ⚠️ AND IT REPLACES A `useOptimistic` THAT WORKED. `week-grid.tsx` held the
 * predicted minutes in the GRID, keyed `taskId|day`, because a typed cell is four
 * numbers — the cell, its row total, its day total in the header, the week total
 * in the footer — and three of them were summed there. It painted instantly and
 * then dropped its value the moment the transition ENDED, so the cell fell back
 * to the server total and jumped forward again when `router.refresh()` landed.
 * The value lives in the cached ENTRY LIST now, which all four numbers are still
 * summed from, and nothing reverts by itself.
 * ------------------------------------------------------------------------
 */

/** The Server Actions, as promises TanStack can drive `onError` off. */
const insertEntry = fromAction(logTime);
const saveEntry = fromAction(updateTimeEntry);
const dropEntry = fromAction(deleteTimeEntry);

/** The columns an entry write sends. Mirrors `timesheetEntrySchema`. */
export type EntryInput = {
  task_id: string;
  work_date: string;
  minutes: number;
  note: string | null;
  started_at: string | null;
  ended_at: string | null;
};

/**
 * One write, in the shape both the action and the optimistic paint read.
 *
 * ⚠️ `placeholder` IS MINTED BY THE CALLER AND IS NOT A UUID. It is the key the
 * predicted row carries until the refetch replaces it, and `isPlaceholder` is
 * how the breakdown knows to render that row INERT — no clock selects, no menu,
 * no delete. Offering to edit a row the server has not created is how
 * `optimistic-3` ends up in an action typed `uuid`, which is a real thing that
 * shipped on the tasks surface. See `lib/query/placeholder.ts`.
 */
export type EntryWrite =
  | { kind: "insert"; placeholder: string; input: EntryInput }
  | { kind: "update"; input: EntryInput & { id: string } }
  | { kind: "delete"; id: string };

/** Builds the insert, including the id its predicted row will carry. */
export function insertWrite(input: EntryInput): EntryWrite {
  return { kind: "insert", placeholder: placeholderId(), input };
}

/**
 * The one write path for all four controls.
 *
 * `weekKey` is `qk.week(userId, weekStart)` — the EXACT entry being patched,
 * never the `["timesheet"]` root. An hour belongs to one person's one week, and a
 * tab can easily hold three weeks at once because arrowing back through them is
 * one click each; scanning the root would put Tuesday's typed hour into every
 * cached week in the tab.
 *
 * ⚠️ SAFE TO CALL FROM AN UNMOUNT CLEANUP, which the grid cell does — a cell
 * typed into and then abandoned (tab closed, row scrolled off, navigation) must
 * not lose its draft. TanStack runs the callbacks declared HERE off the mutation
 * itself rather than off the mounted observer, so the rollback and the
 * invalidation still happen after the component has gone. Per-call callbacks
 * passed to `mutate(write, { onSuccess })` do NOT, which is why nothing that has
 * to happen lives in one.
 */
export function useEntryWrite(weekKey: QueryKey) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (write: EntryWrite) => {
      if (write.kind === "insert") return insertEntry(write.input);
      if (write.kind === "update") return saveEntry(write.input);
      return dropEntry(write.id);
    },

    onMutate: (write) => {
      /*
       * ⚠️ THE PAINT COMES FIRST AND NOTHING IS AWAITED IN FRONT OF IT. The
       * snapshot is synchronous and `cancelTimesheetRefetches` is FIRED AFTER
       * the patch rather than awaited before it — awaiting a network
       * cancellation before touching the cache is what made the tasks surface
       * feel slow, and `lib/query/write-cache.ts` carries the full argument.
       */
      const snapshot = beginTimesheetWrite(queryClient);

      if (write.kind === "insert") {
        addPlaceholderEntry(queryClient, weekKey, {
          id: write.placeholder,
          ...write.input,
        });
      } else if (write.kind === "update") {
        const { id, ...fields } = write.input;
        patchEntry(queryClient, weekKey, id, fields);
      } else {
        removeEntry(queryClient, weekKey, write.id);
      }

      cancelTimesheetRefetches(queryClient);

      return snapshot;
    },

    onError: (error, _write, snapshot) => {
      /*
       * ⚠️ NOT OPTIONAL, AND THE MOST IMPORTANT FOUR LINES IN THIS FILE. Without
       * it the browser keeps showing a number the database refused. `useOptimistic`
       * used to put it back for free; this is what replaced that.
       */
      if (snapshot) rollbackTimesheetWrite(queryClient, snapshot);

      /*
       * The failure stays LOUD. A refused write is worth interrupting for; a
       * successful one is not — a toast per cell makes filling in a week feel
       * like an alarm going off, and it appears in the corner rather than on the
       * number that changed. The cell says "saved" on itself instead.
       */
      toast.error(error.message || "That did not save.");
    },

    /*
     * ⚠️ FIRED, NEVER AWAITED. TanStack's documented shape is to invalidate what
     * the write affected on BOTH paths, so the optimistic guess is always
     * reconciled against the server. Awaiting it is what used to hold the
     * interaction open on the tasks surface; with `onMutate` there is no
     * transition whose end could drop a value, so there is nothing to wait for.
     */
    onSettled: () => {
      invalidateTimesheetWrite(queryClient);
    },
  });
}
