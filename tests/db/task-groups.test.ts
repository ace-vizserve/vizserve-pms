import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DEPARTMENTS, adminClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P7-18 — folders, and the reserved Client Requests folder.
 *
 * ⚠️ THIS FILE IS THE GATE ON THE MIGRATION, not a follow-up to it. It was
 * written before `20260819130000_p7_18_task_groups.sql` was ever pasted, and
 * nothing else in P7-18 lands until it is green.
 *
 * That ordering is not caution for its own sake. P7-16 applied cleanly and was
 * broken at runtime on every code path, and its first repair fixed only the line
 * the error named and was ALSO broken — because plpgsql resolves the functions a
 * body calls at FIRST EXECUTION, not at `create or replace` time. Reading SQL
 * proves nothing about it. This migration ships two SECURITY DEFINER functions,
 * three triggers and a `DO` block backfill; the only thing that establishes any
 * of them works is calling it.
 *
 * The keystone case is "creating a form auto-creates its list and sets
 * `default_list_id`". That is the one that exercises the forms trigger ->
 * `ensure_form_list` -> `ensure_client_folder` -> `lists_group_guard` chain in
 * one round trip, which is exactly the shape of thing that looks right on the
 * page and raises 42883 in production.
 */

/** `process.stderr.write`, not `console.warn` — vitest 4 swallows the latter at module level. */
function announce(message: string) {
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`task-groups.test.ts — ${skipReason}`);

/**
 * Detected at MODULE LOAD. `it.skipIf(...)` is evaluated during collection,
 * before any hook runs, so a flag set in `beforeAll` is still false at every skip
 * decision and the whole file skips silently even once the migration is in.
 *
 * Probed on the TABLE, because everything else in the migration hangs off it and
 * a database with the table but not the triggers is not a state this file can
 * reach — they are in the same paste.
 */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_task_groups").select("id").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "task-groups.test.ts — SKIPPED." +
      " supabase/migrations/20260819130000_p7_18_task_groups.sql is not applied to this project." +
      " Apply it in the dashboard SQL editor, then re-run.",
  );
}

const run = dbTestsEnabled && migrationApplied;

/** Unique per run — `slug` and `reference_prefix` are globally unique (P1-10). */
const RUN = Math.random().toString(36).slice(2, 7);

const createdForms: string[] = [];
const createdLists: string[] = [];
const createdGroups: string[] = [];

/** The VizBytes system folder, resolved once. Created by the migration's backfill. */
let systemGroupId = "";

async function makeGroup(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string | null; error: { message?: string; code?: string } | null }> {
  const { data, error } = await adminClient()
    .from("vizserve_pms_task_groups")
    .insert({
      department_id: DEPARTMENTS.VizBytes,
      name: `P7-18 folder ${Math.random().toString(36).slice(2, 8)}`,
      ...overrides,
    } as never)
    .select("id")
    .maybeSingle();

  if (data?.id) createdGroups.push(data.id);
  return { id: data?.id ?? null, error };
}

async function makeList(overrides: Record<string, unknown> = {}) {
  const { data, error } = await adminClient()
    .from("vizserve_pms_lists")
    .insert({
      department_id: DEPARTMENTS.VizBytes,
      name: `P7-18 list ${Math.random().toString(36).slice(2, 8)}`,
      ...overrides,
    } as never)
    .select("id")
    .maybeSingle();

  if (data?.id) createdLists.push(data.id);
  return { id: data?.id ?? null, error };
}

/**
 * A form, which is the thing that fires the whole trigger chain.
 *
 * `is_active: false` deliberately — an active form needs a department AND the
 * publishing rules, and none of that is what this file is testing. The trigger
 * fires on insert regardless.
 */
async function makeForm(overrides: Record<string, unknown> = {}) {
  const tag = Math.random().toString(36).slice(2, 7);

  const { data, error } = await adminClient()
    .from("vizserve_pms_forms")
    .insert({
      name: `P7-18 Form ${tag}`,
      slug: `p7-18-${RUN}-${tag}`,
      department_id: DEPARTMENTS.VizBytes,
      reference_prefix: `Q${RUN.slice(0, 3).toUpperCase()}${tag.slice(0, 2).toUpperCase()}`,
      is_public: true,
      is_active: false,
      ...overrides,
    } as never)
    .select("id, name")
    .maybeSingle();

  if (data?.id) createdForms.push(data.id);
  return { id: data?.id ?? null, name: data?.name ?? "", error };
}

async function formRow(id: string) {
  const { data } = await adminClient()
    .from("vizserve_pms_forms")
    .select("default_list_id, department_id, name")
    .eq("id", id)
    .single();
  return data!;
}

