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
 */

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const CALLERS = [
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
    expect(read("lib/tasks-server.ts")).toMatch(/export const MINE_COLUMN = "is_mine"/);
  });

  it("applies the column in exactly one place", () => {
    /*
     * ⚠️ THIS USED TO ASSERT THAT BOTH PAGES MENTIONED `MINE_COLUMN`, and P12-02
     * is why it no longer can: the scope filters moved into `applyTaskScope`,
     * so the pages name the SCOPE and the helper names the column. Asserting on
     * the old shape would now be asserting that the duplication comes back.
     *
     * The rule being guarded is unchanged — one definition, and a boolean on
     * the wire rather than an id list.
     */
    const helper = read("lib/tasks-server.ts");
    expect(helper).toMatch(/scoped = scoped\.eq\(MINE_COLUMN, true\)/);
    // Never the literal, or the constant is decoration.
    expect(helper).not.toMatch(/\.eq\("is_mine"/);
  });

  it.each(["app/(app)/tasks/page.tsx", "app/(app)/tasks/board/page.tsx"])(
    "%s scopes through the shared helper rather than its own copy",
    (path) => {
      const source = read(path);
      expect(source).toContain("applyTaskScope");
      /*
       * The three copies this replaced are what let `?group=`, `?status=` and
       * `?priority=` reach one view and not the other, and what let the board's
       * finished query apply half the QA filter. A page assembling `is_mine` or
       * the QA stages again has started a fourth.
       */
      expect(source).not.toMatch(/\.eq\(MINE_COLUMN/);
      expect(source).not.toMatch(/"FOR_QA", "QA_IN_PROGRESS"/);
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
