import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type { CacheSnapshot } from "./write-cache";

import { beginWrite, cancelRefetches, rollbackWrite } from "./write-cache";

/**
 * P12-23 — WHAT A TIMESHEET WRITE PAINTS, BEFORE THE SERVER ANSWERS.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THE DATA IS HOURS, WHICH MAKES THE ROLLBACK THE MOST IMPORTANT FUNCTION IN
 * THIS FILE. Everywhere else in the app an optimistic paint that is not rolled
 * back leaves a wrong label on screen; here it leaves a SAVED-LOOKING CELL THAT
 * DID NOT SAVE, on the record somebody's pay is drawn from, with a toast that
 * scrolls away. `onError` MUST hand its snapshot to `rollbackTimesheetWrite`,
 * and `tests/unit/timesheet-cache.test.ts` asserts exactly that: apply, refuse,
 * and the cache is byte-for-byte what it was.
 *
 * ⚠️ THIS REPLACES THE `useOptimistic` IN `week-grid.tsx`, AND IT IS NOT A
 * LIKE-FOR-LIKE SWAP. That hook held a `Record<"taskId|day", minutes>` in the
 * GRID — deliberately, because a typed cell is four numbers (the cell, its row
 * total, its day total in the header and the week total in the footer) and three
 * of them were computed from the same map. It worked, and it dropped its value
 * the instant the transition that set it ENDED: the cell fell back to the server
 * total and then jumped forward again when `router.refresh()` landed, which
 * reads as the grid losing work. The value now goes into the cached ENTRY LIST
 * that every one of those four numbers is summed from, so one patch still moves
 * all four and nothing reverts by itself.
 *
 * ⚠️ AND A REFUSED WRITE NEEDS REAL ROLLBACK CODE NOW. React used to put the old
 * number back for free. See the paragraph above.
 *
 * ------------------------------------------------------------------------
 * ⚠️ A LEAF MODULE, IMPORTING NOTHING BUT TYPES AND ITS TWO SIBLINGS, and that
 * is not a style preference — `lib/query/task-cache.ts` records what a cycle
 * through a component did to its predecessor. Nothing here may import a
 * component, and `QueryClient` is imported as a TYPE so this file contributes no
 * runtime edge at all.
 *
 * ⚠️ EVERY FUNCTION TAKES THE EXACT KEY IT PATCHES, unlike `task-cache.ts`,
 * which scans two roots. A task is one row that appears on several surfaces; an
 * hour belongs to ONE person's ONE week, and a tab can easily hold three weeks
 * at once because arrowing back through them is one click each. Scanning the
 * root would put Tuesday's typed hour into every cached week in the tab.
 * ------------------------------------------------------------------------
 */

/**
 * THE ROOT EVERY TIME SURFACE LIVES UNDER.
 *
 * `["timesheet"]` prefix-matches `qk.week(userId, weekStart)` and
 * `qk.teamWeekVisible(weekStart)` and `qk.loggableTasks()`. It is the SNAPSHOT
 * scope — what `onError` has to be able to put back — and it is deliberately
 * wider than the single key each patch below writes: a rollback that restores
 * less than the write could have touched is a rollback with a hole in it.
 */
const TIMESHEET_ROOTS: readonly QueryKey[] = [["timesheet"]];

/** Every `[key, data]` pair under the roots, as it stood before the write. */
export type TimesheetCacheSnapshot = CacheSnapshot;

/**
 * ⚠️ THE THREE BELOW ARE THIN NAMED WRAPPERS OVER `lib/query/write-cache.ts`,
 * WHICH HOLDS THEIR BODIES AND THEIR REASONING — the same arrangement
 * `task-cache.ts` has. Read that file for WHY the snapshot is synchronous, why
 * `cancelTimesheetRefetches` is FIRED AFTER the patch rather than awaited before
 * it, and why the rollback is the whole of `onError`. Both orderings were paid
 * for on the tasks surface and both are properties of TanStack rather than of
 * tasks, so they travel.
 */
export function beginTimesheetWrite(client: QueryClient): TimesheetCacheSnapshot {
  return beginWrite(client, TIMESHEET_ROOTS);
}

export function cancelTimesheetRefetches(client: QueryClient): void {
  cancelRefetches(client, TIMESHEET_ROOTS);
}

export function rollbackTimesheetWrite(
  client: QueryClient,
  snapshot: TimesheetCacheSnapshot,
): void {
  rollbackWrite(client, snapshot);
}

/* -------------------------------------------------------------------------- */
/* One person's week — the entry list every total is summed from.              */
/* -------------------------------------------------------------------------- */

/**
 * An entry as `qk.week(...)` holds it.
 *
 * ⚠️ STRUCTURAL AND DELIBERATELY LOOSE, matching `TaskFields` next door. The
 * authoritative shape is `timesheetEntryRowSchema`; restating it here would be a
 * third statement of the same columns, drifting from the other two on the first
 * new one.
 */
type EntryLike = { id: string; work_date: string; minutes: number } & Record<string, unknown>;

type WeekEntry = { entries?: unknown } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply an edit to the `entries` array of ONE week entry.
 *
 * ⚠️ AN UNCHANGED ENTRY IS RETURNED BY REFERENCE. `setQueryData` notifies its
 * observers whenever the reference moves, so rebuilding the week on a patch that
 * matched nothing would re-render the whole grid to change nothing at all —
 * which on a screen somebody is typing into is a lost keystroke waiting to
 * happen.
 *
 * ⚠️ AND A MISS IS SILENT ON PURPOSE. The week may not be in the cache: a flush
 * from `visibilitychange` fires while the tab is going away, and an unmount
 * cleanup fires after the query has been garbage-collected. There is nothing to
 * paint in either case and nothing has gone wrong.
 */
