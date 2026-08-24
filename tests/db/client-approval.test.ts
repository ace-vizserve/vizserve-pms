import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Json } from "@/lib/database.types";
import { PH_HOLIDAYS, addBusinessDays } from "@/lib/dates";

import { DEPARTMENTS, adminClient, anonClient, dbTestsEnabled, signIn, skipReason } from "./helpers";

/**
 * P4-13 — SECURITY TESTS FOR GATE 3.
 *
 * The riskiest surface in the build: a public URL that changes state with no
 * session. Every control in docs/08 §Security is asserted here, and the ones
 * that matter most are cross-task token reuse and replay.
 *
 * Note what is asserted about failure MESSAGES as well as behaviour: an invalid
 * token and an expired one must be indistinguishable from outside, or a probe
 * learns which guesses were close.
 */

if (!dbTestsEnabled) console.warn(`\n  client-approval.test.ts — ${skipReason}\n`);

const migrationApplied = dbTestsEnabled
  ? !(await adminClient().from("vizserve_pms_approval_tokens").select("id").limit(1)).error
  : false;

if (dbTestsEnabled && !migrationApplied) {
  console.warn(
    "\n  client-approval.test.ts — SKIPPED. supabase/migrations/20260804100000_p4_client_approval.sql" +
      " has not been applied. Apply it, then re-run.\n",
  );
}

/**
 * How far into the past to push a timestamp when a test needs it to have
 * already passed.
 *
 * AN HOUR, NOT A SECOND. These assertions are about "this has expired", not
 * about the precision of the boundary — and the boundary is compared against
 * the DATABASE's clock, which is not this machine's. Measured on this project:
 * the server ran 1.13 seconds behind the test runner, so a one-second margin
 * put the "aged" timestamp in the server's FUTURE and every expiry check
 * silently passed the token as still valid.
 *
 * That failure is worse than flaky — it reads as "an expired token was
 * accepted", which is a security regression, and it appears and disappears with
 * clock drift rather than with anything in the code.
 */
const WELL_IN_THE_PAST = () => new Date(Date.now() - 3_600_000).toISOString();

