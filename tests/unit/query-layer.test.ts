import type { PostgrestError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { normalize, qk } from "@/lib/query/keys";
import { invalidatedBy } from "@/lib/query/realtime";
import { ActionError, fieldErrorsOf, fromAction } from "@/lib/query/mutate";
import { isPermanent, read, ReadError } from "@/lib/query/read";

/**
 * P12-00 — the four paths through the query layer, tested once.
 *
 * ⚠️ THESE ARE PROPERTIES OF TWO FUNCTIONS, NOT OF THIRTEEN DOMAINS. `read()`
 * and `fromAction()` are the only two boundaries the whole app crosses, so the
 * rules live here rather than being re-asserted per feature.
 *
 * THE ONE THAT MATTERS IS `empty` VERSUS `sad`. This codebase has shipped that
 * confusion twice — `sidebar-panel.tsx`'s `?? []` turned a burst of
 * `TypeError: fetch failed` into an empty project tree with every count at zero,
 * and `mineFilter` built a 16,542-character URL that `fetch` refused with no
 * status, which every caller's `data ?? []` rendered as "you have no open tasks"
 * to somebody holding twenty-two. Both are the same bug: a failure that was
 * indistinguishable from a legal empty result. So the empty case is asserted to
 * RESOLVE and the sad case to THROW, side by side, because the pair is the
 * claim.
 *
 * No mocking framework, and there must not be one: everything here takes its
 * input as an argument, so an object literal is a complete test double.
 */

/** The shape PostgREST puts in `error`. Cast rather than constructed — the real
 *  class is an `Error` subclass and nothing here depends on that. */
function pgError(code: string, message: string): PostgrestError {
  return { name: "PostgrestError", message, details: "", hint: "", code } as unknown as PostgrestError;
}

describe("read — the happy path", () => {
  it("returns the rows", async () => {
    const rows = [{ id: "1" }, { id: "2" }];
    await expect(read(Promise.resolve({ data: rows, error: null }))).resolves.toEqual(rows);
  });
});

describe("read — empty is not failure", () => {
  it("resolves an empty array rather than throwing", async () => {
    // The whole reason `read` exists. If this ever starts throwing, every list
    // in the app reports "couldn't load" the day it is genuinely empty.
    await expect(read(Promise.resolve({ data: [], error: null }))).resolves.toEqual([]);
  });

  it("is distinguishable from the sad path", async () => {
    // Stated as one assertion because the two halves are only meaningful
    // together: same call site, same `[]`-looking outcome, opposite verdicts.
    const empty = read<unknown[]>(Promise.resolve({ data: [], error: null }));
    const failed = read<unknown[]>(
      Promise.resolve({ data: null, error: pgError("PGRST301", "gone") }),
    );

    await expect(empty).resolves.toEqual([]);
    await expect(failed).rejects.toBeInstanceOf(ReadError);
  });
});

describe("read — the sad path", () => {
  it("throws a ReadError with the sentence stripped and the code kept", async () => {
    const error = pgError(
      "P0001",
      "ERROR:  Only your own list.\nCONTEXT:  PL/pgSQL function vizserve_pms_lists_owner_guard()",
    );

    const failure = await read(Promise.resolve({ data: null, error })).catch(
      (thrown: unknown) => thrown,
    );

    expect(failure).toBeInstanceOf(ReadError);
    // The rules in this app live in the database and raise text written for a
    // person; `ERROR:` on the front and the `CONTEXT:` stack on the back are
    // not for the reader.
    expect((failure as ReadError).message).toBe("Only your own list.");
    // The code survives, because the retry policy is the thing that needs it.
    expect((failure as ReadError).code).toBe("P0001");
  });
});

describe("read — permission is permanent", () => {
  it("marks 42501 permanent", async () => {
    // Per CLAUDE.md's two-gate rule: a failing POLICY returns zero rows, a
    // missing GRANT returns `permission denied for table …`. The second never
    // becomes present on a retry.
    const failure = await read(
      Promise.resolve({ data: null, error: pgError("42501", "permission denied for table x") }),
    ).catch((thrown: unknown) => thrown);

    expect(isPermanent(failure)).toBe(true);
  });

  it("does not mark an ordinary failure permanent", async () => {
    const failure = await read(
      Promise.resolve({ data: null, error: pgError("PGRST301", "gone") }),
    ).catch((thrown: unknown) => thrown);

    expect(isPermanent(failure)).toBe(false);
  });
});

describe("fromAction", () => {
  it("resolves with the data on ok", async () => {
    const call = fromAction(async (id: string) => ({ ok: true as const, data: { id } }));
    await expect(call("t1")).resolves.toEqual({ id: "t1" });
  });

  it("throws an ActionError carrying the field errors", async () => {
    const call = fromAction(async () => ({
      ok: false as const,
      error: "That did not go through.",
      fieldErrors: { name: ["Too short."] },
    }));

    const failure = await call().catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(ActionError);
    expect((failure as ActionError).message).toBe("That did not go through.");
    // `fieldErrorsOf` is what a dialog hands to `<FieldError>`; reading it off
    // `mutation.error` is the whole reason the envelope carries them.
    expect(fieldErrorsOf(failure)).toEqual({ name: ["Too short."] });
  });
});

describe("normalize — one key, three spellings", () => {
  it("collapses {}, {status: undefined} and {status: \"\"}", () => {
    // All three come out of the same URL depending on whether the parameter was
    // present. Three cache entries for one view is not a crash — it is a
    // skeleton on a screen that already had the data.
    expect(normalize({})).toEqual({});
    expect(normalize({ status: undefined })).toEqual({});
    expect(normalize({ status: "" })).toEqual({});
  });

  it("produces one query key for all three", () => {
    const keys = [
      qk.taskList("l1", {}),
      qk.taskList("l1", { status: undefined }),
      qk.taskList("l1", { status: "" }),
    ].map((key) => JSON.stringify(key));

    expect(new Set(keys).size).toBe(1);
  });

  it("keeps a value that is actually set", () => {
    expect(normalize({ status: "OPEN", view: undefined })).toEqual({ status: "OPEN" });
  });
});

/**
 * Prefix matching is the invalidation API, so the two roots that look alike get
 * asserted rather than assumed.
 *
 * ⚠️ `["task", id]` AND `["tasks"]` ARE DIFFERENT ROOTS. Singular is one task
 * and its panels; plural is the list and board views. Neither prefixes the
 * other, however long you stare at the pair — and the realtime map got this
 * exactly wrong on the first pass, mapping comment events onto `["tasks"]`,
 * which would have refetched every list and never the thread the comment
 * appeared in. This is the test that catches it.
 */
function matches(prefix: readonly unknown[], key: readonly unknown[]) {
  return prefix.every((segment, index) => Object.is(segment, key[index]));
}

describe("query keys — prefix matching", () => {
  const id = "3f1a";

  it("a task part is swept by its own task", () => {
    expect(matches(qk.task(id), qk.taskPart(id, "comments"))).toBe(true);
  });

  it("a task part is NOT swept by the list root", () => {
    expect(matches(qk.tasks(), qk.taskPart(id, "comments"))).toBe(false);
  });

  it("one task does not sweep another", () => {
    expect(matches(qk.task(id), qk.taskPart("beef", "comments"))).toBe(false);
  });
});

describe("invalidatedBy", () => {
  it("an unmapped table sweeps nothing", () => {
    // Guessing wide would make every unmapped write refetch the whole app.
    expect(invalidatedBy("vizserve_pms_audit_log")).toEqual([]);
  });

  it("a task event moves the list AND the rail", () => {
    const keys = invalidatedBy("vizserve_pms_tasks");
    expect(keys).toContainEqual(qk.tasks());
    expect(keys).toContainEqual(qk.snapshot());
  });

  it("a notification moves the rail, because the unread badge lives in it", () => {
    // Regression: this row shipped as [qk.unread(), ["inbox"]] and `qk.unread()`
    // is a dead key — the badge is a field inside the snapshot, so a
    // notification arriving would have moved nothing anybody could see.
    expect(invalidatedBy("vizserve_pms_notifications")).toContainEqual(qk.snapshot());
  });

  it("a comment moves the task it is on, not just the lists", () => {
    expect(invalidatedBy("vizserve_pms_task_comments")).toContainEqual(["task"]);
  });
});
