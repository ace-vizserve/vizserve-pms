"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { toast } from "@/components/ui/toast";
import { sameTimesheetLayout, type TimesheetLayoutInput } from "@/lib/schemas/timesheet";

import { saveTimesheetLayout } from "./actions";
import type { PickableTask } from "./week-grid";

/**
 * P6-02d — the week's layout, held here and written on a debounce.
 *
 * WHAT THIS REPLACES. Three web-storage keys used to hold it: the empty rows in
 * sessionStorage, the drag order in localStorage, and the last-week flag in
 * sessionStorage — read back through a `useSyncExternalStore` triple with a
 * module cache each, because `getSnapshot` has to be referentially stable. Two
 * of the three died with the tab, which is the bug: set your week up with five
 * + Add task presses, close the tab, come back, and there is nowhere to type.
 * All of it is now one row in `vizserve_pms_timesheet_layouts`, read by the
 * server component and passed in.
 *
 * ⚠️ HOURS DO NOT COME THROUGH HERE AND MUST NOT. `TimeCell.persist` in
 * `week-grid.tsx` writes every cell to `vizserve_pms_timesheet_entries` on
 * blur, and always has. This hook writes an ARRANGEMENT. Keeping the two apart
 * is what leaves P7-05's "the absence of a week row IS the draft state" true.
 *
 * THE RULE THIS HOOK ENCODES, and it is the opposite of `use-task-autosave.ts`:
 *
 *   every change debounces · because they all write the SAME ROW
 *
 * That hook debounces free text and commits discrete controls immediately,
 * because its fields are independent columns and a timer on a `Select` is pure
 * latency. Here a press of + Add task, a drag and the last-week shortcut all
 * rewrite one layout, and a drag emits a burst. Coalescing them into a single
 * upsert is the whole reason for the timer: dragging a row through four
 * positions is one write, not four.
 *
 * ⚠️ NO `useTransition`, for the reason `use-task-autosave.ts:106-112` gives —
 * a shared `pending` would disable whichever cell has focus mid-save and drop
 * the caret to position 0. Nothing on this screen should be able to tell that a
 * layout is saving.
 *
 * ⚠️ NO SUCCESS TOAST AND NO STATUS LINE. `week-grid.tsx` already states the
 * policy — a toast per successful autosave makes filling in a week feel like an
 * alarm going off — and the grid's per-cell ticks are the indicator this screen
 * has. A second one competing with them would be worse than none. A REFUSAL
 * still toasts: a silently failed autosave is the original bug in a new hat.
 */

/** How long after the last change the layout writes itself. */
const DEBOUNCE_MS = 700;

export type TimesheetLayout = {
  /** Rows put on the week with no hours yet. Whole tasks, resolved by the server. */
  extraTasks: PickableTask[];
  /** Task ids, in the order the grid draws them. Empty means alphabetical. */
  rowOrder: string[];
  /** P6-02b — has this week already been offered last week's tasks? */
  copiedLastWeek: boolean;
};

export type LayoutAutosave = TimesheetLayout & {
  setExtraTasks: (next: PickableTask[]) => void;
  setRowOrder: (next: string[]) => void;
  markCopied: () => void;
};

function payloadOf(monday: string, layout: TimesheetLayout): TimesheetLayoutInput {
  return {
    week_start: monday,
    // Deduped on the way out. Nothing in the UI should be able to add the same
    // task twice, but a duplicate here is a duplicate ROW, and two rows for one
    // task writing into the same cell is not a state worth trusting a caller to
    // avoid. The `writeRows` this replaces said the same thing.
    extra_task_ids: [...new Set(layout.extraTasks.map((task) => task.id))],
    row_order: [...new Set(layout.rowOrder)],
    copied_last_week: layout.copiedLastWeek,
  };
}

