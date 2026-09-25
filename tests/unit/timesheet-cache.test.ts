import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import { qk } from "@/lib/query/keys";
import { isPlaceholder, placeholderId } from "@/lib/query/placeholder";
import {
  addPlaceholderEntry,
  beginTimesheetWrite,
  patchEntry,
  patchTeamWeekDecision,
  patchWeekSubmitted,
  removeEntry,
  rollbackTimesheetWrite,
} from "@/lib/query/timesheet-cache";

/**
 * P12-23 — THE ROLLBACK CONTRACT, ON THE ONE SURFACE WHERE GETTING IT WRONG
 * COSTS SOMEBODY MONEY.
 *
 * ⚠️ THE DATA IS HOURS. Everywhere else in this app an optimistic paint that is
 * not rolled back leaves a wrong label on screen; here it leaves a
 * SAVED-LOOKING CELL THAT DID NOT SAVE, on the record pay is drawn from, with a
 * toast that scrolls away. Four controls write an entry — the grid cell, the
 * breakdown row, that row's menu and the cell popover — and every one of them
 * gave up a React-owned rollback (`useOptimistic` put the old number back for
 * free) for a hand-written one. This is the file that says the hand-written one
 * works.
 *
 * `tests/unit/task-cache.test.ts` is the model and its opening applies here
 * unchanged: the shape of every test is snapshot, patch, roll back, and assert
 * the cache is what it was.
 */

/** A week as `qk.week(userId, weekStart)` holds it — rows, not the grid. */
function weekEntry() {
  return {
    entries: [
      {
        id: "entry-a",
        task_id: "task-1",
        work_date: "2026-09-08",
        minutes: 60,
        note: null,
        started_at: "09:00",
        ended_at: "10:00",
        vizserve_pms_tasks: { title: "Alpha", status: "OPEN", list_id: null, department_id: null },
      },
      {
        id: "entry-b",
        task_id: "task-2",
        work_date: "2026-09-09",
        minutes: 120,
        note: "Reviewed the brief",
        started_at: null,
        ended_at: null,
        vizserve_pms_tasks: null,
      },
    ],
    week: null,
    overtime: [],
    departments: [],
    lists: [],
    schedule: { scheduledWeek: null, readFailure: null },
  };
}

/** A lead's week as `qk.teamWeekVisible(weekStart)` holds it — derived rows. */
function teamEntry() {
  return {
    rows: [
      {
        userId: "u1",
        name: "Ana",
        cells: { "2026-09-08": 480 },
        weekId: "week-1",
        status: "SUBMITTED",
        decisionReason: null,
      },
      {
        userId: "u2",
        name: "Ben",
        cells: {},
        weekId: "week-2",
        status: "SUBMITTED",
        decisionReason: null,
      },
    ],
    punchesLoaded: true,
    punchesError: null,
    settingsFellBack: false,
  };
}

const WEEK_KEY = qk.week("u1", "2026-09-07");
const TEAM_KEY = qk.teamWeekVisible("2026-09-07");

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(WEEK_KEY, weekEntry());
  client.setQueryData(TEAM_KEY, teamEntry());
});

function entriesIn(): { id: string; minutes: number; work_date: string }[] {
  return (client.getQueryData(WEEK_KEY) as { entries: { id: string; minutes: number; work_date: string }[] })
    .entries;
}

describe("rollback — the contract onError depends on", () => {
  it("restores the week exactly after a typed cell is refused", () => {
    const before = structuredClone(client.getQueryData(WEEK_KEY));

    const snapshot = beginTimesheetWrite(client);
    patchEntry(client, WEEK_KEY, "entry-a", { minutes: 90, ended_at: "10:30" });

    expect(entriesIn()[0]!.minutes).toBe(90);

    rollbackTimesheetWrite(client, snapshot);

    expect(client.getQueryData(WEEK_KEY)).toEqual(before);
  });

  it("restores the week exactly after a cleared cell is refused", () => {
    const before = structuredClone(client.getQueryData(WEEK_KEY));

    const snapshot = beginTimesheetWrite(client);
    removeEntry(client, WEEK_KEY, "entry-a");

    expect(entriesIn()).toHaveLength(1);

    rollbackTimesheetWrite(client, snapshot);

    expect(client.getQueryData(WEEK_KEY)).toEqual(before);
  });

  it("takes the predicted entry away again when the insert is refused", () => {
    const before = structuredClone(client.getQueryData(WEEK_KEY));

    const snapshot = beginTimesheetWrite(client);
    addPlaceholderEntry(client, WEEK_KEY, {
      id: placeholderId(),
      task_id: "task-3",
      work_date: "2026-09-10",
      minutes: 30,
      note: null,
      started_at: "15:00",
      ended_at: "15:30",
    });

    expect(entriesIn()).toHaveLength(3);

    rollbackTimesheetWrite(client, snapshot);

    expect(client.getQueryData(WEEK_KEY)).toEqual(before);
  });

  it("unlocks the week again when the submission is refused", () => {
    const before = structuredClone(client.getQueryData(WEEK_KEY));

    const snapshot = beginTimesheetWrite(client);
    patchWeekSubmitted(client, WEEK_KEY, {
      id: placeholderId(),
      status: "SUBMITTED",
      submitted_at: "2026-09-13T09:00:00Z",
    });

    expect((client.getQueryData(WEEK_KEY) as { week: unknown }).week).not.toBeNull();

    rollbackTimesheetWrite(client, snapshot);

    // The lock is the whole optimistic paint on that control, so a refusal that
    // did not restore it would leave somebody's week read-only over a message
    // they can no longer act on.
    expect(client.getQueryData(WEEK_KEY)).toEqual(before);
  });

  it("puts the chip back when a decision is refused", () => {
    const before = structuredClone(client.getQueryData(TEAM_KEY));

    const snapshot = beginTimesheetWrite(client);
    patchTeamWeekDecision(client, TEAM_KEY, "week-1", {
      status: "RETURNED",
      decisionReason: "Tuesday is missing.",
    });

    rollbackTimesheetWrite(client, snapshot);

    expect(client.getQueryData(TEAM_KEY)).toEqual(before);
  });

  it("restores BOTH weeks when a write touched one of them", () => {
    /*
     * ⚠️ THE SNAPSHOT IS WIDER THAN THE PATCH ON PURPOSE. `beginTimesheetWrite`
     * scans the whole `["timesheet"]` root, so a rollback covers every entry the
     * write could have reached — a lead editing their own hours has both grids in
     * the tab, and `onSettled` invalidates both.
     */
    const beforeWeek = structuredClone(client.getQueryData(WEEK_KEY));
    const beforeTeam = structuredClone(client.getQueryData(TEAM_KEY));

    const snapshot = beginTimesheetWrite(client);
    patchEntry(client, WEEK_KEY, "entry-b", { minutes: 999 });
    patchTeamWeekDecision(client, TEAM_KEY, "week-2", { status: "APPROVED", decisionReason: null });

    rollbackTimesheetWrite(client, snapshot);

    expect(client.getQueryData(WEEK_KEY)).toEqual(beforeWeek);
    expect(client.getQueryData(TEAM_KEY)).toEqual(beforeTeam);
  });
});

