import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/database.types";
import { TASK_TRANSITIONS } from "@/lib/schemas/tasks";

import {
  DEPARTMENTS,
  adminClient,
  anonClient,
  dbTestsEnabled,
  signIn,
  skipReason,
} from "./helpers";

/**
 * P3-15 — the status machine, the resolution gate, and task scope.
 *
 * The exit criteria this file exists to prove:
 *   * every legal transition works; every illegal one is rejected server-side
 *   * a direct API call cannot reach FOR_QA with an empty resolution
 *   * QA rejection returns to ONGOING with the comment visible to the PIC
 *   * WAITING_FOR_INFO duration is queryable per task
 *   * a member sees only tasks where they are PIC or QA
 */

if (!dbTestsEnabled) console.warn(`\n  tasks.test.ts — ${skipReason}\n`);

const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_task_transitions").select("to_status").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  console.warn(
    "\n  tasks.test.ts — SKIPPED. supabase/migrations/20260803130000_p3_tasks_qa.sql" +
      " has not been applied to this project. Apply it, then re-run.\n",
  );
}

// P7-01 and P7-02 land in separate migrations, so they are probed separately —
// a suite that skips as one lump cannot tell you which half is missing.
const personalTasksApplied =
  dbTestsEnabled && migrationApplied
    ? !(await adminClient().from("vizserve_pms_tasks").select("is_personal").limit(1)).error
    : false;

const completionApplied =
  dbTestsEnabled && migrationApplied
    ? !(await adminClient().from("vizserve_pms_task_transitions").select("applies_to").limit(1))
        .error
    : false;

if (dbTestsEnabled && migrationApplied && !personalTasksApplied) {
  process.stderr.write(
    "\n  tasks.test.ts — P7-01 cases SKIPPED." +
      " supabase/migrations/20260818090000_p7_01_personal_tasks.sql is not applied.\n",
  );
}

if (dbTestsEnabled && migrationApplied && !completionApplied) {
  process.stderr.write(
    "\n  tasks.test.ts — P7-02 cases SKIPPED." +
      " supabase/migrations/20260818090100_p7_02_personal_task_completion.sql is not applied.\n",
  );
}

// P7-06/08/09 land in their own migrations again, so again they are probed
// separately rather than as one lump.
const flexibilityApplied =
  dbTestsEnabled && migrationApplied
    ? !(await adminClient().from("vizserve_pms_tasks").select("start_date").limit(1)).error
    : false;

const commentsApplied =
  dbTestsEnabled && migrationApplied
    ? !(await adminClient().from("vizserve_pms_task_comments").select("id").limit(1)).error
    : false;

const subtasksApplied =
  dbTestsEnabled && migrationApplied
    ? !(await adminClient().from("vizserve_pms_tasks").select("parent_task_id").limit(1)).error
    : false;

const priorityApplied =
  dbTestsEnabled && migrationApplied
    ? !(await adminClient().from("vizserve_pms_tasks").select("priority").limit(1)).error
    : false;

const assigneesApplied =
  dbTestsEnabled && migrationApplied
    ? !(await adminClient().from("vizserve_pms_task_assignees").select("task_id").limit(1)).error
    : false;

const estimateApplied =
  dbTestsEnabled && migrationApplied
    ? !(await adminClient().from("vizserve_pms_tasks").select("estimate_minutes").limit(1)).error
    : false;

for (const [flag, label, file] of [
  [flexibilityApplied, "P7-06", "20260818120000_p7_06_task_flexibility.sql"],
  [commentsApplied, "P7-08", "20260818120200_p7_08_task_comments.sql"],
  [subtasksApplied, "P7-09", "20260818120300_p7_09_subtasks.sql"],
  [priorityApplied, "P7-11", "20260818140000_p7_11_task_priority.sql"],
  [assigneesApplied, "P7-13", "20260818160000_p7_13_task_assignees.sql"],
  [estimateApplied, "P7-15", "20260818180000_p7_15_estimate_and_tracked.sql"],
] as const) {
  if (dbTestsEnabled && migrationApplied && !flag) {
    process.stderr.write(`\n  tasks.test.ts — ${label} cases SKIPPED. ${file} is not applied.\n`);
  }
}

const created: string[] = [];
const createdRequests: string[] = [];
let picId = "";
let qaId = "";
let formId = "";

/** Unique per run — reference_prefix is globally unique (P1-10). */
const REQUEST_SLUG = `p7-tasks-${Math.random().toString(36).slice(2, 8)}`;

/** A fresh OPEN task with a known PIC and QA. */
async function makeTask(overrides: Record<string, unknown> = {}): Promise<string> {
  const { client } = await signIn("tlVizBytes");

  const { data, error } = await client.rpc("vizserve_pms_create_task", {
    p_department_id: DEPARTMENTS.VizBytes,
    p_title: `P3 fixture ${Math.random().toString(36).slice(2, 8)}`,
    p_description: "Created by the P3 suite.",
    p_assignee_id: picId,
    p_qa_assignee_id: qaId,
    p_due_date: "2026-12-01",
    p_list_id: null,
    ...overrides,
  });

  if (error) throw new Error(`fixture task: ${error.message}`);

  const id = (data as { task_id: string }).task_id;
  created.push(id);
  return id;
}

/**
 * A task with a real client request behind it.
 *
 * Needed because `makeTask` produces `request_id = null` — which used to be
 * irrelevant and stopped being so when P7-02 scoped the client gate to work that
 * actually has a client. Built the long way round, through the public form and
 * Gate 1, because that is the only way a request-backed task is ever made.
 */
async function makeRequestTask(): Promise<string> {
  const { data: submitted } = await anonClient().rpc("vizserve_pms_submit_request", {
    p_slug: REQUEST_SLUG,
    p_payload: {
      requester_name: "Juan dela Cruz",
      requester_email: `p7.${Math.random().toString(36).slice(2, 8)}@example.com`,
      title: "Poster for the open day",
      description: "A3, portrait, two variants.",
      target_date: "2026-12-01",
      field_values: {},
    } as Json,
    p_attachments: [],
    p_ip: `10.7.0.${Math.floor(Math.random() * 250)}`,
  });

  const submission = submitted as { ok: boolean; request_id?: string };
  if (!submission.ok) throw new Error(`fixture request: ${JSON.stringify(submitted)}`);
  createdRequests.push(submission.request_id!);

  const { client } = await signIn("tlVizBytes");
  const { data, error } = await client.rpc("vizserve_pms_approve_request", {
    p_request_id: submission.request_id!,
    p_assignee_id: picId,
    p_qa_assignee_id: qaId,
    p_approved_target_date: null,
    p_title: null,
    p_description: null,
    p_list_id: null,
  });

  if (error) throw new Error(`fixture approval: ${error.message}`);

  const id = (data as { task_id: string }).task_id;
  created.push(id);
  return id;
}

/** Drives a task to a given status using the legitimate path. */
async function advanceTo(taskId: string, target: string) {
  const pic = await signIn("member1VizBytes");
  const qa = await signIn("member2VizBytes");
  const admin = adminClient();

  await pic.client.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: "ONGOING",
    p_comment: null,
  });
  if (target === "ONGOING") return;

  if (target === "WAITING_FOR_INFO") {
    await pic.client.rpc("vizserve_pms_transition_task", {
      p_task_id: taskId,
      p_to_status: "WAITING_FOR_INFO",
      p_comment: "Waiting on the client to confirm the headline.",
    });
    return;
  }

  // The gate is real, so the resolution goes in before FOR_QA is reachable.
  await admin
    .from("vizserve_pms_tasks")
    .update({ resolution: "Produced two A3 variants; link in the output field." })
    .eq("id", taskId);

  await pic.client.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: "FOR_QA",
    p_comment: null,
  });
  if (target === "FOR_QA") return;

  await qa.client.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: "QA_IN_PROGRESS",
    p_comment: null,
  });
  if (target === "QA_IN_PROGRESS") return;

  await qa.client.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: "FOR_CLIENT_APPROVAL",
    p_comment: null,
  });
}

async function statusOf(taskId: string): Promise<string> {
  const { data } = await adminClient()
    .from("vizserve_pms_tasks")
    .select("status")
    .eq("id", taskId)
    .single();
  return data!.status;
}