async function listOfForm(formId: string) {
  const { data } = await adminClient()
    .from("vizserve_pms_lists")
    .select("id, name, group_id, department_id, form_id")
    .eq("form_id", formId)
    .maybeSingle();
  return data;
}

beforeAll(async () => {
  if (!run) return;

  const { data } = await adminClient()
    .from("vizserve_pms_task_groups")
    .select("id")
    .eq("department_id", DEPARTMENTS.VizBytes)
    .eq("is_system", true)
    .maybeSingle();

  if (!data) {
    throw new Error(
      "VizBytes has no Client Requests folder.\n" +
        "  The migration's backfill creates one for every active department, so this means\n" +
        "  20260819130000_p7_18_task_groups.sql applied only partway. Re-paste it — it is idempotent.",
    );
  }

  systemGroupId = data.id;
});

afterAll(async () => {
  if (!run) return;

  const admin = adminClient();

  // FORMS FIRST. `lists.form_id` is `on delete cascade`, so deleting the form
  // takes its inbox list with it — and a list deleted this way never trips the
  // group guard, which is `before insert or update` only.
  if (createdForms.length > 0) {
    await admin.from("vizserve_pms_forms").delete().in("id", createdForms);
  }

  // Then any list this file made by hand. Some are already gone via the cascade
  // above; deleting by id is a no-op for those.
  if (createdLists.length > 0) {
    await admin.from("vizserve_pms_lists").delete().in("id", createdLists);
  }

  // Folders last — `lists.group_id` is `on delete restrict`, so an un-deleted
  // list would block its folder and leave a mess for the next run.
  //
  // The system folder is NOT in `createdGroups` and is deliberately never
  // deleted: its trigger refuses, and the backfill would recreate it anyway. It
  // is permanent state this project now carries, which is by design.
  if (createdGroups.length > 0) {
    await admin.from("vizserve_pms_task_groups").delete().in("id", createdGroups);
  }
});

// ---------------------------------------------------------------------------
// The ordinary shape
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-18 — folders hold lists", () => {
  it("puts a list in a folder and reads it back", async () => {
    const folder = await makeGroup();
    expect(folder.error).toBeNull();

    const list = await makeList({ group_id: folder.id });
    expect(list.error).toBeNull();

    const { data } = await adminClient()
      .from("vizserve_pms_lists")
      .select("group_id")
      .eq("id", list.id!)
      .single();

    expect(data!.group_id).toBe(folder.id);
  });

  it("leaves a list with no folder alone", async () => {
    // ClickUp's "Folderless List", and the state of every list that existed
    // before this migration. If this were refused the migration would need a
    // backfill of guesses.
    const list = await makeList();
    expect(list.error).toBeNull();

    const { data } = await adminClient()
      .from("vizserve_pms_lists")
      .select("group_id")
      .eq("id", list.id!)
      .single();

    expect(data!.group_id).toBeNull();
  });

  it("refuses a folder belonging to another department", async () => {
    // Without this the list appears in a tree its own department cannot see.
    const foreign = await makeGroup({ department_id: DEPARTMENTS.VizAssists });
    expect(foreign.error).toBeNull();

    const list = await makeList({ group_id: foreign.id });

    expect(list.id).toBeNull();
    expect(list.error?.message ?? "").toMatch(/another department/i);
  });
});