const SLUG = `p4-fixture-${Math.random().toString(36).slice(2, 10)}`;
const PREFIX = `Q${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

let formId = "";
let picId = "";
let qaId = "";
const createdTasks: string[] = [];

/** A task sitting in FOR_CLIENT_APPROVAL with a fresh token. Returns the raw token. */
async function taskAwaitingApproval(): Promise<{ taskId: string; token: string }> {
  const admin = adminClient();

  const { data: submission } = await anonClient().rpc("vizserve_pms_submit_request", {
    p_slug: SLUG,
    p_payload: {
      requester_name: "Ms Sam",
      requester_email: `p4.${Math.random().toString(36).slice(2, 8)}@example.com`,
      title: "Open house poster",
      description: "A3, portrait.",
      target_date: "2026-12-01",
      field_values: {},
    } as Json,
    p_attachments: [],
    p_ip: `10.4.0.${Math.floor(Math.random() * 250)}`,
  });

  const requestId = (submission as { ok: boolean; request_id: string }).request_id;

  const tl = await signIn("tlVizBytes");
  const { data: approved } = await tl.client.rpc("vizserve_pms_approve_request", {
    p_request_id: requestId,
    p_assignee_id: picId,
    p_qa_assignee_id: qaId,
    p_approved_target_date: null,
    p_title: null,
    p_description: null,
  });

  const taskId = (approved as { task_id: string }).task_id;
  createdTasks.push(taskId);

  // Drive it to FOR_CLIENT_APPROVAL through the legitimate path.
  const pic = await signIn("member1VizBytes");
  await pic.client.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: "ONGOING",
    p_comment: null,
  });

  await admin
    .from("vizserve_pms_tasks")
    .update({ resolution: "Two A3 variants produced." })
    .eq("id", taskId);

  await pic.client.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: "FOR_QA",
    p_comment: null,
  });

  const qa = await signIn("member2VizBytes");
  await qa.client.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: "QA_IN_PROGRESS",
    p_comment: null,
  });
  await qa.client.rpc("vizserve_pms_transition_task", {
    p_task_id: taskId,
    p_to_status: "FOR_CLIENT_APPROVAL",
    p_comment: null,
  });

  // Issued with the service role, exactly as the server action does.
  const { data: issued } = await admin.rpc("vizserve_pms_issue_approval_token", {
    p_task_id: taskId,
    p_purpose: "approval",
  });

  return { taskId, token: (issued as { token: string }).token };
}

async function statusOf(taskId: string): Promise<string> {
  const { data } = await adminClient()
    .from("vizserve_pms_tasks")
    .select("status")
    .eq("id", taskId)
    .single();
  return data!.status;
}

function decide(token: string, decision: string, comment?: string, name?: string) {
  return anonClient().rpc("vizserve_pms_record_client_decision", {
    p_token: token,
    p_decision: decision as never,
    p_comment: comment ?? null,
    p_approver_name: name ?? null,
    p_ip: "203.0.113.9",
    p_user_agent: "vitest",
  });
}

describe.skipIf(!dbTestsEnabled)("P4 client approval", () => {
  beforeAll(async () => {
    if (!migrationApplied) return;
    const admin = adminClient();

    const { data: form, error } = await admin
      .from("vizserve_pms_forms")
      .insert({
        name: "P4 fixture form",
        slug: SLUG,
        department_id: DEPARTMENTS.VizBytes,
        reference_prefix: PREFIX,
        is_public: true,
        is_active: true,
      })
      .select("id")
      .single();

    if (error) throw new Error(`fixture form: ${error.message}`);
    formId = form!.id;

    const { data: members } = await admin
      .from("vizserve_pms_users")
      .select("id, email")
      .eq("primary_department_id", DEPARTMENTS.VizBytes)
      .eq("role", "member")
      .order("email");

    picId = members![0]!.id;
    qaId = members![1]!.id;
  });

  afterAll(async () => {
    if (!formId) return;
    const admin = adminClient();

    if (createdTasks.length > 0) {
      await admin.from("vizserve_pms_notifications").delete().in("entity_id", createdTasks);
      await admin.from("vizserve_pms_tasks").delete().in("id", createdTasks);
    }

    await admin.from("vizserve_pms_requests").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_public_submission_log").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_reference_counters").delete().eq("form_id", formId);
    await admin.from("vizserve_pms_forms").delete().eq("id", formId);
  });

  // =========================================================================
  // The token itself
  // =========================================================================
  describe("token storage", () => {
    it.skipIf(!migrationApplied)("stores only a hash — the raw token is nowhere", async () => {
      // A database leak must not yield working approval links. This is the
      // single most important property of the whole design.
      const { token } = await taskAwaitingApproval();

      const { data: rows } = await adminClient()
        .from("vizserve_pms_approval_tokens")
        .select("*");

      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain(token);
    });

    it.skipIf(!migrationApplied)("issues a 256-bit token", async () => {
      const { token } = await taskAwaitingApproval();
      // 32 bytes, hex encoded. Guessing must be infeasible, so the length is
      // worth asserting rather than assuming.
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it.skipIf(!migrationApplied)("issues a different token every time", async () => {
      const a = await taskAwaitingApproval();
      const b = await taskAwaitingApproval();
      expect(a.token).not.toBe(b.token);
    });

    it.skipIf(!migrationApplied)("binds the token to the requester's email", async () => {
      const { taskId } = await taskAwaitingApproval();

      const { data: token } = await adminClient()
        .from("vizserve_pms_approval_tokens")
        .select("requester_email, task_id")
        .eq("task_id", taskId)
        .limit(1)
        .single();

      const { data: task } = await adminClient()
        .from("vizserve_pms_tasks")
        .select("request_id")
        .eq("id", taskId)
        .single();

      const { data: request } = await adminClient()
        .from("vizserve_pms_requests")
        .select("requester_email")
        .eq("id", task!.request_id!)
        .single();

      expect(token!.requester_email.toLowerCase()).toBe(request!.requester_email.toLowerCase());
    });
  });

  // =========================================================================
  // THE ONES THAT MATTER MOST
  // =========================================================================
  describe("replay and reuse", () => {
    it.skipIf(!migrationApplied)("refuses a second decision on the same token", async () => {
      // No replay, and no changing the answer after the fact.
      const { taskId, token } = await taskAwaitingApproval();

      const first = await decide(token, "APPROVED");
      expect((first.data as { ok: boolean }).ok).toBe(true);
      expect(await statusOf(taskId)).toBe("COMPLETED");

      const second = await decide(token, "REVISION_REQUESTED", "Actually, change the date.");
      expect((second.data as { ok: boolean; error: string }).ok).toBe(false);
      expect((second.data as { error: string }).error).toBe("already_used");

      // And the task did not move on the second attempt.
      expect(await statusOf(taskId)).toBe("COMPLETED");
    });

    it.skipIf(!migrationApplied)(
      "a token for task A cannot act on task B",
      async () => {
        // Cross-task reuse is impossible by construction — the token IS bound to
        // a task, so there is no task parameter to tamper with. Asserted by
        // showing that redeeming A's token moves A and leaves B alone.
        const a = await taskAwaitingApproval();
        const b = await taskAwaitingApproval();

        await decide(a.token, "APPROVED");

        expect(await statusOf(a.taskId)).toBe("COMPLETED");
        expect(await statusOf(b.taskId)).toBe("FOR_CLIENT_APPROVAL");

        const { data: decisions } = await adminClient()
          .from("vizserve_pms_client_decisions")
          .select("task_id")
          .eq("task_id", b.taskId);

        expect(decisions).toEqual([]);
      },
    );

    it.skipIf(!migrationApplied)("refuses a made-up token", async () => {
      const { data } = await decide("0".repeat(64), "APPROVED");
      expect((data as { ok: boolean; error: string })).toMatchObject({
        ok: false,
        error: "invalid",
      });
    });

    it.skipIf(!migrationApplied)("refuses an empty token", async () => {
      const { data } = await decide("", "APPROVED");
      expect((data as { ok: boolean }).ok).toBe(false);
    });

    it.skipIf(!migrationApplied)("refuses an expired token", async () => {
      const { taskId, token } = await taskAwaitingApproval();

      await adminClient()
        .from("vizserve_pms_approval_tokens")
        // @ts-expect-error tokens are function-managed by design; the test is
        // deliberately doing what the app cannot, to age one.
        .update({ expires_at: WELL_IN_THE_PAST() })
        .eq("task_id", taskId);

      const { data } = await decide(token, "APPROVED");
      expect((data as { error: string }).error).toBe("expired");
      expect(await statusOf(taskId)).toBe("FOR_CLIENT_APPROVAL");
    });

    it.skipIf(!migrationApplied)(
      "refuses a feedback token used on the approval endpoint",
      async () => {
        // Two purposes, one table. Without the purpose check, a feedback link —
        // which is sent AFTER completion and is therefore the one a client is
        // most likely to still have — would approve work.
        const { taskId } = await taskAwaitingApproval();

        const { data: issued } = await adminClient().rpc("vizserve_pms_issue_approval_token", {
          p_task_id: taskId,
          p_purpose: "feedback",
        });

        const { data } = await decide((issued as { token: string }).token, "APPROVED");
        expect((data as { ok: boolean }).ok).toBe(false);
      },
    );

    it.skipIf(!migrationApplied)(
      "refuses a decision once the task has moved on",
      async () => {
        const { taskId, token } = await taskAwaitingApproval();

        // A TL pulls it back after the email went out.
        const tl = await signIn("tlVizBytes");
        await tl.client.rpc("vizserve_pms_force_task_status", {
          p_task_id: taskId,
          p_to_status: "ONGOING",
          p_reason: "Spotted a mistake after it went to the client.",
        });

        const { data } = await decide(token, "APPROVED");
        expect((data as { error: string }).error).toBe("no_longer_open");
        expect(await statusOf(taskId)).toBe("ONGOING");
      },
    );
  });

  // =========================================================================
  // P4-06 / P4-07
  // =========================================================================
  describe("the decision paths", () => {
    it.skipIf(!migrationApplied)("approve completes the task and records evidence", async () => {
      const { taskId, token } = await taskAwaitingApproval();

      await decide(token, "APPROVED", undefined, "Samantha Cruz");

      expect(await statusOf(taskId)).toBe("COMPLETED");

      const { data: decision } = await adminClient()
        .from("vizserve_pms_client_decisions")
        .select("decision, approver_name, ip, user_agent")
        .eq("task_id", taskId)
        .single();

      // Evidence, for the dispute this feature will eventually cause.
      expect(decision).toMatchObject({
        decision: "APPROVED",
        approver_name: "Samantha Cruz",
        ip: "203.0.113.9",
        user_agent: "vitest",
      });
    });

    it.skipIf(!migrationApplied)("refuses a revision request with no comment", async () => {
      const { taskId, token } = await taskAwaitingApproval();

      const { data } = await decide(token, "REVISION_REQUESTED", "   ");
      expect((data as { error: string }).error).toBe("comment_required");
      expect(await statusOf(taskId)).toBe("FOR_CLIENT_APPROVAL");

      // And the token is NOT consumed — a rejected attempt must not cost the
      // client their one chance to answer.
      const { data: token_row } = await adminClient()
        .from("vizserve_pms_approval_tokens")
        .select("consumed_at")
        .eq("task_id", taskId)
        .limit(1)
        .single();
      expect(token_row!.consumed_at).toBeNull();
    });

    it.skipIf(!migrationApplied)(
      "revision returns the task to ONGOING with the comment reaching the PIC",
      async () => {
        const { taskId, token } = await taskAwaitingApproval();
        const comment = "The date says 12 August — it should be 21 August.";

        await decide(token, "REVISION_REQUESTED", comment);

        expect(await statusOf(taskId)).toBe("ONGOING");

        // Visible to the PIC through RLS, which is the actual criterion.
        const pic = await signIn("member1VizBytes");
        const { data: history } = await pic.client
          .from("vizserve_pms_task_status_history")
          .select("comment, actor_id, to_status")
          .eq("task_id", taskId)
          .eq("to_status", "ONGOING")
          .order("created_at", { ascending: false });

        expect(history![0]!.comment).toBe(comment);
        // The client has no user row, and attributing their decision to
        // whoever was signed in would be a lie in the record a dispute turns on.
        expect(history![0]!.actor_id).toBeNull();

        const { data: notifications } = await adminClient()
          .from("vizserve_pms_notifications")
          .select("user_id, type")
          .eq("entity_id", taskId)
          .eq("type", "client_decision");

        const told = new Set(notifications!.map((row) => row.user_id));
        expect(told.has(picId)).toBe(true);
        expect(told.has(qaId)).toBe(true);
      },
    );
  });

  // =========================================================================
  // P4-09
  // =========================================================================
  describe("auto-completion", () => {
    it.skipIf(!migrationApplied)(
      "closes an overdue task as COMPLETED_NO_RESPONSE, never COMPLETED",
      async () => {
        // The distinction the whole dispute story rests on.
        const { taskId } = await taskAwaitingApproval();

        await adminClient()
          .from("vizserve_pms_approval_tokens")
          // @ts-expect-error deliberately ageing a function-managed row.
          .update({ auto_complete_at: WELL_IN_THE_PAST() })
          .eq("task_id", taskId);

        const { data: closed } = await adminClient().rpc("vizserve_pms_auto_complete_approvals");

        expect((closed ?? []).some((row) => row.task_id === taskId)).toBe(true);
        expect(await statusOf(taskId)).toBe("COMPLETED_NO_RESPONSE");

        const { data: decision } = await adminClient()
          .from("vizserve_pms_client_decisions")
          .select("decision")
          .eq("task_id", taskId)
          .single();
        expect(decision!.decision).toBe("AUTO_COMPLETED");
      },
    );

    it.skipIf(!migrationApplied)("consumes the token, so the link stops working", async () => {
      const { taskId, token } = await taskAwaitingApproval();

      await adminClient()
        .from("vizserve_pms_approval_tokens")
        // @ts-expect-error deliberately ageing a function-managed row.
        .update({ auto_complete_at: WELL_IN_THE_PAST() })
        .eq("task_id", taskId);

      await adminClient().rpc("vizserve_pms_auto_complete_approvals");

      const { data } = await decide(token, "APPROVED");
      expect((data as { ok: boolean }).ok).toBe(false);
    });

    it.skipIf(!migrationApplied)("leaves a task whose window has not passed alone", async () => {
      const { taskId } = await taskAwaitingApproval();

      await adminClient().rpc("vizserve_pms_auto_complete_approvals");

      expect(await statusOf(taskId)).toBe("FOR_CLIENT_APPROVAL");
    });

    it.skipIf(!migrationApplied)("cannot be requested as a client decision", async () => {
      const { token } = await taskAwaitingApproval();
      const { error } = await decide(token, "AUTO_COMPLETED");
      expect(error).not.toBeNull();
    });
  });

  // =========================================================================
  // Reach
  // =========================================================================
  describe("what anon can touch", () => {
    it.skipIf(!migrationApplied)("no table privilege on any Phase 4 table", async () => {
      for (const table of [
        "vizserve_pms_approval_tokens",
        "vizserve_pms_client_decisions",
        "vizserve_pms_feedback",
      ] as const) {
        const { error } = await anonClient().from(table).select("id");
        expect(error, `${table} should be unreachable`).not.toBeNull();
      }
    });

    it.skipIf(!migrationApplied)("cannot mint a token", async () => {
      // A staff member who could mint one could approve their own work as the
      // client — the entire gate defeated in a single call. Not granted to
      // `authenticated` either.
      const { error: anonError } = await anonClient().rpc("vizserve_pms_issue_approval_token", {
        p_task_id: crypto.randomUUID(),
      });
      expect(anonError).not.toBeNull();

      const tl = await signIn("tlVizBytes");
      const { error: staffError } = await tl.client.rpc("vizserve_pms_issue_approval_token", {
        p_task_id: crypto.randomUUID(),
      });
      expect(staffError).not.toBeNull();
    });

    it.skipIf(!migrationApplied)("cannot run the auto-complete job", async () => {
      const { error } = await anonClient().rpc("vizserve_pms_auto_complete_approvals");
      expect(error).not.toBeNull();
    });

    it.skipIf(!migrationApplied)(
      "but the SERVICE ROLE can run every function it owns",
      async () => {
        // The other half of the previous two assertions, and the one that was
        // missing. `revoke all ... from public` correctly stops `authenticated`
        // minting a token — and also removes the implicit grant the service role
        // was standing on, because Postgres grants EXECUTE to PUBLIC by default
        // and the P0-06 grants migration set ALTER DEFAULT PRIVILEGES for tables
        // and sequences but not functions.
        //
        // The result was a gate that failed closed: nobody could mint a token,
        // including the cron. `permission denied for function` is a missing
        // GRANT, never a failed policy — the same diagnostic as the original
        // grants incident, in a corner nobody had swept.
        const admin = adminClient();

        for (const [fn, args] of [
          ["vizserve_pms_auto_complete_approvals", {}],
          ["vizserve_pms_claim_approval_reminders", { p_max: 1 }],
        ] as const) {
          const { error } = await admin.rpc(fn, args as never);
          expect(error, `service_role must be able to call ${fn}`).toBeNull();
        }
      },
    );

    it.skipIf(!migrationApplied)(
      "sees only render-safe fields on the approval page",
      async () => {
        const { token } = await taskAwaitingApproval();
        const { data } = await anonClient().rpc("vizserve_pms_get_approval_page", {
          p_token: token,
        });

        const page = data as Record<string, unknown>;
        expect(page.ok).toBe(true);
        // No org chart, no internal routing.
        expect(page).not.toHaveProperty("department_id");
        expect(page).not.toHaveProperty("assignee_id");
        expect(page).not.toHaveProperty("qa_assignee_id");
        expect(page).not.toHaveProperty("token_hash");
      },
    );

    it.skipIf(!migrationApplied)(
      "gets the same shape of answer for invalid and expired",
      async () => {
        // Distinguishing them tells an enumerator which guesses were close.
        const { data } = await anonClient().rpc("vizserve_pms_get_approval_page", {
          p_token: "deadbeef".repeat(8),
        });

        expect(data).toMatchObject({ ok: false });
        expect(Object.keys(data as object).sort()).toEqual(["error", "ok"]);
      },
    );
  });

  // =========================================================================
  // Q6 — business days
  // =========================================================================
  describe("the approval window", () => {
    it.skipIf(!migrationApplied)(
      "vizserve_pms_holidays still contains every seeded 2026 regular holiday",
      async () => {
        /*
         * A SUBSET, NOT AN EQUALITY, and the change is deliberate.
         *
         * This asserted the two were identical, which was correct while only a
         * migration could write the table. P7-35 made it admin-editable, so
         * special non-working days and future years arrive by proclamation and
         * legitimately have no counterpart in `PH_HOLIDAYS` — equality would now
         * fail on an admin doing exactly what the screen is for.
         *
         * What is still worth guarding is the other direction: a statutory
         * holiday going MISSING. That would quietly close client tickets a day
         * early and lengthen everybody\u2019s leave by a day, and nothing else
         * would say so.
         */
        const { data: rows } = await adminClient()
          .from("vizserve_pms_holidays")
          .select("holiday_date")
          .gte("holiday_date", "2026-01-01")
          .lte("holiday_date", "2026-12-31");

        const fromDb = new Set((rows ?? []).map((row) => row.holiday_date));
        const missing = PH_HOLIDAYS.filter((date) => !fromDb.has(date));

        expect(missing).toEqual([]);
      },
    );

    it.skipIf(!migrationApplied)("skips the weekend", async () => {
      // Friday + 3 business days = Wednesday. On calendar days it would be
      // Monday, having given the client roughly one working day — which is the
      // version that produces the angry phone call.
      const { data } = await adminClient().rpc("vizserve_pms_add_business_days", {
        p_from: "2026-08-07T09:00:00+08:00",
        p_days: 3,
      });

      expect((data as string).slice(0, 10)).toBe("2026-08-12");
      // And the TypeScript mirror agrees.
      expect(addBusinessDays("2026-08-07", 3)).toBe("2026-08-12");
    });

    it.skipIf(!migrationApplied)("skips a holiday", async () => {
      // 31 Aug 2026 is National Heroes Day, a Monday.
      const { data } = await adminClient().rpc("vizserve_pms_add_business_days", {
        p_from: "2026-08-28T09:00:00+08:00",
        p_days: 1,
      });

      expect((data as string).slice(0, 10)).toBe("2026-09-01");
      expect(addBusinessDays("2026-08-28", 1)).toBe("2026-09-01");
    });

    it.skipIf(!migrationApplied)("sets a deadline in the future when a token is issued", async () => {
      const { taskId } = await taskAwaitingApproval();

      const { data: token } = await adminClient()
        .from("vizserve_pms_approval_tokens")
        .select("auto_complete_at, expires_at")
        .eq("task_id", taskId)
        .limit(1)
        .single();

      expect(new Date(token!.auto_complete_at!).getTime()).toBeGreaterThan(Date.now());
      // The link must outlive the deadline it states, or the email promises
      // something that stops working before the promise expires.
      expect(new Date(token!.expires_at).getTime()).toBeGreaterThan(
        new Date(token!.auto_complete_at!).getTime(),
      );
    });
  });

  // =========================================================================
  // P4-11 — feedback
  // =========================================================================
  describe("feedback", () => {
    it.skipIf(!migrationApplied)("accepts one rating and refuses a second", async () => {
      const { taskId, token } = await taskAwaitingApproval();
      await decide(token, "APPROVED");

      const { data: issued } = await adminClient().rpc("vizserve_pms_issue_approval_token", {
        p_task_id: taskId,
        p_purpose: "feedback",
      });
      const feedbackToken = (issued as { token: string }).token;

      const first = await anonClient().rpc("vizserve_pms_submit_feedback", {
        p_token: feedbackToken,
        p_rating: 5,
        p_comment: "Quick and exactly right.",
      });
      expect((first.data as { ok: boolean }).ok).toBe(true);

      // A client who can rate twice can rate a hundred times.
      const second = await anonClient().rpc("vizserve_pms_submit_feedback", {
        p_token: feedbackToken,
        p_rating: 1,
        p_comment: null,
      });
      expect((second.data as { ok: boolean }).ok).toBe(false);

      const { data: stored } = await adminClient()
        .from("vizserve_pms_feedback")
        .select("rating, comment")
        .eq("task_id", taskId)
        .single();
      expect(stored!.rating).toBe(5);
    });

    it.skipIf(!migrationApplied)("refuses a rating outside 1–5", async () => {
      const { taskId } = await taskAwaitingApproval();

      const { data: issued } = await adminClient().rpc("vizserve_pms_issue_approval_token", {
        p_task_id: taskId,
        p_purpose: "feedback",
      });

      const { data } = await anonClient().rpc("vizserve_pms_submit_feedback", {
        p_token: (issued as { token: string }).token,
        p_rating: 9,
        p_comment: null,
      });

      expect((data as { ok: boolean; error: string })).toMatchObject({
        ok: false,
        error: "invalid_rating",
      });
    });

    it.skipIf(!migrationApplied)("is readable by the department's lead", async () => {
      const { taskId, token } = await taskAwaitingApproval();
      await decide(token, "APPROVED");

      const { data: issued } = await adminClient().rpc("vizserve_pms_issue_approval_token", {
        p_task_id: taskId,
        p_purpose: "feedback",
      });

      await anonClient().rpc("vizserve_pms_submit_feedback", {
        p_token: (issued as { token: string }).token,
        p_rating: 4,
        p_comment: null,
      });

      const tl = await signIn("tlVizBytes");
      const { data } = await tl.client
        .from("vizserve_pms_feedback")
        .select("rating")
        .eq("task_id", taskId);
      expect(data).toHaveLength(1);

      // Feedback is about the team's performance — another department's lead
      // has no business reading it.
      const other = await signIn("tlVizAssists");
      const { data: theirs } = await other.client
        .from("vizserve_pms_feedback")
        .select("rating")
        .eq("task_id", taskId);
      expect(theirs).toEqual([]);
    });
  });
});
