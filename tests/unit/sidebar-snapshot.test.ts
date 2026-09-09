import { describe, expect, it } from "vitest";

import { fetchSidebarSnapshot, type SnapshotClient } from "@/lib/query/fetchers/snapshot";

/**
 * P12-01 — the rail's one read.
 *
 * ONE HAPPY CASE, DELIBERATELY. The failure paths belong to `read()` and are
 * asserted once in `query-layer.test.ts`; re-testing them per domain would be
 * thirteen copies of the same three assertions. What is domain-specific here is
 * that the fetcher calls the RIGHT function and hands back the payload with the
 * component prop names intact — the migration builds `openTasks` / `isSystem` /
 * `isActive` itself precisely so there is no mapping layer, and this is the test
 * that would notice if one were quietly added.
 *
 * The client is an object literal. `fetchSidebarSnapshot` takes it as an
 * argument rather than importing one, which is what makes that possible without
 * a mocking framework.
 */

const DEPT = "d1000000-0000-4000-8000-00000000000a";
const LIST = "11111111-0000-4000-8000-000000000001";
const FOLDER = "22222222-0000-4000-8000-000000000002";
const MINE = "33333333-0000-4000-8000-000000000003";

const PAYLOAD = {
  unread: 3,
  awaiting_review: 1,
  spaces: [
    {
      departmentId: DEPT,
      departmentName: "VizBytes",
      lists: [{ id: LIST, name: "Collateral", openTasks: 4, pendingRequests: 0 }],
      folders: [
        {
          id: FOLDER,
          name: "Client Requests",
          isSystem: true,
          lists: [],
          openTasks: 0,
          pendingRequests: 1,
        },
      ],
    },
  ],
  // Archived and active together — the snapshot carries `isActive` rather than
  // filtering, because the only screen that could otherwise un-archive one
  // refuses a plain member. See rule (g) in the migration.
  personal: [{ id: MINE, name: "Errands", isActive: false }],
};

describe("fetchSidebarSnapshot", () => {
  it("calls the snapshot function and returns the parsed payload", async () => {
    const called: string[] = [];

    const client: SnapshotClient = {
      rpc: (fn) => {
        called.push(fn);
        return Promise.resolve({ data: PAYLOAD, error: null });
      },
    };

    const snapshot = await fetchSidebarSnapshot(client);

    expect(called).toEqual(["vizserve_pms_sidebar_snapshot"]);
    // Deep equality, not a shape check: the keys ARE the component props.
    expect(snapshot).toEqual(PAYLOAD);
  });
});