function editWeek(
  client: QueryClient,
  weekKey: QueryKey,
  edit: (entries: unknown[]) => unknown[],
): void {
  client.setQueryData(weekKey, (data: unknown) => {
    if (!isRecord(data) || !Array.isArray((data as WeekEntry).entries)) return data;

    const entries = (data as { entries: unknown[] }).entries;
    const next = edit(entries);
    return next === entries ? data : { ...data, entries: next };
  });
}

/**
 * A cell typed into for the first time.
 *
 * ⚠️ THE ROW IS MARKED AND SAYS SO. `placeholderId()` is not a uuid and
 * `isPlaceholder` is what the expanded breakdown reads to render the entry as
 * inert — no clock selects, no menu, no delete. Predicting that an hour WILL be
 * accepted is fine; offering to edit a row the server has not created is how
 * `optimistic-3` ends up in an action typed `uuid`, which is a real thing that
 * shipped on the tasks surface.
 *
 * ⚠️ `vizserve_pms_tasks` IS `null` AND THE VIEW IS WHAT COVERS FOR IT. There is
 * no task row in hand here — the embed is resolved by PostgREST — and inventing
 * one would be guessing at a title. `timesheet-view.tsx` resolves a row's title
 * from the first entry that HAS an embed and falls back to the picker's own copy
 * of the task, which is where a brand-new row's name comes from anyway.
 */
export function addPlaceholderEntry(
  client: QueryClient,
  weekKey: QueryKey,
  entry: {
    id: string;
    task_id: string;
    work_date: string;
    minutes: number;
    note: string | null;
    started_at: string | null;
    ended_at: string | null;
  },
): void {
  const row = { ...entry, vizserve_pms_tasks: null };
  editWeek(client, weekKey, (entries) => [...entries, row]);
}

/**
 * An entry corrected in place — a new length, a moved clock, a changed note, a
 * different day, a different task.
 *
 * All five go through one function because all five are one `UPDATE` in
 * `updateTimeEntry`, and splitting them here would be three chances to forget
 * that moving a day changes which column the cell is summed into.
 */
export function patchEntry(
  client: QueryClient,
  weekKey: QueryKey,
  entryId: string,
  fields: Partial<EntryLike>,
): void {
  editWeek(client, weekKey, (entries) => {
    let changed = false;
    const next = entries.map((entry) => {
      if (!isRecord(entry) || entry.id !== entryId) return entry;
      changed = true;
      return { ...entry, ...fields };
    });
    return changed ? next : entries;
  });
}

/** A cleared cell, or a deleted entry from the breakdown. */
export function removeEntry(client: QueryClient, weekKey: QueryKey, entryId: string): void {
  editWeek(client, weekKey, (entries) => {
    const next = entries.filter((entry) => !isRecord(entry) || entry.id !== entryId);
    return next.length === entries.length ? entries : next;
  });
}

/**
 * P7-05 — the week is handed in, so the grid goes read-only NOW.
 *
 * ⚠️ THE LOCK IS THE OPTIMISTIC PAINT HERE, and it is the honest one to make:
 * `isWeekLocked` drives whether the cells accept a keystroke at all, and every
 * entry policy calls `vizserve_pms_timesheet_week_locked`, so a keystroke typed
 * in the gap between pressing Submit and the server answering would have been
 * refused anyway — silently, because a refused UPDATE comes back as success with
 * zero rows and the number simply springs back.
 *
 * ⚠️ `id` IS A PLACEHOLDER AND NOTHING SENDS IT ANYWHERE. There may be no week
 * row at all before this write — no row IS the draft state — so the id is
 * invented for the shape and replaced by the refetch. Nothing on the member's
 * own screen reads it; the team grid is the only surface that acts on a week id,
 * and it never sees this entry.
 */
export function patchWeekSubmitted(
  client: QueryClient,
  weekKey: QueryKey,
  week: { id: string; status: string; submitted_at: string },
): void {
  client.setQueryData(weekKey, (data: unknown) => {
    if (!isRecord(data)) return data;
    return { ...data, week: { ...week, decision_reason: null } };
  });
}

/* -------------------------------------------------------------------------- */
/* The lead's week.                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A decision on somebody's week, on the row it was pressed on.
 *
 * ⚠️ THE ROW IS FOUND BY `weekId`, NOT BY PERSON. A lead can be looking at two
 * people with the same name in two departments — and more to the point the week
 * id is what the action takes, so matching on it is matching on the thing that
 * was actually decided.
 *
 * ⚠️ THE REASON IS PART OF THE PAINT. A returned week carries one by database
 * constraint, and the grid prints it under the chip; painting the status without
 * it would show "Returned" with no reason for the length of a round trip, on the
 * one row where the reason is the entire message.
 */
export function patchTeamWeekDecision(
  client: QueryClient,
  teamKey: QueryKey,
  weekId: string,
  next: { status: string; decisionReason: string | null },
): void {
  client.setQueryData(teamKey, (data: unknown) => {
    if (!isRecord(data) || !Array.isArray(data.rows)) return data;

    let changed = false;
    const rows = (data.rows as unknown[]).map((row) => {
      if (!isRecord(row) || row.weekId !== weekId) return row;
      changed = true;
      return { ...row, status: next.status, decisionReason: next.decisionReason };
    });

    return changed ? { ...data, rows } : data;
  });
}