// ---------------------------------------------------------------------------
// The reserved folder
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-18 — the Client Requests folder", () => {
  it("exists for every active department", async () => {
    const { data: departments } = await adminClient()
      .from("vizserve_pms_departments")
      .select("id")
      .eq("is_active", true);

    const { data: systemGroups } = await adminClient()
      .from("vizserve_pms_task_groups")
      .select("department_id")
      .eq("is_system", true);

    const covered = new Set((systemGroups ?? []).map((row) => row.department_id));
    const missing = (departments ?? []).filter((row) => !covered.has(row.id));

    expect(missing).toHaveLength(0);
  });

  it("allows only one per department", async () => {
    // The partial unique index, and `ensure_client_folder`'s `on conflict`
    // infers it — so this is load-bearing rather than a safety net.
    const second = await makeGroup({ name: `Second system ${RUN}`, is_system: true });

    expect(second.id).toBeNull();
    expect(second.error?.code).toBe("23505");
  });

  it("cannot be renamed", async () => {
    const { error } = await adminClient()
      .from("vizserve_pms_task_groups")
      .update({ name: "Client Stuff" })
      .eq("id", systemGroupId);

    expect(error?.message ?? "").toMatch(/cannot be renamed/i);
  });

  it("cannot be archived", async () => {
    // An inbox nobody can see still receives.
    const { error } = await adminClient()
      .from("vizserve_pms_task_groups")
      .update({ is_active: false })
      .eq("id", systemGroupId);

    expect(error?.message ?? "").toMatch(/cannot be archived/i);
  });

  it("cannot be deleted", async () => {
    const { error } = await adminClient()
      .from("vizserve_pms_task_groups")
      .delete()
      .eq("id", systemGroupId);

    expect(error?.message ?? "").toMatch(/cannot be deleted/i);
  });

  it("cannot have its system flag turned off", async () => {
    // Flipping the flag is how somebody would get round every rule above, so it
    // is refused before the others are even checked.
    //
    // `as never` because `Update` deliberately omits `is_system` — which is the
    // type doing its job, and exactly why the cast is needed here: the front end
    // will be bypassed, and this asserts the DATABASE refuses it rather than
    // that TypeScript does.
    const { error } = await adminClient()
      .from("vizserve_pms_task_groups")
      .update({ is_system: false } as never)
      .eq("id", systemGroupId);

    expect(error?.message ?? "").toMatch(/turned into the Client Requests folder, or out of it/i);
  });

  it("cannot have the flag turned on for an ordinary folder", async () => {
    const folder = await makeGroup();

    const { error } = await adminClient()
      .from("vizserve_pms_task_groups")
      .update({ is_system: true } as never)
      .eq("id", folder.id!);

    expect(error?.message ?? "").toMatch(/turned into the Client Requests folder, or out of it/i);
  });

  it("refuses an ordinary list", async () => {
    // Everything in it arrived from a form. A hand-made list in here breaks that
    // sentence, which is the only thing the folder means.
    const list = await makeList({ group_id: systemGroupId });

    expect(list.id).toBeNull();
    expect(list.error?.message ?? "").toMatch(/one list per form/i);
  });
});

// ---------------------------------------------------------------------------
// THE KEYSTONE — a form files itself
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-18 — a form gets its own list", () => {
  it("creates the list in Client Requests and points the form at it", async () => {
    /*
     * The whole chain in one round trip: the `after insert` trigger on forms ->
     * `ensure_form_list` -> `ensure_client_folder` -> the list insert ->
     * `lists_group_guard`. If any of those five is wrong this is where it
     * surfaces, and nowhere earlier — which is the entire reason this file
     * exists before the paste rather than after it.
     */
    const form = await makeForm();
    expect(form.error).toBeNull();

    const list = await listOfForm(form.id!);
    expect(list).not.toBeNull();
    expect(list!.group_id).toBe(systemGroupId);
    expect(list!.department_id).toBe(DEPARTMENTS.VizBytes);

    // And P2-06 is now wired to it, which is what makes `approve_request` file
    // client work into the right folder without being touched at all.
    expect((await formRow(form.id!)).default_list_id).toBe(list!.id);
  });

  it("names the list after the form", async () => {
    const form = await makeForm();
    const list = await listOfForm(form.id!);

    expect(list!.name).toBe(form.name);
  });

  it("does nothing for a form with no department", async () => {
    // A form with no department cannot route yet (p1_01 blocks activation for
    // the same reason), so there is nowhere to put its list.
    const form = await makeForm({ department_id: null });
    expect(form.error).toBeNull();

    expect(await listOfForm(form.id!)).toBeNull();
    expect((await formRow(form.id!)).default_list_id).toBeNull();
  });

  it("creates the list when the department is set later", async () => {
    // The ordinary case of a form drafted first and routed afterwards, which
    // p1_01 explicitly allows. This is what the `update of department_id` half
    // of the trigger is for.
    const form = await makeForm({ department_id: null });

    const { error } = await adminClient()
      .from("vizserve_pms_forms")
      .update({ department_id: DEPARTMENTS.VizBytes })
      .eq("id", form.id!);

    expect(error).toBeNull();

    const list = await listOfForm(form.id!);
    expect(list).not.toBeNull();
    expect(list!.group_id).toBe(systemGroupId);
    expect((await formRow(form.id!)).default_list_id).toBe(list!.id);
  });

  it("is idempotent — a second call makes no second list", async () => {
    const form = await makeForm();
    const first = await listOfForm(form.id!);

    // Re-firing the trigger the way `seed-dev.sql`'s `on conflict do update set
    // department_id` does: Postgres fires an `update of department_id` trigger
    // whenever the column is in the SET list, changed or not.
    await adminClient()
      .from("vizserve_pms_forms")
      .update({ department_id: DEPARTMENTS.VizBytes })
      .eq("id", form.id!);

    const { data: all } = await adminClient()
      .from("vizserve_pms_lists")
      .select("id")
      .eq("form_id", form.id!);

    expect(all).toHaveLength(1);
    expect(all![0]!.id).toBe(first!.id);
  });

  it("disambiguates a name that is already taken in the department", async () => {
    // Lists are unique on (department_id, name) and form names are not unique,
    // so this collision is a question of when. Falling over here would mean a
    // team leader simply cannot create a form.
    const taken = `P7-18 Clash ${RUN}`;
    await makeList({ name: taken });

    const form = await makeForm({ name: taken });
    expect(form.error).toBeNull();

    const list = await listOfForm(form.id!);
    expect(list).not.toBeNull();
    expect(list!.name).not.toBe(taken);
    expect(list!.name).toContain(taken);
  });

  it("does not overrule a default list somebody chose by hand", async () => {
    // The migration sets `default_list_id` only when null, precisely so a lead's
    // explicit choice survives. Asserted because "only when null" is one `and`
    // away from silently rewriting it.
    const chosen = await makeList();
    const form = await makeForm({ department_id: null });

    await adminClient()
      .from("vizserve_pms_forms")
      .update({ default_list_id: chosen.id })
      .eq("id", form.id!);

    await adminClient()
      .from("vizserve_pms_forms")
      .update({ department_id: DEPARTMENTS.VizBytes })
      .eq("id", form.id!);

    // The inbox list is still created — it is where the folder gets its shape —
    // but the form keeps pointing where the human pointed it.
    expect(await listOfForm(form.id!)).not.toBeNull();
    expect((await formRow(form.id!)).default_list_id).toBe(chosen.id);
  });

  it("will not let a form's list be moved out of the folder", async () => {
    const form = await makeForm();
    const list = await listOfForm(form.id!);

    const ordinary = await makeGroup();

    const { error: moved } = await adminClient()
      .from("vizserve_pms_lists")
      .update({ group_id: ordinary.id })
      .eq("id", list!.id);

    expect(moved?.message ?? "").toMatch(/Client Requests folder/i);

    // And not out to the top level either — "folderless" is legal for an
    // ordinary list and not for this one.
    const { error: orphaned } = await adminClient()
      .from("vizserve_pms_lists")
      .update({ group_id: null })
      .eq("id", list!.id);

    expect(orphaned?.message ?? "").toMatch(/cannot be moved out of it/i);
  });
});

