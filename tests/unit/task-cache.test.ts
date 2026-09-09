import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";

import { qk } from "@/lib/query/keys";
import {
  beginTaskWrite,
  dropTaskRow,
  isPlaceholder,
  patchTaskRow,
  placeholderId,
  rollbackTaskWrite,
} from "@/lib/query/task-cache";

/**
 * P12-13 — THE ROLLBACK CONTRACT, WHICH TEN CONTROLS DEPEND ON AND NOTHING
 * ASSERTED.
 *
 * ⚠️ `lib/query/task-cache.ts` HAS CLAIMED IN CAPITALS SINCE P12-10 THAT
 * "`tests/unit/task-cache.test.ts` asserts exactly that: apply, refuse, and the
 * cache is byte-for-byte what it was". THE FILE DID NOT EXIST. The agent that
 * finished Phase 3 found it while converting the last seven controls.
 *
 * It matters more than the count of tests suggests. `useOptimistic` used to roll
 * back for free — React put the old value back when the transition ended, with
 * no code involved. Every one of those controls is now `onMutate` + `onError`,
 * and the rollback is hand-written. A dropped `onError`, or a snapshot taken at
 * the wrong moment, leaves the browser showing a value the DATABASE REFUSED,
 * with a toast that scrolls away — which is the failure `inline.tsx` forbids in
 * capitals.
 *
 * So the shape of every test here is: snapshot, patch, roll back, and assert the
 * cache is what it was.
 */

/** A list entry as `qk.taskList` holds it — rows plus the lookups keyed to them. */
function listEntry() {
  return {
    rows: [
      { id: "task-a", title: "Alpha", status: "IN_PROGRESS", priority: null },
      { id: "task-b", title: "Bravo", status: "TODO", priority: "HIGH" },
    ],
    assignees: [{ task_id: "task-a", user_id: "u1" }],
  };
}

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(qk.taskList("list-1", {}), listEntry());
  client.setQueryData(qk.task("task-a"), { task: { id: "task-a", status: "IN_PROGRESS" } });
});

describe("rollback — the contract onError depends on", () => {
  it("restores the cache exactly after a patch", () => {
    const before = structuredClone(client.getQueryData(qk.taskList("list-1", {})));

    const snapshot = beginTaskWrite(client);
    patchTaskRow(client, "task-a", { status: "FOR_QA" });

    // The patch really happened — otherwise the restore below proves nothing.
    expect(client.getQueryData<ReturnType<typeof listEntry>>(qk.taskList("list-1", {}))!.rows[0]!.status).toBe("FOR_QA");

    rollbackTaskWrite(client, snapshot);

    expect(client.getQueryData(qk.taskList("list-1", {}))).toEqual(before);
  });

  it("restores a dropped row", () => {
    const before = structuredClone(client.getQueryData(qk.taskList("list-1", {})));

    const snapshot = beginTaskWrite(client);
    dropTaskRow(client, "task-a");

    expect(client.getQueryData<ReturnType<typeof listEntry>>(qk.taskList("list-1", {}))!.rows).toHaveLength(1);

    rollbackTaskWrite(client, snapshot);

    expect(client.getQueryData(qk.taskList("list-1", {}))).toEqual(before);
  });

  it("leaves rows the write did not name alone", () => {
    const snapshot = beginTaskWrite(client);
    patchTaskRow(client, "task-a", { status: "FOR_QA" });

    const rows = client.getQueryData<ReturnType<typeof listEntry>>(qk.taskList("list-1", {}))!.rows;
    expect(rows[1]).toEqual({ id: "task-b", title: "Bravo", status: "TODO", priority: "HIGH" });

    rollbackTaskWrite(client, snapshot);
  });

  it("reaches every root a task lives under, not just the list", () => {
    // `["task", id]` as well as `["tasks"]` — a task is a row in a list AND the
    // subject of a detail entry, and a patch that moved only one of them would
    // show two different statuses on two surfaces.
    beginTaskWrite(client);
    patchTaskRow(client, "task-a", { status: "FOR_QA" });

    expect(
      client.getQueryData<{ task: { status: string } }>(qk.task("task-a"))!.task.status,
    ).toBe("FOR_QA");
  });
});

describe("placeholder ids", () => {
  /*
   * The guard against sending a made-up id to a `uuid` column. `optimistic-move`
   * recorded what it cost: a placeholder row rendered an ordinary task link and
   * prefetching `/tasks/optimistic-0` reached Postgres as
   * `invalid input syntax for type uuid`.
   */
  it("is recognisable and never a uuid", () => {
    const id = placeholderId();
    expect(isPlaceholder(id)).toBe(true);
    expect(id).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });

  it("does not mistake a real id for one", () => {
    expect(isPlaceholder("a6aa34f6-ccb7-530f-99e4-d43d4026f5dd")).toBe(false);
  });
});
