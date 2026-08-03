import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TASK_TRANSITIONS } from "@/lib/schemas/tasks";

import { DEPARTMENTS, adminClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

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

const created: string[] = [];
let picId = "";
let qaId = "";

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
  });

  afterAll(async () => {
    if (created.length === 0) return;
    const admin = adminClient();
    await admin.from("vizserve_pms_notifications").delete().in("entity_id", created);
    await admin.from("vizserve_pms_tasks").delete().in("id", created);
  });

  // =========================================================================
  // The two copies of the transition table must agree
  // =========================================================================
  describe("the contract mirrors the database", () => {
    it.skipIf(!migrationApplied)(
      "lib/schemas/tasks.ts matches vizserve_pms_task_transitions row for row",
      async () => {
        // Two copies of a rule is drift waiting to happen. The database is the
        // authority — it rejects the illegal move — and the TypeScript copy
        // exists so the UI knows which buttons to draw. This is what keeps them
        // honest, rather than the app quietly offering a button the server
        // refuses.
        const { data: rows } = await adminClient()
          .from("vizserve_pms_task_transitions")
          .select("from_status, to_status, actor, required_field");

        const fromDb = (rows ?? [])
          .map((row) => `${row.from_status}->${row.to_status}:${row.actor}:${row.required_field ?? "none"}`)
          .sort();

        const fromTs = TASK_TRANSITIONS.map(
          (t) => `${t.from}->${t.to}:${t.actor}:${t.requires ?? "none"}`,
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
      const taskId = await makeTask();
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
      const taskId = await makeTask();
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
      const taskId = await makeTask();
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
      const taskId = await makeTask();
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
      const taskId = await makeTask();
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
      const taskId = await makeTask();
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
      const taskId = await makeTask();
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
      const taskId = await makeTask();
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
      const taskId = await makeTask();
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
      "a member sees tasks where they are PIC or QA, and no others",
      async () => {
        const mine = await makeTask();
        const theirs = await makeTask({ p_assignee_id: qaId, p_qa_assignee_id: null });

        const pic = await signIn("member1VizBytes");
        const { data: visible } = await pic.client
          .from("vizserve_pms_tasks")
          .select("id")
          .in("id", [mine, theirs]);

        const ids = (visible ?? []).map((row) => row.id);
        expect(ids).toContain(mine);
        // Not the PIC and not the QA on that one — being in the same department
        // is not enough.
        expect(ids).not.toContain(theirs);
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

    it.skipIf(!migrationApplied)("refuse a member outright", async () => {
      const { client } = await signIn("member1VizBytes");

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
});