export function useLayoutAutosave(monday: string, initial: TimesheetLayout): LayoutAutosave {
  const [layout, setLayout] = useState<TimesheetLayout>(initial);

  /**
   * The current layout, readable from a callback that must not re-create when
   * it changes — the grid hands these setters to memoised rows.
   *
   * Written synchronously in `schedule` rather than in an effect, so two
   * changes in one tick (add a row, then reorder) compose instead of the second
   * overwriting the first from a stale snapshot.
   */
  const layoutRef = useRef(layout);

  /**
   * What the server last confirmed, so an arrangement that ends where it began
   * is not a write.
   *
   * ⚠️ A no-change UPDATE still fires the `updated_at` trigger. Same reason
   * `cellCommit` returns `noop` for an unchanged cell rather than writing it: a
   * tab through a week must not read as an edit.
   */
  const savedRef = useRef<TimesheetLayoutInput>(payloadOf(monday, initial));

  /**
   * The timer, and the payload it is holding.
   *
   * Refs rather than state because the flush below runs during an effect
   * cleanup, when there is nothing left to render into — the same constraint
   * `use-task-autosave.ts:92-100` and `week-grid.tsx`'s `persist` both record.
   */
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<TimesheetLayoutInput | null>(null);

  const write = useCallback(async (payload: TimesheetLayoutInput) => {
    // Recorded BEFORE the round trip, so a burst arriving while this one is in
    // flight compares against what was sent rather than sending it again.
    savedRef.current = payload;

    const result = await saveTimesheetLayout(payload);

    /*
     * Loud, always — a layout that silently failed to save is the original bug
     * wearing a different hat.
     *
     * `savedRef` is deliberately NOT rolled back. Retrying the same payload on
     * the next tick is a loop against a server that has already refused it;
     * the next real change sends the whole layout again and heals it. Same rule
     * as `refusedSchemaRef` in the form builder: retry on CHANGE, not on a timer.
     */
    if (!result.ok) toast.error(result.error);
  }, []);

  const schedule = useCallback(
    (next: TimesheetLayout) => {
      layoutRef.current = next;
      setLayout(next);

      const payload = payloadOf(monday, next);

      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingRef.current = null;

      /*
       * Back where it started, so there is nothing to write.
       *
       * ⚠️ THE TIMER IS DISARMED FIRST, ABOVE, AND THAT ORDER IS THE FIX. Drag
       * a row and drag it straight back: the second call matches what the
       * server already has, and an early return that left the first call's
       * timer running would fire it a moment later and write the arrangement
       * the person had just undone.
       */
      if (sameTimesheetLayout(payload, savedRef.current)) return;

      pendingRef.current = payload;

      timerRef.current = setTimeout(() => {
        const queued = pendingRef.current;
        timerRef.current = null;
        pendingRef.current = null;
        if (queued) void write(queued);
      }, DEBOUNCE_MS);
    },
    [monday, write],
  );

  const setExtraTasks = useCallback(
    (next: PickableTask[]) => schedule({ ...layoutRef.current, extraTasks: next }),
    [schedule],
  );

  const setRowOrder = useCallback(
    (next: string[]) => schedule({ ...layoutRef.current, rowOrder: next }),
    [schedule],
  );

  const markCopied = useCallback(
    () => schedule({ ...layoutRef.current, copiedLastWeek: true }),
    [schedule],
  );

  /**
   * Do not lose a layout to a tab switch, a navigation, or a week change.
   *
   * Copied from `use-task-autosave.ts:197-236`, including what it refuses to
   * do: `visibilitychange` covers the phone and the closed tab, the cleanup
   * covers unmount, and NEITHER is `beforeunload` — unreliable on mobile
   * Safari, cannot await, and it is the hook that produces "leave site?", which
   * would be a prompt on the way out of a screen whose whole point is that
   * saving is invisible.
   *
   * ⚠️ THE GRID IS KEYED ON `monday` IN page.tsx, so moving to another week
   * unmounts this and runs the cleanup — which is what makes a pending flush
   * belong to the week it was editing rather than writing that week's rows
   * against the next one's date.
   */
  useEffect(() => {
    function flush() {
      const queued = pendingRef.current;
      if (!queued) return;
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = null;
      pendingRef.current = null;
      // Reads only refs and calls the action directly. It sets no state,
      // because by the time the cleanup runs there is nothing to render into,
      // and it does not toast for the same reason.
      savedRef.current = queued;
      void saveTimesheetLayout(queued);
    }

    function onVisibility() {
      if (document.visibilityState === "hidden") flush();
    }

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, []);

  return { ...layout, setExtraTasks, setRowOrder, markCopied };
}
