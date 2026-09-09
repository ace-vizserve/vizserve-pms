import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * ⚠️ NOTHING VARIABLE-LENGTH GOES IN A POSTGREST FILTER.
 *
 * This file guards one bug that produced no error anywhere, twice.
 *
 * `mineFilter` built an `or(...)` fragment holding every id from
 * `vizserve_pms_task_assignees`. Filters travel in the query string, and a real
 * user with 444 rows made a 16,542-character URL — `fetch` itself failed, with
 * no status code and no PostgREST message. Every caller did `data ?? []`, so it
 * rendered as an empty list: "you have no open tasks to hand over" to somebody
 * holding 22, and an empty Mine board to somebody with 388 tasks.
 *
 * Both are gone. The picker uses `fetchHandoverTasks` (two fixed-length
 * queries), and `/tasks` and `/tasks/board` use the `is_mine` computed column,
 * which sends a boolean. What is asserted here is that neither grows the habit
 * back — read as SOURCE, because the alternative is importing three server
 * modules to compare some strings.
 *
 * ⚠️ P12-07 MOVED THE CALLERS, NOT THE RULE. `/tasks` and `/tasks/board` build
 * their queries in `lib/query/fetchers/task-list.ts` now — the pages are auth
 * and a redirect — so the paths below follow the code. The rule is unchanged
 * and so is every assertion: whichever file BUILDS the filter is the file that
 * must not put an id list in it. `tests/unit/task-list-fetchers.test.ts` guards
 * the other side of the same bug, by asserting what the call actually sends.
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const CALLERS = [
  "lib/query/fetchers/task-list.ts",
  "app/(app)/tasks/page.tsx",
  "app/(app)/tasks/board/page.tsx",
  "app/(app)/approvals/page.tsx",
  "lib/tasks-server.ts",
];

describe("no id list ever reaches a PostgREST filter", () => {
  it.each(CALLERS)("%s builds no in.(...) clause from an array", (path) => {
    const source = read(path);

    // The exact shape of the bug: an array joined with commas, interpolated
    // into a filter fragment. `.in("col", ids)` is a different thing and is
    // fine — supabase-js sends those as a parameter, not as hand-built text.
    expect(source).not.toMatch(/in\.\(\$\{[^}]*join\(","\)\}/);
    expect(source).not.toMatch(/id\.in\.\(\$\{/);
  });

  it("mineFilter is gone entirely, not just unused", () => {
    // It was exported and had three callers. Leaving it exported is how it
    // comes back — the next person needing "mine" finds a helper named for
    // exactly that and reaches for it.
    expect(read("lib/tasks-server.ts")).not.toMatch(/export function mineFilter/);
  });
});

describe("the Mine view asks Postgres, not the URL", () => {
  it("names the computed column once and shares it", () => {
    // A wrong column name here is a PostgREST error at runtime and NOTHING at
    // compile time — it is a string the generated types have never heard of.
    //
    // ⚠️ P12-07 MOVED IT OUT OF `lib/tasks-server.ts`, which opens with
    // `import "server-only"` — the query is built in the BROWSER now, and a
    // client bundle reaching into that module is a build error by design. It
    // lives in `lib/schemas/tasks.ts`, which has no such import and is already
    // the home of every other shared rule about what a task is.
    expect(read("lib/schemas/tasks.ts")).toMatch(/export const MINE_COLUMN = "is_mine"/);
  });

  it("still has exactly ONE definition of it", () => {
    // The whole value of the constant is that there is one. `lib/tasks-server.ts`
    // RE-EXPORTS it so its existing server callers keep resolving; a second
    // `export const` there would be the drift this guards against.
    const server = read("lib/tasks-server.ts");
    expect(server).toMatch(/export \{ MINE_COLUMN \} from "@\/lib\/schemas\/tasks"/);
    expect(server).not.toMatch(/export const MINE_COLUMN/);
  });

  it.each(["lib/query/fetchers/task-list.ts"])(
    "%s filters through MINE_COLUMN",
    (path) => {
      const source = read(path);
      expect(source).toContain("MINE_COLUMN");
      // Never the literal, or the constant is decoration.
      expect(source).not.toMatch(/\.eq\("is_mine"/);
    },
  );

  it("has a migration defining the column it filters on", () => {
    // The recurring failure in this repo is a layer reaching for something no
    // migration created, or the reverse. `is_mine` is a computed column, so a
    // missing one is a PostgREST error on a page that used to work.
    const migration = read("supabase/migrations/20260905094000_p9_05_is_mine.sql");
    expect(migration).toMatch(/create or replace function is_mine\(t vizserve_pms_tasks\)/);
    // P7-43 semantics must survive the move into SQL: the PIC column always,
    // membership on internal work only.
    expect(migration).toContain("t.request_id is null");
    expect(migration).toContain("vizserve_pms_is_on_task");
  });
});
