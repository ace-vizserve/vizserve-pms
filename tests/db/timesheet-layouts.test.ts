import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, startOfWeek, todayInAppZone } from "@/lib/dates";

import { adminClient, anonClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P6-02d — the week's LAYOUT: which empty rows the grid draws, what order every
 * row sits in, and whether the last-week shortcut has been used.
 *
 * ⚠️ THIS TABLE IS NOT A DRAFT TIMESHEET, and the first test says so out loud.
 * P7-05's "the absence of a `vizserve_pms_timesheet_weeks` row IS the draft
 * state" is untouched by it; nothing here holds a minute. If a `minutes` column
 * ever appears in this table, that decision has been reversed by accident.
 *
 * The three things worth asserting against a real database:
 *
 *   * it is PRIVATE. Every other timesheet table lets a department lead read
 *     their team's rows. An arrangement is nobody's business but its owner's,
 *     and a policy that leaked it would leak silently — a lead simply seeing
 *     rows nobody meant them to see.
 *   * the UPSERT is idempotent. The whole feature is one debounced write per
 *     burst against `unique (user_id, week_start)`. Without the UPDATE policy's
 *     USING half the second save is refused as success-with-zero-rows, which is
 *     the failure mode nobody spots: the first save works, every one after it
 *     silently does not.
 *   * the Monday CHECK holds. A layout keyed to a Tuesday is one nothing reads.
 */

function announce(message: string) {
  process.stderr.write(`\n  ${message}\n`);
}

if (!dbTestsEnabled) announce(`timesheet-layouts.test.ts — ${skipReason}`);

/** Detected at MODULE LOAD — `it.skipIf` is evaluated during collection. */
const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_timesheet_layouts").select("id").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  announce(
    "timesheet-layouts.test.ts — SKIPPED. 20260912090000_p6_02d_timesheet_layout_survives_the" +
      "_tab.sql has not been applied to this project. Apply it, then re-run.",
  );
}

const run = dbTestsEnabled && migrationApplied;

const thisMonday = startOfWeek(todayInAppZone())!;
/** A week that is definitely over, so nothing here depends on what day it is. */
const lastMonday = addDays(thisMonday, -7)!;

/** Not real tasks. The column is a `uuid[]`, with no foreign key to dangle. */
const TASK_A = "11111111-1111-4111-8111-111111111111";
const TASK_B = "22222222-2222-4222-8222-222222222222";

const touchedUsers = new Set<string>();

let ownerId = "";
let otherId = "";

async function reset(userId: string) {
  touchedUsers.add(userId);
  await adminClient().from("vizserve_pms_timesheet_layouts").delete().eq("user_id", userId);
}

beforeAll(async () => {
  if (!run) return;

  ownerId = (await signIn("member1VizBytes")).userId;
  // A LEAD, not another member, because a lead is who could plausibly have been
  // given read access here and deliberately was not.
  otherId = (await signIn("tlVizBytes")).userId;

  await reset(ownerId);
});

afterAll(async () => {
  if (!run) return;
  for (const userId of touchedUsers) {
    await adminClient().from("vizserve_pms_timesheet_layouts").delete().eq("user_id", userId);
  }
});

describe.skipIf(!run)("P6-02d — the layout is the owner's alone", () => {
  it("holds an arrangement and no hours", async () => {
    const { client } = await signIn("member1VizBytes");
    await reset(ownerId);

    const { error } = await client.from("vizserve_pms_timesheet_layouts").insert({
      user_id: ownerId,
      week_start: lastMonday,
      extra_task_ids: [TASK_A],
      row_order: [TASK_A, TASK_B],
      copied_last_week: true,
    });
    expect(error).toBeNull();

    const { data } = await client
      .from("vizserve_pms_timesheet_layouts")
      .select("*")
      .eq("week_start", lastMonday)
      .single();

    expect(data?.extra_task_ids).toEqual([TASK_A]);
    expect(data?.row_order).toEqual([TASK_A, TASK_B]);
    expect(data?.copied_last_week).toBe(true);
    // The guard against this quietly becoming a draft timesheet. Hours belong
    // to `vizserve_pms_timesheet_entries` and only there.
    expect(Object.keys(data ?? {})).not.toContain("minutes");
  });

  it("saves the same week twice, which is what the debounce does all day", async () => {
    const { client } = await signIn("member1VizBytes");
    await reset(ownerId);

    const row = {
      user_id: ownerId,
      week_start: lastMonday,
      extra_task_ids: [TASK_A],
      row_order: [TASK_A],
      copied_last_week: false,
    };

    const first = await client
      .from("vizserve_pms_timesheet_layouts")
      .upsert(row, { onConflict: "user_id,week_start" });
    expect(first.error).toBeNull();

    // ⚠️ THE ONE THAT CATCHES A MISSING `using` HALF. A refused UPDATE is not an
    // error — PostgREST reports success and affects zero rows — so the second
    // save is checked by reading the row back, never by checking `error`.
    const second = await client
      .from("vizserve_pms_timesheet_layouts")
      .upsert(
        { ...row, extra_task_ids: [TASK_A, TASK_B], row_order: [TASK_B, TASK_A] },
        { onConflict: "user_id,week_start" },
      );
    expect(second.error).toBeNull();

    const { data } = await client
      .from("vizserve_pms_timesheet_layouts")
      .select("extra_task_ids, row_order")
      .eq("week_start", lastMonday);

    expect(data).toHaveLength(1);
    expect(data?.[0]?.extra_task_ids).toEqual([TASK_A, TASK_B]);
    expect(data?.[0]?.row_order).toEqual([TASK_B, TASK_A]);
  });

  it("hides one person's arrangement from their own team leader", async () => {
    await reset(ownerId);

    await adminClient().from("vizserve_pms_timesheet_layouts").insert({
      user_id: ownerId,
      week_start: lastMonday,
      extra_task_ids: [TASK_A],
    });

    const { client } = await signIn("tlVizBytes");
    const { data, error } = await client
      .from("vizserve_pms_timesheet_layouts")
      .select("id")
      .eq("user_id", ownerId);

    // Zero rows, not permission denied: a failing POLICY returns nothing, and
    // it is grants that raise. Both gates are working if this is `[]`.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("refuses a layout written against somebody else", async () => {
    const { client } = await signIn("member1VizBytes");
    touchedUsers.add(otherId);

    const { error } = await client.from("vizserve_pms_timesheet_layouts").insert({
      user_id: otherId,
      week_start: lastMonday,
      extra_task_ids: [TASK_A],
    });

    // An INSERT is the one verb whose refusal DOES raise — WITH CHECK gives
    // 42501, where a refused UPDATE would come back as success with no rows.
    expect(error).not.toBeNull();
  });

  it("refuses a week that is not a Monday", async () => {
    const { client } = await signIn("member1VizBytes");
    await reset(ownerId);

    const { error } = await client.from("vizserve_pms_timesheet_layouts").insert({
      user_id: ownerId,
      week_start: addDays(lastMonday, 1)!,
    });

    expect(error?.message ?? "").toMatch(/monday|check/i);
  });

  it("gives anon nothing at all", async () => {
    const { data, error } = await anonClient()
      .from("vizserve_pms_timesheet_layouts")
      .select("id")
      .limit(1);

    // `anon` holds no table privileges, so this is `permission denied` rather
    // than an empty result — grants, not RLS.
    expect(data ?? []).toEqual([]);
    expect(error).not.toBeNull();
  });
});