describe("the patches themselves", () => {
  it("moves an entry to another day, which is what re-buckets a cell", () => {
    patchEntry(client, WEEK_KEY, "entry-a", { work_date: "2026-09-09" });

    const moved = entriesIn().find((entry) => entry.id === "entry-a")!;
    expect(moved.work_date).toBe("2026-09-09");
  });

  it("leaves the entry list by reference when nothing matched", () => {
    /*
     * `setQueryData` notifies its observers whenever the reference moves, so a
     * patch that matched nothing must not rebuild the array — on a screen
     * somebody is typing into, a re-render for no reason is a lost keystroke
     * waiting to happen.
     */
    const before = entriesIn();
    patchEntry(client, WEEK_KEY, "entry-nowhere", { minutes: 5 });
    expect(entriesIn()).toBe(before);
  });

  it("leaves a week that is not in the cache alone rather than inventing one", () => {
    // A flush from `visibilitychange` fires while the tab is going away, and an
    // unmount cleanup fires after the query may have been garbage-collected.
    const missing = qk.week("u1", "2020-01-06");
    removeEntry(client, missing, "entry-a");
    expect(client.getQueryData(missing)).toBeUndefined();
  });

  it("marks a predicted entry with an id nothing can mistake for a uuid", () => {
    const id = placeholderId();

    addPlaceholderEntry(client, WEEK_KEY, {
      id,
      task_id: "task-3",
      work_date: "2026-09-10",
      minutes: 30,
      note: null,
      started_at: null,
      ended_at: null,
    });

    // The breakdown reads this to render the row INERT — no clocks, no menu, no
    // delete. `optimistic-3` reaching an action typed `uuid` is a real thing
    // that shipped on the tasks surface.
    expect(isPlaceholder(id)).toBe(true);
    expect(entriesIn().some((entry) => isPlaceholder(entry.id))).toBe(true);
  });

  it("carries no task embed on a predicted entry, so the view must name the row", () => {
    addPlaceholderEntry(client, WEEK_KEY, {
      id: placeholderId(),
      task_id: "task-3",
      work_date: "2026-09-10",
      minutes: 30,
      note: null,
      started_at: null,
      ended_at: null,
    });

    const added = (
      client.getQueryData(WEEK_KEY) as { entries: { vizserve_pms_tasks: unknown }[] }
    ).entries.at(-1)!;

    /*
     * PostgREST resolves that embed and the browser has nothing to resolve it
     * from, so it is null and `taskRowsFrom` in `week-grid.tsx` falls back to the
     * picker's own copy of the task. Without that fallback a cell typed into a
     * row with no hours yet would paint itself "Task no longer visible to you".
     */
    expect(added.vizserve_pms_tasks).toBeNull();
  });

  it("paints the reason with the status, because a RETURNED week cannot exist without one", () => {
    patchTeamWeekDecision(client, TEAM_KEY, "week-1", {
      status: "RETURNED",
      decisionReason: "Tuesday is missing.",
    });

    const row = (
      client.getQueryData(TEAM_KEY) as { rows: { weekId: string; status: string; decisionReason: string | null }[] }
    ).rows.find((candidate) => candidate.weekId === "week-1")!;

    expect(row.status).toBe("RETURNED");
    expect(row.decisionReason).toBe("Tuesday is missing.");
  });

  it("decides the row by week id, not by person", () => {
    patchTeamWeekDecision(client, TEAM_KEY, "week-2", { status: "APPROVED", decisionReason: null });

    const rows = (client.getQueryData(TEAM_KEY) as { rows: { weekId: string; status: string }[] }).rows;

    expect(rows.find((row) => row.weekId === "week-1")!.status).toBe("SUBMITTED");
    expect(rows.find((row) => row.weekId === "week-2")!.status).toBe("APPROVED");
  });
});