describe.skipIf(!dbTestsEnabled)("P3 tasks and QA", () => {
  beforeAll(async () => {
    if (!migrationApplied) return;

    const { data: members } = await adminClient()
      .from("vizserve_pms_users")
      .select("id, email")
      .eq("primary_department_id", DEPARTMENTS.VizBytes)
      .eq("role", "member")
      .order("email");

    // member1 is the PIC, member2 the QA — different people, which is the only
    // arrangement in which the QA gate means anything.
    picId = members![0]!.id;
    qaId = members![1]!.id;

    // The form only exists so `makeRequestTask` has something to submit through.
    const { data: form, error } = await adminClient()
      .from("vizserve_pms_forms")
      .insert({
        name: "P7 fixture form",
        slug: REQUEST_SLUG,
        department_id: DEPARTMENTS.VizBytes,
        reference_prefix: `Q${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
        is_public: true,
        is_active: true,
      })
      .select("id")
      .single();

    if (error) throw new Error(`fixture form: ${error.message}`);
    formId = form!.id;
  });

  afterAll(async () => {
    const admin = adminClient();

    if (created.length > 0) {
      await admin.from("vizserve_pms_notifications").delete().in("entity_id", created);
      await admin.from("vizserve_pms_tasks").delete().in("id", created);
    }

    // Tasks first, then the requests they hung off, then the form — the FKs run
    // that way and a failed cleanup leaves a slug that collides next run.
    if (createdRequests.length > 0) {
      await admin.from("vizserve_pms_notifications").delete().in("entity_id", createdRequests);
      await admin.from("vizserve_pms_requests").delete().in("id", createdRequests);
    }

    if (formId) await admin.from("vizserve_pms_forms").delete().eq("id", formId);
  });

  // =========================================================================
  // The two copies of the transition table must agree
  // =========================================================================
  describe("the contract mirrors the database", () => {
    // Gated on the LATEST migration that touches this table, not the earliest.
    // The mirror now carries `applies_to` (P7-02) and the free-movement rows
    // (P7-06), so it cannot agree with a database that predates either — and a
    // red mirror test on an un-applied migration teaches people to ignore it.
    // Move this gate forward every time a migration adds a transition.
    it.skipIf(!flexibilityApplied)(
      "lib/schemas/tasks.ts matches vizserve_pms_task_transitions row for row",
      async () => {
        // Two copies of a rule is drift waiting to happen. The database is the
        // authority — it rejects the illegal move — and the TypeScript copy
        // exists so the UI knows which buttons to draw. This is what keeps them
        // honest, rather than the app quietly offering a button the server
        // refuses.
        //
        // `applies_to` is compared as well. A column present in one copy and
        // absent from the other is precisely the drift this test exists to
        // catch, and leaving it out would let the two disagree about which
        // tasks a transition is legal for while the test still passed.
        const { data: rows } = await adminClient()
          .from("vizserve_pms_task_transitions")
          .select("from_status, to_status, actor, required_field, applies_to");

        const fromDb = (rows ?? [])
          .map(
            (row) =>
              `${row.from_status}->${row.to_status}:${row.actor}:${row.required_field ?? "none"}:${row.applies_to}`,
          )
          .sort();

        const fromTs = TASK_TRANSITIONS.map(
          (t) => `${t.from}->${t.to}:${t.actor}:${t.requires ?? "none"}:${t.appliesTo}`,
        ).sort();

        expect(fromTs).toEqual(fromDb);
      },
    );
  });

  // =========================================================================
  // "A direct API call cannot reach FOR_QA with an empty resolution."
  // =========================================================================
  describe("the resolution gate (P3-07)", () => {
    it.skipIf(!migrationApplied)("refuses FOR_QA while the resolution is empty", async () => {
      // CLIENT work, since P7-13. This gate is gone for internal tasks — work
      // with no client moves freely — but it is exactly as strict as it ever
      // was for work a client is waiting on, which is what it existed to
      // protect.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "ONGOING");

      const { client } = await signIn("member1VizBytes");
      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "FOR_QA",
        p_comment: null,
      });

      expect(error).not.toBeNull();
      expect(await statusOf(taskId)).toBe("ONGOING");
    });

    it.skipIf(!migrationApplied)("refuses a whitespace-only resolution", async () => {
      // CLIENT work, since P7-13. This gate is gone for internal tasks — work
      // with no client moves freely — but it is exactly as strict as it ever
      // was for work a client is waiting on, which is what it existed to
      // protect.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "ONGOING");

      await adminClient().from("vizserve_pms_tasks").update({ resolution: "    " }).eq("id", taskId);

      const { client } = await signIn("member1VizBytes");
      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "FOR_QA",
        p_comment: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("allows FOR_QA once a resolution is recorded", async () => {
      const taskId = await makeTask();
      await advanceTo(taskId, "FOR_QA");
      expect(await statusOf(taskId)).toBe("FOR_QA");
    });
  });

  // =========================================================================
  // THE structural guarantee: status is not an updatable column
  // =========================================================================
  describe("status cannot be written directly", () => {
    it.skipIf(!migrationApplied)(
      "a PIC cannot UPDATE their way past the gate",
      async () => {
        // RLS lets the PIC update their own task, and RLS cannot express "but
        // not that column". The column-level GRANT can, and this is the test
        // that proves it — without it, every rule in the state machine is
        // one PATCH away from irrelevant.
        const taskId = await makeTask();
        await advanceTo(taskId, "ONGOING");

        const { client } = await signIn("member1VizBytes");

        // Cast past the Update type deliberately. TypeScript already refuses
        // this — `status` is absent from the Update shape — and that is the
        // first line of defence. This test is about the SECOND: that the
        // database refuses it too, for a caller who never went through our
        // types at all.
        await client
          .from("vizserve_pms_tasks")
          .update({ status: "COMPLETED" } as never)
          .eq("id", taskId);

        expect(await statusOf(taskId)).toBe("ONGOING");
      },
    );

    it.skipIf(!migrationApplied)("a TL cannot UPDATE status directly either", async () => {
      const taskId = await makeTask();
      const { client } = await signIn("tlVizBytes");

      await client
        .from("vizserve_pms_tasks")
        .update({ status: "FOR_CLIENT_APPROVAL" } as never)
        .eq("id", taskId);

      expect(await statusOf(taskId)).toBe("OPEN");
    });

    it.skipIf(!migrationApplied)("but the PIC CAN still write the resolution", async () => {
      // The gate is "you may not reach FOR_QA without it", not "you may not
      // write it". Getting that backwards would make the field unfillable.
      const taskId = await makeTask();
      const { client } = await signIn("member1VizBytes");

      const { error } = await client
        .from("vizserve_pms_tasks")
        .update({ resolution: "Drafted the copy." })
        .eq("id", taskId);

      expect(error).toBeNull();

      const { data } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("resolution")
        .eq("id", taskId)
        .single();
      expect(data!.resolution).toBe("Drafted the copy.");
    });
  });

  // =========================================================================
  // "Every legal transition works; every illegal one is rejected."
  // =========================================================================
  describe("the state machine", () => {
    it.skipIf(!migrationApplied)("walks the whole legal path end to end", async () => {
      // Request-backed: since P7-02 the client gate only accepts work that has
      // a client behind it, and this walk ends at that gate.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "FOR_CLIENT_APPROVAL");
      expect(await statusOf(taskId)).toBe("FOR_CLIENT_APPROVAL");

      const { data: history } = await adminClient()
        .from("vizserve_pms_task_status_history")
        .select("from_status, to_status")
        .eq("task_id", taskId)
        .order("created_at");

      // Including the creation row — a task is born into OPEN rather than moving
      // there, and a history that starts at the second event cannot answer "how
      // long did this sit unstarted".
      expect(history!.map((row) => row.to_status)).toEqual([
        "OPEN",
        "ONGOING",
        "FOR_QA",
        "QA_IN_PROGRESS",
        "FOR_CLIENT_APPROVAL",
      ]);
      expect(history![0]!.from_status).toBeNull();
    });

    it.skipIf(!migrationApplied)("rejects OPEN → COMPLETED", async () => {
      // CLIENT work, since P7-13. This gate is gone for internal tasks — work
      // with no client moves freely — but it is exactly as strict as it ever
      // was for work a client is waiting on, which is what it existed to
      // protect.
      const taskId = await makeRequestTask();
      const { client } = await signIn("tlVizBytes");

      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "COMPLETED",
        p_comment: null,
      });

      expect(error).not.toBeNull();
      expect(await statusOf(taskId)).toBe("OPEN");
    });

    it.skipIf(!migrationApplied)("rejects skipping QA entirely", async () => {
      // ONGOING → FOR_CLIENT_APPROVAL is the transition that would make Gate 2
      // optional, so it is the one most worth asserting.
      const taskId = await makeTask();
      await advanceTo(taskId, "ONGOING");

      const { client } = await signIn("tlVizBytes");
      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "FOR_CLIENT_APPROVAL",
        p_comment: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("rejects moving to the status it is already in", async () => {
      const taskId = await makeTask();
      const { client } = await signIn("tlVizBytes");

      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "OPEN",
        p_comment: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("refuses the client transitions to ordinary staff", async () => {
      // FOR_CLIENT_APPROVAL → COMPLETED belongs to Phase 4's token flow. A TL
      // marking work complete on the client's behalf is exactly the thing Gate 3
      // exists to prevent.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "FOR_CLIENT_APPROVAL");

      const { client } = await signIn("tlVizBytes");
      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "COMPLETED",
        p_comment: null,
      });

      expect(error).not.toBeNull();
      expect(await statusOf(taskId)).toBe("FOR_CLIENT_APPROVAL");
    });
  });

  // =========================================================================
  // Who may move what
  // =========================================================================
  describe("actor rules", () => {
    it.skipIf(!migrationApplied)("the QA reviewer cannot start the PIC's work", async () => {
      // CLIENT work, since P7-13. This gate is gone for internal tasks — work
      // with no client moves freely — but it is exactly as strict as it ever
      // was for work a client is waiting on, which is what it existed to
      // protect.
      const taskId = await makeRequestTask();
      const { client } = await signIn("member2VizBytes");

      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("the PIC cannot QA their own work", async () => {
      // The whole point of Gate 2. If the PIC can move it out of FOR_QA, the
      // second pair of eyes is optional.
      //
      // CLIENT work only, since P7-13. Internal work has no client and no
      // reviewer step left to protect, so one person taking their own internal
      // task to done is now the intended behaviour rather than a hole.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "FOR_QA");

      const { client } = await signIn("member1VizBytes");
      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "QA_IN_PROGRESS",
        p_comment: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("an uninvolved member cannot move it at all", async () => {
      const taskId = await makeTask();
      const { client } = await signIn("member1VizAssists");

      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: null,
      });

      expect(error).not.toBeNull();
    });
  });

  // =========================================================================
  // "QA rejection returns to ONGOING with the comment visible to the PIC."
  // =========================================================================
  describe("QA rejection (P3-10)", () => {
    it.skipIf(!migrationApplied)("requires a comment", async () => {
      // CLIENT work, since P7-13. This gate is gone for internal tasks — work
      // with no client moves freely — but it is exactly as strict as it ever
      // was for work a client is waiting on, which is what it existed to
      // protect.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "QA_IN_PROGRESS");

      const { client } = await signIn("member2VizBytes");
      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: "   ",
      });

      expect(error).not.toBeNull();
      expect(await statusOf(taskId)).toBe("QA_IN_PROGRESS");
    });

    it.skipIf(!migrationApplied)(
      "returns to ONGOING, and the PIC can read the comment",
      async () => {
        const taskId = await makeTask();
        await advanceTo(taskId, "QA_IN_PROGRESS");

        const comment = "The logo is the old mark — please use the 2026 one.";
        const qa = await signIn("member2VizBytes");

        const { error } = await qa.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: "ONGOING",
          p_comment: comment,
        });

        expect(error).toBeNull();
        expect(await statusOf(taskId)).toBe("ONGOING");

        // Read as the PIC, through RLS — "visible to the PIC" is the criterion,
        // not "stored somewhere".
        const pic = await signIn("member1VizBytes");
        const { data: history } = await pic.client
          .from("vizserve_pms_task_status_history")
          .select("comment, to_status")
          .eq("task_id", taskId)
          .eq("to_status", "ONGOING")
          .order("created_at", { ascending: false });

        expect(history![0]!.comment).toBe(comment);

        // And they are told, rather than having to notice.
        const { data: notifications } = await adminClient()
          .from("vizserve_pms_notifications")
          .select("user_id, body")
          .eq("entity_id", taskId)
          .eq("user_id", picId);

        expect(notifications!.some((row) => row.body === comment)).toBe(true);
      },
    );

    it.skipIf(!migrationApplied)("a rejected task can go round again", async () => {
      const taskId = await makeTask();
      await advanceTo(taskId, "QA_IN_PROGRESS");

      const qa = await signIn("member2VizBytes");
      await qa.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: "Needs the 2026 logo.",
      });

      const pic = await signIn("member1VizBytes");
      const { error } = await pic.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "FOR_QA",
        p_comment: null,
      });

      expect(error).toBeNull();
      expect(await statusOf(taskId)).toBe("FOR_QA");
    });
  });

  // =========================================================================
  // "WAITING_FOR_INFO duration is queryable per task." (P3-11 / R4)
  // =========================================================================
  describe("WAITING_FOR_INFO", () => {
    it.skipIf(!migrationApplied)("requires a note on entry", async () => {
      // CLIENT work, since P7-13. This gate is gone for internal tasks — work
      // with no client moves freely — but it is exactly as strict as it ever
      // was for work a client is waiting on, which is what it existed to
      // protect.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "ONGOING");

      const { client } = await signIn("member1VizBytes");
      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "WAITING_FOR_INFO",
        p_comment: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("has a queryable duration, derived from history", async () => {
      // Derived rather than stored, so it stays correct for a task that has
      // bounced in and out several times. A stored counter is how R4 happens.
      const taskId = await makeTask();
      await advanceTo(taskId, "WAITING_FOR_INFO");

      const { client } = await signIn("member1VizBytes");
      const { data, error } = await client.rpc("vizserve_pms_task_waiting_duration", {
        p_task_id: taskId,
      });

      expect(error).toBeNull();
      // Still waiting, so it measures to now — which is what "how long has this
      // been stuck" actually means.
      expect(data).toBeTruthy();
    });

    it.skipIf(!migrationApplied)("returns to ONGOING without needing a note", async () => {
      const taskId = await makeTask();
      await advanceTo(taskId, "WAITING_FOR_INFO");

      const { client } = await signIn("member1VizBytes");
      const { error } = await client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: null,
      });

      expect(error).toBeNull();
    });
  });

  // =========================================================================
  // Q5 — the override
  // =========================================================================
  describe("forcing a status", () => {
    it.skipIf(!migrationApplied)("refuses without a reason", async () => {
      const taskId = await makeTask();
      const { client } = await signIn("tlVizBytes");

      const { error } = await client.rpc("vizserve_pms_force_task_status", {
        p_task_id: taskId,
        p_to_status: "COMPLETED",
        p_reason: "  ",
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("refuses a member entirely", async () => {
      const taskId = await makeTask();
      const { client } = await signIn("member1VizBytes");

      const { error } = await client.rpc("vizserve_pms_force_task_status", {
        p_task_id: taskId,
        p_to_status: "COMPLETED",
        p_reason: "I would like this to be done.",
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)(
      "lets a TL skip stages, and flags it distinctly in history",
      async () => {
        const taskId = await makeTask();
        const { client } = await signIn("tlVizBytes");
        const reason = "PIC left the company mid-task; reopening for reassignment.";

        const { error } = await client.rpc("vizserve_pms_force_task_status", {
          p_task_id: taskId,
          p_to_status: "FOR_CLIENT_APPROVAL",
          p_reason: reason,
        });

        expect(error).toBeNull();
        expect(await statusOf(taskId)).toBe("FOR_CLIENT_APPROVAL");

        const { data: history } = await adminClient()
          .from("vizserve_pms_task_status_history")
          .select("is_override, comment, to_status")
          .eq("task_id", taskId)
          .eq("to_status", "FOR_CLIENT_APPROVAL")
          .single();

        // An override that reads like an ordinary transition destroys the trail
        // it appears in.
        expect(history!.is_override).toBe(true);
        expect(history!.comment).toBe(reason);
      },
    );
  });

  // =========================================================================
  // P3-15 — scope
  // =========================================================================
  describe("task visibility", () => {
    it.skipIf(!migrationApplied)(
      "a member sees their department's tasks, and no other department's",
      async () => {
        /*
         * ⚠️ REWRITTEN FOR P7-17, 19 Aug. This case used to assert "PIC or QA,
         * and no others", with the comment "being in the same department is not
         * enough" — which is precisely the rule
         * `20260819100000_p7_17_department_visibility.sql` reversed. Its header:
         * "every active member of a department can read every non-personal task
         * in it".
         *
         * It had been failing since that migration was pasted and nobody re-ran
         * this file; `tests/db/task-groups.test.ts` surfaced it. The scope
         * boundary did not disappear — IT MOVED UP A LEVEL, from the task to the
         * department — so this asserts where it is now rather than being deleted.
         */
        const mine = await makeTask();
        const theirs = await makeTask({ p_assignee_id: qaId, p_qa_assignee_id: null });

        const pic = await signIn("member1VizBytes");
        const { data: visible } = await pic.client
          .from("vizserve_pms_tasks")
          .select("id")
          .in("id", [mine, theirs]);

        const ids = (visible ?? []).map((row) => row.id);
        expect(ids).toContain(mine);
        // P7-17: a colleague's task in the same department, and being in that
        // department IS now enough. A team that cannot see its own board keeps a
        // second board somewhere else.
        expect(ids).toContain(theirs);

        // The boundary, where it actually is: another department sees neither.
        const outsider = await signIn("member1VizAssists");
        const { data: hidden, error } = await outsider.client
          .from("vizserve_pms_tasks")
          .select("id")
          .in("id", [mine, theirs]);

        // Zero rows is a working policy; `permission denied` would be a grant bug.
        expect(error).toBeNull();
        expect(hidden).toHaveLength(0);
      },
    );

    it.skipIf(!migrationApplied)("the QA reviewer sees the task they review", async () => {
      const taskId = await makeTask();
      const qa = await signIn("member2VizBytes");

      const { data } = await qa.client.from("vizserve_pms_tasks").select("id").eq("id", taskId);
      expect(data).toHaveLength(1);
    });

    it.skipIf(!migrationApplied)("a TL sees their whole department's tasks", async () => {
      const taskId = await makeTask({ p_assignee_id: qaId, p_qa_assignee_id: null });
      const { client } = await signIn("tlVizBytes");

      const { data } = await client.from("vizserve_pms_tasks").select("id").eq("id", taskId);
      expect(data).toHaveLength(1);
    });

    it.skipIf(!migrationApplied)("a TL of another department sees none of them", async () => {
      const taskId = await makeTask();
      const { client } = await signIn("tlVizAssists");

      const { data, error } = await client.from("vizserve_pms_tasks").select("id").eq("id", taskId);

      // Zero rows, not an error — a working policy, not a missing grant.
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it.skipIf(!migrationApplied)("history is invisible outside the task's scope", async () => {
      const taskId = await makeTask();
      const { client } = await signIn("tlVizAssists");

      const { data } = await client
        .from("vizserve_pms_task_status_history")
        .select("id")
        .eq("task_id", taskId);

      expect(data).toEqual([]);
    });
  });

  // =========================================================================
  // P3-12 — manual creation
  // =========================================================================
  describe("manual tasks", () => {
    it.skipIf(!migrationApplied)("can be created with no request behind them", async () => {
      const taskId = await makeTask();

      const { data } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("request_id, status")
        .eq("id", taskId)
        .single();

      expect(data!.request_id).toBeNull();
      expect(data!.status).toBe("OPEN");
    });

    it.skipIf(!migrationApplied)("refuse an assignee from another department", async () => {
      const { client } = await signIn("tlVizBytes");
      const { data: outsider } = await adminClient()
        .from("vizserve_pms_users")
        .select("id")
        .eq("primary_department_id", DEPARTMENTS.VizMedia)
        .eq("role", "member")
        .limit(1)
        .single();

      const { error } = await client.rpc("vizserve_pms_create_task", {
        p_department_id: DEPARTMENTS.VizBytes,
        p_title: "Should not exist",
        p_description: "",
        p_assignee_id: outsider!.id,
        p_qa_assignee_id: null,
        p_due_date: null,
        p_list_id: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("refuse a department the caller does not lead", async () => {
      const { client } = await signIn("tlVizAssists");

      const { error } = await client.rpc("vizserve_pms_create_task", {
        p_department_id: DEPARTMENTS.VizBytes,
        p_title: "Should not exist",
        p_description: "",
        p_assignee_id: null,
        p_qa_assignee_id: null,
        p_due_date: null,
        p_list_id: null,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("refuse a member ANOTHER department", async () => {
      // P7-14 let members create work — in their own department only. The
      // department is resolved from their own row rather than trusted from the
      // parameter, so this is refused rather than merely discouraged.
      const { client } = await signIn("member1VizBytes");

      const { error } = await client.rpc("vizserve_pms_create_task", {
        p_department_id: DEPARTMENTS.VizAssists,
        p_title: "Should not exist",
        p_description: "",
        p_assignee_id: null,
        p_qa_assignee_id: null,
        p_due_date: null,
        p_list_id: null,
      });

      expect(error?.message ?? "").toContain("outside your scope");
    });

    it.skipIf(!migrationApplied)("let a member create in their own department", async () => {
      // The other half of P7-14, and the change that matters: somebody notices
      // a thing, makes a card, and puts a colleague's name on it without a lead
      // in the loop.
      const { client } = await signIn("member1VizBytes");

      const { data, error } = await client.rpc("vizserve_pms_create_task", {
        p_department_id: DEPARTMENTS.VizBytes,
        p_title: "Member-created",
        p_description: "",
        p_assignee_id: qaId,
        p_qa_assignee_id: null,
        p_due_date: null,
        p_list_id: null,
      });

      expect(error).toBeNull();
      created.push((data as { task_id: string }).task_id);
    });

    it.skipIf(!migrationApplied)("notify the assignee", async () => {
      const taskId = await makeTask();

      const { data: notifications } = await adminClient()
        .from("vizserve_pms_notifications")
        .select("user_id, type, link_path")
        .eq("entity_id", taskId)
        .eq("type", "assigned");

      expect(notifications).toHaveLength(1);
      expect(notifications![0]!.user_id).toBe(picId);
      expect(notifications![0]!.link_path).toBe(`/tasks/${taskId}`);
    });
  });

  // =========================================================================
  // P7-00 — the guard must not fall through on an unset seat
  //
  // `v_is_qa := v_task.qa_assignee_id = v_actor` is NULL when the column is
  // NULL, so `not (false or NULL or false)` is NULL and `IF NULL THEN` never
  // fires. A task with no QA reviewer therefore had no ownership guard at all:
  // any signed-in user could walk it to the client gate.
  //
  // The tasks in this block deliberately have `p_qa_assignee_id: null`, which
  // is the condition — not "a member cannot move tasks", which was already
  // true and is asserted as the control below.
  // =========================================================================
  describe("the ownership guard holds when a seat is empty", () => {
    it.skipIf(!migrationApplied)(
      "refuse an unrelated user on a task with no QA reviewer",
      async () => {
        const taskId = await makeTask({ p_qa_assignee_id: null });
        await advanceTo(taskId, "FOR_QA");

        // Another department entirely. Not the PIC, not the QA, leads nothing.
        const stranger = await signIn("member1VizAssists");

        const { error } = await stranger.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: "QA_IN_PROGRESS",
          p_comment: null,
        });

        expect(error).not.toBeNull();
        expect(await statusOf(taskId)).toBe("FOR_QA");
      },
    );

    it.skipIf(!migrationApplied)(
      "refuse an unrelated user on a task with no PIC either",
      async () => {
        // Both seats empty — the same NULL propagates through `v_is_pic`, so
        // the `'pic'` actor branch has to be proven separately from the `'qa'`
        // one rather than assumed to share a fix.
        const taskId = await makeTask({ p_assignee_id: null, p_qa_assignee_id: null });

        const stranger = await signIn("member1VizAssists");

        const { error } = await stranger.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: "ONGOING",
          p_comment: null,
        });

        expect(error).not.toBeNull();
        expect(await statusOf(taskId)).toBe("OPEN");
      },
    );

    it.skipIf(!migrationApplied)(
      "the control — the same caller is already refused when the seat is filled",
      async () => {
        const taskId = await makeTask();
        await advanceTo(taskId, "FOR_QA");

        const stranger = await signIn("member1VizAssists");

        const { error } = await stranger.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: "QA_IN_PROGRESS",
          p_comment: null,
        });

        expect(error).not.toBeNull();
        expect(await statusOf(taskId)).toBe("FOR_QA");
      },
    );
  });

  // =========================================================================
  // P7-01 — a member records work for themselves
  // =========================================================================
  describe("personal tasks", () => {
    async function makePersonalTask(overrides: Record<string, unknown> = {}): Promise<string> {
      const { client } = await signIn("member1VizBytes");

      const { data, error } = await client.rpc("vizserve_pms_create_personal_task", {
        p_title: `P7 personal ${Math.random().toString(36).slice(2, 8)}`,
        p_description: "Reading the new brand guidelines.",
        p_due_date: null,
        p_list_id: null,
        ...overrides,
      });

      if (error) throw new Error(`fixture personal task: ${error.message}`);

      const id = (data as { task_id: string }).task_id;
      created.push(id);
      return id;
    }

    it.skipIf(!personalTasksApplied)(
      "lands in the member's own department, assigned to them, with no request",
      async () => {
        const me = await signIn("member1VizBytes");
        const taskId = await makePersonalTask();

        const { data: task } = await adminClient()
          .from("vizserve_pms_tasks")
          .select(
            "department_id, assignee_id, qa_assignee_id, request_id, is_personal, status, created_by",
          )
          .eq("id", taskId)
          .single();

        expect(task!.department_id).toBe(DEPARTMENTS.VizBytes);
        expect(task!.assignee_id).toBe(me.userId);
        expect(task!.created_by).toBe(me.userId);
        // No reviewer and no client — the two facts that let P7-02 close it.
        expect(task!.qa_assignee_id).toBeNull();
        expect(task!.request_id).toBeNull();
        expect(task!.is_personal).toBe(true);
        expect(task!.status).toBe("OPEN");
      },
    );

    it.skipIf(!personalTasksApplied)("a task made by a TL is not personal", async () => {
      const taskId = await makeTask();

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("is_personal")
        .eq("id", taskId)
        .single();

      // The backfill default holding is what keeps every task that existed
      // before this migration classified as assigned work.
      expect(task!.is_personal).toBe(false);
    });

    it.skipIf(!personalTasksApplied)(
      "is_personal cannot be set by an ordinary update",
      async () => {
        // The column is left out of the column-level UPDATE grant, exactly like
        // `status`. If this ever passes, a member can reclassify work their lead
        // assigned them and then close it without review.
        const taskId = await makeTask();
        const { client } = await signIn("member1VizBytes");

        const { error } = await client
          .from("vizserve_pms_tasks")
          .update({ is_personal: true } as never)
          .eq("id", taskId);

        expect(error).not.toBeNull();

        const { data: task } = await adminClient()
          .from("vizserve_pms_tasks")
          .select("is_personal")
          .eq("id", taskId)
          .single();

        expect(task!.is_personal).toBe(false);
      },
    );

    it.skipIf(!personalTasksApplied)("is visible to the department's team leader", async () => {
      // Personal work is not secret work. Proven rather than assumed: no policy
      // was added for it, so this asserts the existing one already covers it.
      const taskId = await makePersonalTask();
      const tl = await signIn("tlVizBytes");

      const { data } = await tl.client.from("vizserve_pms_tasks").select("id").eq("id", taskId);

      expect(data).toHaveLength(1);
    });

    it.skipIf(!personalTasksApplied)(
      "is invisible to another department — zero rows, not permission denied",
      async () => {
        const taskId = await makePersonalTask();
        const outsider = await signIn("member1VizAssists");

        const { data, error } = await outsider.client
          .from("vizserve_pms_tasks")
          .select("id")
          .eq("id", taskId);

        expect(error).toBeNull();
        expect(data).toHaveLength(0);
      },
    );

    it.skipIf(!personalTasksApplied)("refuses another department's list", async () => {
      const { data: list } = await adminClient()
        .from("vizserve_pms_lists")
        .select("id")
        .eq("department_id", DEPARTMENTS.VizAssists)
        .limit(1)
        .maybeSingle();

      // No VizAssists list seeded in this project; nothing to assert against.
      if (!list) return;

      const { client } = await signIn("member1VizBytes");
      const { error } = await client.rpc("vizserve_pms_create_personal_task", {
        p_title: "Filed in the wrong department",
        p_description: "",
        p_due_date: null,
        p_list_id: list.id,
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!personalTasksApplied)("records the creation in history", async () => {
      const taskId = await makePersonalTask();

      const { data: history } = await adminClient()
        .from("vizserve_pms_task_status_history")
        .select("to_status, from_status")
        .eq("task_id", taskId);

      expect(history).toHaveLength(1);
      expect(history![0]!.to_status).toBe("OPEN");
      expect(history![0]!.from_status).toBeNull();
    });

    it.skipIf(!personalTasksApplied)("notifies nobody", async () => {
      const taskId = await makePersonalTask();

      const { data: notifications } = await adminClient()
        .from("vizserve_pms_notifications")
        .select("id")
        .eq("entity_id", taskId);

      // You do not need telling that you gave yourself a job.
      expect(notifications).toHaveLength(0);
    });

    // =======================================================================
    // P7-02 — every category has exactly one way to finish
    // =======================================================================

    it.skipIf(!completionApplied)("the owner closes their own from ONGOING", async () => {
      const taskId = await makePersonalTask();
      const me = await signIn("member1VizBytes");

      await me.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: null,
      });

      // The resolution gate USED to apply here. P7-13 removed it along with
      // every other gate on work that has no client: closing your own task is
      // now one move, with nothing to fill in first. A resolution is still
      // recorded when somebody writes one, and reporting reads it when it is
      // there — it is simply no longer demanded.
      await me.client
        .from("vizserve_pms_tasks")
        .update({ resolution: "Read it, notes in the shared doc." })
        .eq("id", taskId);

      const { error } = await me.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "COMPLETED",
        p_comment: null,
      });

      expect(error).toBeNull();
      expect(await statusOf(taskId)).toBe("COMPLETED");
    });

    it.skipIf(!completionApplied)("the same move is refused on CLIENT work", async () => {
      // Internal work used to be refused here too. P7-13 removed that: work
      // with no client moves freely, and closing your own internal task from
      // ONGOING is now the ordinary case rather than a shortcut round a gate.
      // Client work keeps every gate, because each has somebody outside the
      // company on the other end.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "ONGOING");

      await adminClient()
        .from("vizserve_pms_tasks")
        .update({ resolution: "Done." })
        .eq("id", taskId);

      const pic = await signIn("member1VizBytes");
      const { error } = await pic.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "COMPLETED",
        p_comment: null,
      });

      expect(error).not.toBeNull();
      expect(await statusOf(taskId)).toBe("ONGOING");
    });

    it.skipIf(!completionApplied)("internal work is closed by its QA reviewer", async () => {
      // The exit that closing the client gate made necessary. Without it a task
      // a TL created by hand would sit in QA_IN_PROGRESS forever.
      const taskId = await makeTask();
      await advanceTo(taskId, "QA_IN_PROGRESS");

      const qa = await signIn("member2VizBytes");
      const { error } = await qa.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "COMPLETED",
        p_comment: null,
      });

      expect(error).toBeNull();
      expect(await statusOf(taskId)).toBe("COMPLETED");
    });

    it.skipIf(!completionApplied)(
      "internal work cannot be sent to a client that does not exist",
      async () => {
        const taskId = await makeTask();
        await advanceTo(taskId, "QA_IN_PROGRESS");

        const qa = await signIn("member2VizBytes");
        const { error } = await qa.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: "FOR_CLIENT_APPROVAL",
          p_comment: null,
        });

        expect(error).not.toBeNull();
        expect(await statusOf(taskId)).toBe("QA_IN_PROGRESS");
      },
    );

    it.skipIf(!completionApplied)(
      "client work still goes to the client, and cannot be closed short of it",
      async () => {
        const taskId = await makeRequestTask();
        await advanceTo(taskId, "QA_IN_PROGRESS");

        const qa = await signIn("member2VizBytes");

        // The internal shortcut is not available to work that has a client.
        const shortcut = await qa.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: "COMPLETED",
          p_comment: null,
        });
        expect(shortcut.error).not.toBeNull();

        const { error } = await qa.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: "FOR_CLIENT_APPROVAL",
          p_comment: null,
        });

        expect(error).toBeNull();
        expect(await statusOf(taskId)).toBe("FOR_CLIENT_APPROVAL");
      },
    );
  });

  // =========================================================================
  // P7-06 — internal work moves freely; client work does not
  // =========================================================================
  describe("free status movement", () => {
    async function move(taskId: string, to: string, comment: string | null = null) {
      const pic = await signIn("member1VizBytes");
      return pic.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: to as never,
        p_comment: comment,
      });
    }

    it.skipIf(!flexibilityApplied)("walks backwards through the working statuses", async () => {
      const taskId = await makeTask();
      await advanceTo(taskId, "ONGOING");

      expect((await move(taskId, "OPEN")).error).toBeNull();
      expect(await statusOf(taskId)).toBe("OPEN");

      // The note used to be required here. P7-13 dropped it with the rest of
      // the gates on internal work — parking is now one move. A note still
      // travels with the transition when one is given, and is still what makes
      // "blocked on what" answerable; it is just no longer compulsory.
      expect((await move(taskId, "WAITING_FOR_INFO", "Waiting on the supplier.")).error).toBeNull();
      expect(await statusOf(taskId)).toBe("WAITING_FOR_INFO");

      expect((await move(taskId, "OPEN")).error).toBeNull();
      expect(await statusOf(taskId)).toBe("OPEN");
    });

    it.skipIf(!flexibilityApplied)("pulls a task back out of review", async () => {
      const taskId = await makeTask();
      await advanceTo(taskId, "FOR_QA");

      expect((await move(taskId, "ONGOING")).error).toBeNull();
      expect(await statusOf(taskId)).toBe("ONGOING");
    });

    it.skipIf(!flexibilityApplied)("reopens a completed internal task", async () => {
      const taskId = await makeTask();
      await advanceTo(taskId, "QA_IN_PROGRESS");

      const qa = await signIn("member2VizBytes");
      await qa.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "COMPLETED",
        p_comment: null,
      });

      expect((await move(taskId, "ONGOING")).error).toBeNull();
      expect(await statusOf(taskId)).toBe("ONGOING");
    });

    it.skipIf(!flexibilityApplied)("refuses all of it on client work", async () => {
      // The pipeline exists for work that has gates. None of the freedom above
      // is available to a task a client is waiting on.
      const taskId = await makeRequestTask();
      await advanceTo(taskId, "ONGOING");

      expect((await move(taskId, "OPEN")).error).not.toBeNull();
      expect(await statusOf(taskId)).toBe("ONGOING");
    });

    it.skipIf(!flexibilityApplied)("still writes history for every one of them", async () => {
      // The whole reason this was done as transition rows rather than by making
      // `status` writable: freedom, without losing the trail.
      const taskId = await makeTask();
      await advanceTo(taskId, "ONGOING");
      await move(taskId, "OPEN");

      const { data: history } = await adminClient()
        .from("vizserve_pms_task_status_history")
        .select("from_status, to_status")
        .eq("task_id", taskId)
        .order("created_at");

      expect(history!.map((row) => row.to_status)).toEqual(["OPEN", "ONGOING", "OPEN"]);
    });

    it.skipIf(!flexibilityApplied)("refuses a start date after the due date", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      const bad = await pic.client
        .from("vizserve_pms_tasks")
        .update({ start_date: "2026-12-31" })
        .eq("id", taskId)
        .select("id");

      // due_date on the fixture is 2026-12-01.
      expect(bad.error).not.toBeNull();

      const good = await pic.client
        .from("vizserve_pms_tasks")
        .update({ start_date: "2026-11-01" })
        .eq("id", taskId)
        .select("id");

      expect(good.error).toBeNull();
      expect(good.data).toHaveLength(1);
    });
  });

  // =========================================================================
  // P7-08 — comments
  // =========================================================================
  describe("task comments", () => {
    it.skipIf(!commentsApplied)("can be posted by somebody on the task", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      const { error } = await pic.client.from("vizserve_pms_task_comments").insert({
        task_id: taskId,
        author_id: pic.userId,
        body: "Did the client ever send the logo?",
      });

      expect(error).toBeNull();
    });

    it.skipIf(!commentsApplied)("cannot be posted under somebody else's name", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");
      const qa = await signIn("member2VizBytes");

      const { error } = await pic.client.from("vizserve_pms_task_comments").insert({
        task_id: taskId,
        author_id: qa.userId,
        body: "Posted as the QA reviewer, which should not be possible.",
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!commentsApplied)("cannot be posted on a task you cannot see", async () => {
      const taskId = await makeTask();
      const outsider = await signIn("member1VizAssists");

      const { error } = await outsider.client.from("vizserve_pms_task_comments").insert({
        task_id: taskId,
        author_id: outsider.userId,
        body: "Commenting on another department's work.",
      });

      expect(error).not.toBeNull();
    });

    it.skipIf(!commentsApplied)("refuses an empty one", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      const { error } = await pic.client
        .from("vizserve_pms_task_comments")
        .insert({ task_id: taskId, author_id: pic.userId, body: "   " });

      expect(error).not.toBeNull();
    });

    it.skipIf(!commentsApplied)("is visible to everyone who can see the task", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      await pic.client
        .from("vizserve_pms_task_comments")
        .insert({ task_id: taskId, author_id: pic.userId, body: "Visible to the team." });

      for (const account of ["member2VizBytes", "tlVizBytes"] as const) {
        const reader = await signIn(account);
        const { data } = await reader.client
          .from("vizserve_pms_task_comments")
          .select("id")
          .eq("task_id", taskId);

        expect((data ?? []).length).toBeGreaterThan(0);
      }

      const outsider = await signIn("member1VizAssists");
      const { data, error } = await outsider.client
        .from("vizserve_pms_task_comments")
        .select("id")
        .eq("task_id", taskId);

      expect(error).toBeNull();
      expect(data).toHaveLength(0);
    });

    it.skipIf(!commentsApplied)("is editable and removable only by its author", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");
      const qa = await signIn("member2VizBytes");

      const { data: posted } = await pic.client
        .from("vizserve_pms_task_comments")
        .insert({ task_id: taskId, author_id: pic.userId, body: "Mine." })
        .select("id")
        .single();

      // Zero rows, not an error — a policy-refused UPDATE reports success.
      const edited = await qa.client
        .from("vizserve_pms_task_comments")
        .update({ body: "Not yours to change." })
        .eq("id", posted!.id)
        .select("id");

      expect(edited.error).toBeNull();
      expect(edited.data).toHaveLength(0);

      const removed = await qa.client
        .from("vizserve_pms_task_comments")
        .delete()
        .eq("id", posted!.id)
        .select("id");

      expect(removed.data).toHaveLength(0);

      const own = await pic.client
        .from("vizserve_pms_task_comments")
        .update({ body: "Mine, corrected." })
        .eq("id", posted!.id)
        .select("id");

      expect(own.data).toHaveLength(1);
    });

    it.skipIf(!commentsApplied)("notifies the other people on the task, not the author", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      await pic.client
        .from("vizserve_pms_task_comments")
        .insert({ task_id: taskId, author_id: pic.userId, body: "Anyone seen the brief?" });

      const { data: notifications } = await adminClient()
        .from("vizserve_pms_notifications")
        .select("user_id, type, send_email")
        .eq("entity_id", taskId)
        .eq("type", "commented");

      expect(notifications).toHaveLength(1);
      expect(notifications![0]!.user_id).toBe(qaId);
      // Inbox only. Discussion is not an interruption.
      expect(notifications![0]!.send_email).toBe(false);
    });
  });

  // =========================================================================
  // P7-09 — subtasks
  // =========================================================================
  describe("subtasks", () => {
    async function setParent(taskId: string, parentId: string | null) {
      const tl = await signIn("tlVizBytes");
      return tl.client
        .from("vizserve_pms_tasks")
        .update({ parent_task_id: parentId })
        .eq("id", taskId)
        .select("id");
    }

    it.skipIf(!subtasksApplied)("nests one task under another", async () => {
      const parent = await makeTask();
      const child = await makeTask();

      const { data, error } = await setParent(child, parent);

      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    });

    it.skipIf(!subtasksApplied)("refuses a task as its own parent", async () => {
      const taskId = await makeTask();
      const { error } = await setParent(taskId, taskId);
      expect(error).not.toBeNull();
    });

    it.skipIf(!subtasksApplied)("refuses a second level", async () => {
      // One level deep is what keeps every existing query correct without a
      // recursive CTE — and it is also what makes a longer cycle impossible.
      const parent = await makeTask();
      const child = await makeTask();
      const grandchild = await makeTask();

      await setParent(child, parent);
      const { error } = await setParent(grandchild, child);

      expect(error).not.toBeNull();
    });

    it.skipIf(!subtasksApplied)("refuses a parent in another department", async () => {
      const child = await makeTask();

      const { data: elsewhere } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("id")
        .eq("department_id", DEPARTMENTS.VizAssists)
        .limit(1)
        .maybeSingle();

      if (!elsewhere) return;

      const { error } = await setParent(child, elsewhere.id);
      expect(error).not.toBeNull();
    });

    it.skipIf(!subtasksApplied)("can be detached again", async () => {
      const parent = await makeTask();
      const child = await makeTask();

      await setParent(child, parent);
      const { data } = await setParent(child, null);

      expect(data).toHaveLength(1);

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("parent_task_id")
        .eq("id", child)
        .single();

      expect(task!.parent_task_id).toBeNull();
    });

    it.skipIf(!subtasksApplied)("carries its own status, and is loggable in its own right", async () => {
      // The reason a subtask is a task rather than a checklist row: half the
      // point of breaking work up is seeing where the hours went.
      const parent = await makeTask();
      const child = await makeTask();
      await setParent(child, parent);

      await advanceTo(child, "ONGOING");
      expect(await statusOf(child)).toBe("ONGOING");
      expect(await statusOf(parent)).toBe("OPEN");

      const pic = await signIn("member1VizBytes");
      const { error } = await pic.client.from("vizserve_pms_timesheet_entries").insert({
        user_id: pic.userId,
        task_id: child,
        work_date: new Date().toISOString().slice(0, 10),
        minutes: 30,
      });

      expect(error).toBeNull();
      await adminClient().from("vizserve_pms_timesheet_entries").delete().eq("task_id", child);
    });
  });

  /**
   * P7-11 — priority.
   *
   * Three things are being proved here and only one of them is "the column
   * exists": that the enum's DECLARED ORDER is what SQL compares by, that the
   * absence of a priority survives as null rather than being defaulted into
   * NORMAL, and that the column is writable by the right people — which is the
   * exact opposite of what the `is_personal` and `status` tests prove, and is
   * why it needs its own assertion rather than an assumption.
   */
  describe("P7-11 priority", () => {
    it.skipIf(!priorityApplied)("defaults to null, not NORMAL", async () => {
      // The distinction the whole design rests on: "nobody ranked this" is a
      // real state and is the ordinary one. A default of NORMAL would put a
      // flag on every task in the system, and a mark carried by everything
      // marks nothing.
      const taskId = await makeTask();

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("priority")
        .eq("id", taskId)
        .single();

      expect(task!.priority).toBeNull();
    });

    it.skipIf(!priorityApplied)("is set at creation and kept", async () => {
      const taskId = await makeTask({ p_priority: "URGENT" });

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("priority")
        .eq("id", taskId)
        .single();

      expect(task!.priority).toBe("URGENT");
    });

    it.skipIf(!priorityApplied)("orders by declaration, not alphabetically", async () => {
      // THE LOAD-BEARING ASSERTION. `order by priority desc` is only correct
      // because the enum is declared LOW → URGENT; alphabetically it would run
      // URGENT, NORMAL, LOW, HIGH and every sorted list in the app would be
      // quietly wrong. Proved through the database rather than trusted.
      const urgent = await makeTask({ p_priority: "URGENT" });
      const low = await makeTask({ p_priority: "LOW" });
      const high = await makeTask({ p_priority: "HIGH" });

      const { data: rows } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("id, priority")
        .in("id", [urgent, low, high])
        .order("priority", { ascending: false });

      expect(rows!.map((row) => row.priority)).toEqual(["URGENT", "HIGH", "LOW"]);
    });

    it.skipIf(!priorityApplied)("sorts unranked tasks last, not first", async () => {
      // `nulls last` is a choice, and getting it backwards puts every task
      // nobody has ranked at the top of a list ordered by urgency.
      const ranked = await makeTask({ p_priority: "LOW" });
      const unranked = await makeTask();

      const { data: rows } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("id, priority")
        .in("id", [ranked, unranked])
        .order("priority", { ascending: false, nullsFirst: false });

      expect(rows!.map((row) => row.id)).toEqual([ranked, unranked]);
    });

    it.skipIf(!priorityApplied)("can be changed by the PIC — unlike status", async () => {
      // The mirror image of the `is_personal` and `status` cases above. This
      // column IS in the column-level UPDATE grant, because re-prioritising is
      // ordinary work rather than a state transition, and a test that only ever
      // proves things are locked would not notice this one being locked by
      // mistake.
      const taskId = await makeTask();
      const { client } = await signIn("member1VizBytes");

      const { error } = await client
        .from("vizserve_pms_tasks")
        .update({ priority: "HIGH" })
        .eq("id", taskId);

      expect(error).toBeNull();

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("priority")
        .eq("id", taskId)
        .single();

      expect(task!.priority).toBe("HIGH");
    });

    it.skipIf(!priorityApplied)("can be cleared back to null", async () => {
      // The picker's fifth option. Clearing has to reach the database as null
      // rather than as NORMAL, or "no priority" becomes unreachable once a
      // priority has been set once.
      const taskId = await makeTask({ p_priority: "URGENT" });
      const { client } = await signIn("member1VizBytes");

      const { error } = await client
        .from("vizserve_pms_tasks")
        .update({ priority: null })
        .eq("id", taskId);

      expect(error).toBeNull();

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("priority")
        .eq("id", taskId)
        .single();

      expect(task!.priority).toBeNull();
    });

    it.skipIf(!priorityApplied)("is refused to an unrelated member — zero rows", async () => {
      // A policy-refused UPDATE is not an error: PostgREST reports success with
      // zero rows affected. Asserting `error === null` here would pass whether
      // the policy worked or not, so the row count is the assertion.
      const taskId = await makeTask();
      const { client } = await signIn("member1VizAssists");

      const { data, error } = await client
        .from("vizserve_pms_tasks")
        .update({ priority: "URGENT" })
        .eq("id", taskId)
        .select("id");

      expect(error).toBeNull();
      expect(data).toHaveLength(0);

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("priority")
        .eq("id", taskId)
        .single();

      expect(task!.priority).toBeNull();
    });

    it.skipIf(!priorityApplied)("did not widen the grant to status", async () => {
      // The grant statement RESTATES the whole column list, so the failure mode
      // is a column silently gained or lost. `status` staying unwritable is the
      // proof that the list was extended rather than replaced.
      const taskId = await makeTask();
      const { client } = await signIn("member1VizBytes");

      const { error } = await client
        .from("vizserve_pms_tasks")
        .update({ status: "COMPLETED" } as never)
        .eq("id", taskId);

      expect(error).not.toBeNull();
    });

    it.skipIf(!priorityApplied)("a personal task carries its creator's priority", async () => {
      const { client } = await signIn("member1VizBytes");

      const { data, error } = await client.rpc("vizserve_pms_create_personal_task", {
        p_title: `Priority personal ${Math.random().toString(36).slice(2, 8)}`,
        p_description: "",
        p_due_date: null,
        p_list_id: null,
        p_priority: "HIGH",
      });

      expect(error).toBeNull();
      const taskId = (data as { task_id: string }).task_id;
      created.push(taskId);

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("priority, is_personal")
        .eq("id", taskId)
        .single();

      expect(task!.priority).toBe("HIGH");
      expect(task!.is_personal).toBe(true);
    });

    it.skipIf(!priorityApplied)("Gate 1 sets it on a client task", async () => {
      // The only moment a client task can be given one, because this is the
      // statement that creates the task. If this ever stops working there is no
      // second place to set it from at creation time.
      const { data: submitted } = await anonClient().rpc("vizserve_pms_submit_request", {
        p_slug: REQUEST_SLUG,
        p_payload: {
          requester_name: "Juan dela Cruz",
          requester_email: `p7.${Math.random().toString(36).slice(2, 8)}@example.com`,
          title: "Rush banner",
          description: "Needed for Friday.",
          target_date: "2026-12-01",
          field_values: {},
        } as Json,
        p_attachments: [],
        p_ip: `10.7.0.${Math.floor(Math.random() * 250)}`,
      });

      const submission = submitted as { ok: boolean; request_id?: string };
      createdRequests.push(submission.request_id!);

      const { client } = await signIn("tlVizBytes");
      const { data, error } = await client.rpc("vizserve_pms_approve_request", {
        p_request_id: submission.request_id!,
        p_assignee_id: picId,
        p_qa_assignee_id: qaId,
        p_approved_target_date: null,
        p_title: null,
        p_description: null,
        p_list_id: null,
        p_priority: "URGENT",
      });

      expect(error).toBeNull();
      const taskId = (data as { task_id: string }).task_id;
      created.push(taskId);

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("priority, request_id")
        .eq("id", taskId)
        .single();

      expect(task!.priority).toBe("URGENT");
      expect(task!.request_id).not.toBeNull();
    });

    it.skipIf(!priorityApplied)("refuses a value outside the enum", async () => {
      const { client } = await signIn("tlVizBytes");

      const { error } = await client.rpc("vizserve_pms_create_task", {
        p_department_id: DEPARTMENTS.VizBytes,
        p_title: "Bad priority",
        p_priority: "CRITICAL",
      } as never);

      expect(error).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // P7-13 / P7-15 — internal tasks as their own object.
  // ---------------------------------------------------------------------------

  describe.skipIf(!dbTestsEnabled)("P7-13 several assignees", () => {
    it.skipIf(!assigneesApplied)("a second assignee can see, log against and move it", async () => {
      // Four rights in one test on purpose: they are one decision. A second
      // assignee who can see a task but not move it is not "partly working", it
      // is the feature not existing.
      // QA-less on purpose: the default fixture seats member2 as the QA
      // reviewer, who can already see and move the task — which would make this
      // pass without the assignees table existing at all.
      const taskId = await makeTask({ p_qa_assignee_id: null });
      const other = await signIn("member2VizBytes");

      /*
       * ⚠️ THE "BEFORE" CHECK CHANGED WITH P7-17. It used to assert `other`
       * could not SEE the task. Since P7-17 every member of a department reads
       * every non-personal task in it, so visibility can no longer tell you
       * whether the assignees table is doing anything.
       *
       * Moving the task can. P7-17 widened SELECT and deliberately left UPDATE
       * and `transition_task` alone ("a member can now WATCH a colleague's task
       * move; they still cannot move it"), so that is the right the assignees
       * table actually grants — which makes this a STRONGER check than the one
       * it replaces, not a weaker one.
       */
      const before = await other.client.from("vizserve_pms_tasks").select("id").eq("id", taskId);
      expect(before.data ?? []).toHaveLength(1);

      const blocked = await other.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: null,
      });
      expect(blocked.error?.message ?? "").toContain("not yours");

      const tl = await signIn("tlVizBytes");
      const added = await tl.client.rpc("vizserve_pms_add_task_assignee", {
        p_task_id: taskId,
        p_user_id: other.userId,
      });
      expect(added.error).toBeNull();

      const after = await other.client.from("vizserve_pms_tasks").select("id").eq("id", taskId);
      expect(after.data ?? []).toHaveLength(1);

      const logged = await other.client
        .from("vizserve_pms_timesheet_entries")
        .insert({
          user_id: other.userId,
          task_id: taskId,
          work_date: new Date().toISOString().slice(0, 10),
          minutes: 15,
        })
        .select("id");
      expect(logged.error).toBeNull();

      const moved = await other.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: null,
      });
      expect(moved.error).toBeNull();

      await adminClient().from("vizserve_pms_timesheet_entries").delete().eq("task_id", taskId);
    });

    it.skipIf(!assigneesApplied)("removing them takes all of it away again", async () => {
      const taskId = await makeTask({ p_qa_assignee_id: null });
      const other = await signIn("member2VizBytes");
      const tl = await signIn("tlVizBytes");

      await tl.client.rpc("vizserve_pms_add_task_assignee", {
        p_task_id: taskId,
        p_user_id: other.userId,
      });
      await tl.client.rpc("vizserve_pms_remove_task_assignee", {
        p_task_id: taskId,
        p_user_id: other.userId,
      });

      // Visible again only because P7-17 shows the whole department its own
      // work — see the note in the case above. What removal takes away is the
      // right to MOVE it, which is what was granted.
      const seen = await other.client.from("vizserve_pms_tasks").select("id").eq("id", taskId);
      expect(seen.data ?? []).toHaveLength(1);

      const moved = await other.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: null,
      });
      expect(moved.error?.message ?? "").toContain("not yours");
    });

    it.skipIf(!assigneesApplied)("refuses somebody from another department", async () => {
      const taskId = await makeTask();
      const tl = await signIn("tlVizBytes");
      const outsider = await signIn("member1VizAssists");

      const { error } = await tl.client.rpc("vizserve_pms_add_task_assignee", {
        p_task_id: taskId,
        p_user_id: outsider.userId,
      });

      expect(error?.message ?? "").toContain("not an active member");
    });

    it.skipIf(!assigneesApplied)("will not remove the accountable name", async () => {
      // `assignee_id` is a column, not a row here. Emptying it is a reassignment,
      // which is a different decision with a different rule.
      const taskId = await makeTask();
      const tl = await signIn("tlVizBytes");

      const { error } = await tl.client.rpc("vizserve_pms_remove_task_assignee", {
        p_task_id: taskId,
        p_user_id: picId,
      });

      expect(error?.message ?? "").toContain("Reassign it instead");
    });
  });

  describe.skipIf(!dbTestsEnabled)("P7-13 internal work moves freely", () => {
    it.skipIf(!assigneesApplied)("goes anywhere, with no required fields", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      async function move(to: string) {
        const { error } = await pic.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: to as never,
          p_comment: null,
        });
        return error;
      }

      // Straight to done with no resolution, parked with no comment, reopened,
      // and into QA without passing FOR_QA. Every one was refused before P7-13.
      expect(await move("ONGOING")).toBeNull();
      expect(await move("COMPLETED")).toBeNull();
      expect(await move("WAITING_FOR_INFO")).toBeNull();
      expect(await move("OPEN")).toBeNull();
      expect(await move("QA_IN_PROGRESS")).toBeNull();
    });

    it.skipIf(!assigneesApplied)("still cannot reach the client gate", async () => {
      // Not a gate, a dead end: `vizserve_pms_issue_approval_token` refuses a task
      // with no request, so a task moved there could never finish or move back.
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      const { error } = await pic.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "FOR_CLIENT_APPROVAL",
        p_comment: null,
      });

      expect(error?.message ?? "").toContain("no client to approve");
    });

    it.skipIf(!assigneesApplied)("writes history for every one of those moves", async () => {
      // THE INVARIANT THAT MUST SURVIVE FREE MOVEMENT. No gates was never meant
      // to mean no record, and `status` stays outside the column UPDATE grant so
      // this function is still the only way it changes at all.
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      for (const to of ["ONGOING", "COMPLETED", "OPEN"]) {
        await pic.client.rpc("vizserve_pms_transition_task", {
          p_task_id: taskId,
          p_to_status: to as never,
          p_comment: null,
        });
      }

      const { data } = await adminClient()
        .from("vizserve_pms_task_status_history")
        .select("to_status")
        .eq("task_id", taskId)
        .order("created_at");

      expect((data ?? []).map((row) => row.to_status)).toEqual([
        "OPEN",
        "ONGOING",
        "COMPLETED",
        "OPEN",
      ]);
    });

    it.skipIf(!assigneesApplied)("leaves CLIENT work on the strict pipeline", async () => {
      const taskId = await makeRequestTask();
      const pic = await signIn("member1VizBytes");

      await pic.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "ONGOING",
        p_comment: null,
      });

      // No resolution written, so the gate must hold.
      const { error } = await pic.client.rpc("vizserve_pms_transition_task", {
        p_task_id: taskId,
        p_to_status: "FOR_QA",
        p_comment: null,
      });

      expect(error).not.toBeNull();
      expect(await statusOf(taskId)).toBe("ONGOING");
    });
  });

  describe.skipIf(!dbTestsEnabled)("P7-15 estimate and time tracked", () => {
    it.skipIf(!estimateApplied)("an estimate defaults to null and is editable", async () => {
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");

      const { data: before } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("estimate_minutes")
        .eq("id", taskId)
        .single();
      expect(before!.estimate_minutes).toBeNull();

      const { error } = await pic.client
        .from("vizserve_pms_tasks")
        .update({ estimate_minutes: 120 })
        .eq("id", taskId);
      expect(error).toBeNull();
    });

    it.skipIf(!estimateApplied)("sums everyone's hours, not just the caller's own", async () => {
      // THE REASON THE FUNCTION EXISTS. The entries policy is per-person, so a
      // plain sum would show each viewer only their own hours and call it the
      // task total. Two people log against one task; both must read 90.
      const taskId = await makeTask();
      const pic = await signIn("member1VizBytes");
      const other = await signIn("member2VizBytes");
      const day = new Date().toISOString().slice(0, 10);

      const tl = await signIn("tlVizBytes");
      await tl.client.rpc("vizserve_pms_add_task_assignee", {
        p_task_id: taskId,
        p_user_id: other.userId,
      });

      await pic.client
        .from("vizserve_pms_timesheet_entries")
        .insert({ user_id: pic.userId, task_id: taskId, work_date: day, minutes: 60 });
      await other.client
        .from("vizserve_pms_timesheet_entries")
        .insert({ user_id: other.userId, task_id: taskId, work_date: day, minutes: 30 });

      for (const who of [pic, other]) {
        const { data, error } = await who.client.rpc("vizserve_pms_task_time_tracked", {
          p_task_ids: [taskId],
        });
        expect(error).toBeNull();
        expect((data as unknown as { minutes: number }[])[0]!.minutes).toBe(90);
      }

      await adminClient().from("vizserve_pms_timesheet_entries").delete().eq("task_id", taskId);
    });

    it.skipIf(!estimateApplied)("returns nothing for a task the caller cannot see", async () => {
      const taskId = await makeTask();
      const outsider = await signIn("member1VizAssists");

      const { data, error } = await outsider.client.rpc("vizserve_pms_task_time_tracked", {
        p_task_ids: [taskId],
      });

      expect(error).toBeNull();
      expect((data as unknown as unknown[]) ?? []).toHaveLength(0);
    });
  });
});