// ---------------------------------------------------------------------------
// Scope — P7-17's rule, one level up
// ---------------------------------------------------------------------------

describe.skipIf(!run)("P7-18 — who can see and shape a folder", () => {
  it("lets a member read their own department's folders", async () => {
    // Same reasoning as P7-17: a team that cannot see its own board keeps a
    // second board somewhere else. The sidebar tree is the whole point.
    const folder = await makeGroup();
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_task_groups")
      .select("id")
      .eq("id", folder.id!);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("hides another department's folders from them", async () => {
    const foreign = await makeGroup({ department_id: DEPARTMENTS.VizAssists });
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_task_groups")
      .select("id")
      .eq("id", foreign.id!);

    // Zero rows is a working policy. `permission denied` would be a missing
    // GRANT and a different bug — the default privileges from p0_06 should have
    // covered this table automatically.
    expect(error).toBeNull();
    expect(data).toHaveLength(0);
  });

  it("does not let a member create one", async () => {
    // Seeing the tree is not reshaping it — the same split P7-17 made on tasks,
    // where SELECT widened and UPDATE deliberately did not.
    const { client } = await signIn("member1VizBytes");

    const { data, error } = await client
      .from("vizserve_pms_task_groups")
      .insert({ department_id: DEPARTMENTS.VizBytes, name: `Member folder ${RUN}` } as never)
      .select("id");

    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();
  });

  it("lets the department's lead create one", async () => {
    const tl = await signIn("tlVizBytes");

    const { data, error } = await tl.client
      .from("vizserve_pms_task_groups")
      .insert({ department_id: DEPARTMENTS.VizBytes, name: `TL folder ${RUN}` } as never)
      .select("id")
      .single();

    expect(error).toBeNull();
    if (data?.id) createdGroups.push(data.id);
  });

  it("does not let a lead create one in a department they do not lead", async () => {
    const tl = await signIn("tlVizBytes");

    const { data, error } = await tl.client
      .from("vizserve_pms_task_groups")
      .insert({ department_id: DEPARTMENTS.VizMedia, name: `Wrong dept ${RUN}` } as never)
      .select("id");

    expect(data ?? []).toHaveLength(0);
    expect(error).not.toBeNull();
  });
});
