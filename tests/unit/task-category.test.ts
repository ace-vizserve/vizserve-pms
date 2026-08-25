import { describe, expect, it } from "vitest";

import {
  TASK_STATUSES,
  TASK_TRANSITIONS,
  availableTransitions,
  nextStep,
  scopeAllows,
  taskCategory,
} from "@/lib/schemas/tasks";

/**
 * P7-01 / P7-02 — the three kinds of work, and which endings each one has.
 *
 * `tests/db/tasks.test.ts` proves this agrees with the database. These cases
 * prove the TypeScript half means what it says on its own, which is what the
 * screens rely on when they decide which buttons to draw.
 */

const CLIENT = { request_id: "0c0ffee0-0000-4000-8000-000000000001", is_personal: false };
const INTERNAL = { request_id: null, is_personal: false };
const PERSONAL = { request_id: null, is_personal: true };

const PIC = { isAssignee: true, isQa: false, leadsDepartment: false, isAdmin: false };
const QA = { isAssignee: false, isQa: true, leadsDepartment: false, isAdmin: false };

function targets(transitions: { to: string }[]): string[] {
  return transitions.map((transition) => transition.to).sort();
}

describe("taskCategory", () => {
  it("reads a request behind the task first", () => {
    expect(taskCategory(CLIENT)).toBe("request");
    // A client task should never be flagged personal, but if it somehow were,
    // the request still decides — it is the fact with an outside party attached.
    expect(taskCategory({ ...CLIENT, is_personal: true })).toBe("request");
  });

  it("separates work a lead assigned from work you made yourself", () => {
    expect(taskCategory(INTERNAL)).toBe("internal");
    expect(taskCategory(PERSONAL)).toBe("personal");
  });
});

describe("scopeAllows", () => {
  it("lets `any` through for everything", () => {
    for (const category of ["request", "internal", "personal"] as const) {
      expect(scopeAllows("any", category)).toBe(true);
    }
  });

  it("treats personal as a kind of internal, but not the reverse", () => {
    expect(scopeAllows("internal", "personal")).toBe(true);
    expect(scopeAllows("internal", "internal")).toBe(true);
    expect(scopeAllows("internal", "request")).toBe(false);

    expect(scopeAllows("personal", "personal")).toBe(true);
    expect(scopeAllows("personal", "internal")).toBe(false);
  });

  it("keeps the client gate to work that has a client", () => {
    expect(scopeAllows("request", "request")).toBe(true);
    expect(scopeAllows("request", "internal")).toBe(false);
    expect(scopeAllows("request", "personal")).toBe(false);
  });
});

describe("availableTransitions — every category has exactly one way to finish", () => {
  it("lets the owner of a personal task close it from ONGOING", () => {
    expect(targets(availableTransitions("ONGOING", PIC, PERSONAL))).toContain("COMPLETED");
  });

  it("does not let CLIENT work skip to done", () => {
    // Internal work used to be barred from this too. P7-13 removed that: work
    // with no client moves freely, and closing your own internal task from
    // ONGOING is the ordinary case rather than a shortcut round a gate.
    // Client work keeps every gate, because each one has somebody outside the
    // company on the other end.
    expect(targets(availableTransitions("ONGOING", PIC, CLIENT))).not.toContain("COMPLETED");
  });

  it("lets internal work go straight to done — P7-13", () => {
    expect(targets(availableTransitions("ONGOING", PIC, INTERNAL))).toContain("COMPLETED");
  });

  it("sends only client work to the client gate", () => {
    // For internal work this is now the ONE exclusion in the free-movement
    // branch rather than a missing table row — a dead end, not a gate:
    // `vizserve_pms_issue_approval_token` refuses a task with no request, so a
    // task moved there could never be finished or moved back.
    expect(targets(availableTransitions("QA_IN_PROGRESS", QA, CLIENT))).toContain(
      "FOR_CLIENT_APPROVAL",
    );
    expect(targets(availableTransitions("QA_IN_PROGRESS", QA, INTERNAL))).not.toContain(
      "FOR_CLIENT_APPROVAL",
    );
  });

  it("gives internal work its own exit, so QA is not a dead end", () => {
    // The reason the gate above can be closed at all: without this, a task a
    // lead created by hand and sent through QA would have nowhere legal to go.
    expect(targets(availableTransitions("QA_IN_PROGRESS", QA, INTERNAL))).toContain("COMPLETED");
    expect(targets(availableTransitions("QA_IN_PROGRESS", QA, CLIENT))).not.toContain("COMPLETED");
  });

  it("still refuses somebody who holds neither seat", () => {
    const stranger = { isAssignee: false, isQa: false, leadsDepartment: false, isAdmin: false };
    expect(availableTransitions("ONGOING", stranger, PERSONAL)).toHaveLength(0);
    expect(availableTransitions("QA_IN_PROGRESS", stranger, INTERNAL)).toHaveLength(0);
  });
});

describe("the transition table itself", () => {
  it("leaves every FOR_CLIENT_APPROVAL exit open to all categories", () => {
    // Scoping the exits would strand any task force-moved into that state —
    // `vizserve_pms_force_task_status` does not consult this table at all.
    const exits = TASK_TRANSITIONS.filter((t) => t.from === "FOR_CLIENT_APPROVAL");
    expect(exits).not.toHaveLength(0);
    for (const exit of exits) expect(exit.appliesTo).toBe("any");
  });

  it("demands a resolution on every route to COMPLETED that a person drives", () => {
    // The client and the auto-complete cron are exempt: by the time either runs,
    // the resolution was already required to reach the gate.
    const owned = TASK_TRANSITIONS.filter(
      (t) => t.to === "COMPLETED" && (t.actor === "pic" || t.actor === "qa"),
    );
    expect(owned).not.toHaveLength(0);
    for (const transition of owned) {
      if (transition.from === "ONGOING") expect(transition.requires).toBe("resolution");
    }
  });
});

/**
 * P7-28 — the ONE move promoted to a button.
 *
 * Every case here is a claim about what the task page's primary button says,
 * and each one is a move `availableTransitions` already offers — the point of
 * the function is choosing between them, never adding to them.
 */
describe("nextStep", () => {
  const QA_LEAD = { isAssignee: false, isQa: true, leadsDepartment: true, isAdmin: false };
  const ADMIN = { isAssignee: true, isQa: true, leadsDepartment: true, isAdmin: true };

  it("walks client work down the approved flow, one gate at a time", () => {
    expect(nextStep("OPEN", PIC, CLIENT)).toMatchObject({ to: "ONGOING", label: "Start work" });
    expect(nextStep("ONGOING", PIC, CLIENT)).toMatchObject({ to: "FOR_QA", label: "Send for QA" });
    expect(nextStep("FOR_QA", QA, CLIENT)).toMatchObject({ to: "QA_IN_PROGRESS" });
    expect(nextStep("QA_IN_PROGRESS", QA, CLIENT)).toMatchObject({
      to: "FOR_CLIENT_APPROVAL",
      label: "Pass QA",
    });
  });

  it("keeps the resolution gate on the button rather than routing around it", () => {
    // The button is DISABLED by the empty resolution on screen; it must still be
    // the move on offer, or the reason for the block has nothing to attach to.
    expect(nextStep("ONGOING", PIC, CLIENT)).toMatchObject({ requires: "resolution" });
  });

  it("never promotes a move somebody else has to make", () => {
    // The PIC cannot start the review; that is the QA seat's move, and the
    // honest answer for the PIC is that there is nothing to press.
    expect(nextStep("FOR_QA", PIC, CLIENT)).toBeNull();
  });

  it("never promotes the client's own answer, even for an admin", () => {
    // `availableTransitions` DOES offer these to an admin — forcing a client's
    // hand is a legal override — but a one-click "Client approved" is not a
    // button anyone should be able to press by reflex.
    expect(availableTransitions("FOR_CLIENT_APPROVAL", ADMIN, CLIENT).length).toBeGreaterThan(0);
    expect(nextStep("FOR_CLIENT_APPROVAL", ADMIN, CLIENT)).toBeNull();
  });

  it("never promotes parking the work", () => {
    // WAITING_FOR_INFO is declared between ONGOING and FOR_QA, so a naive "next
    // in enum order" makes it the headline move on every task that is going
    // fine. It is a decision somebody makes, not the default.
    for (const task of [CLIENT, INTERNAL, PERSONAL]) {
      expect(nextStep("ONGOING", PIC, task)?.to).not.toBe("WAITING_FOR_INFO");
      expect(nextStep("OPEN", PIC, task)?.to).not.toBe("WAITING_FOR_INFO");
    }
  });

  it("offers the way out of a parked task, which the enum order calls backwards", () => {
    expect(nextStep("WAITING_FOR_INFO", PIC, CLIENT)).toMatchObject({
      to: "ONGOING",
      label: "Resume work",
    });
    expect(nextStep("WAITING_FOR_INFO", PIC, INTERNAL)).toMatchObject({ to: "ONGOING" });
  });

  it("gives internal work the same wording as client work for the same move", () => {
    // Free movement synthesises its transitions with the STATUS NAME as the
    // label, so without the lookup this would read "For QA" on one kind of task
    // and "Send for QA" on the other for an identical step.
    expect(nextStep("ONGOING", PIC, INTERNAL)).toMatchObject({
      to: "FOR_QA",
      label: "Send for QA",
    });
    expect(nextStep("QA_IN_PROGRESS", QA_LEAD, INTERNAL)).toMatchObject({
      to: "COMPLETED",
      label: "Pass QA and close",
    });
  });

  it("sends personal work straight to done — P7-02", () => {
    // QA is still REACHABLE on personal work through the dropdown; it is simply
    // not the expected route, so it is not what the button offers.
    expect(nextStep("ONGOING", PIC, PERSONAL)).toMatchObject({
      to: "COMPLETED",
      label: "Mark it done",
    });
    expect(targets(availableTransitions("ONGOING", PIC, PERSONAL))).toContain("FOR_QA");
  });

  it("has nothing to say once the work is finished", () => {
    // Internal work can legally be reopened (P7-06) and that move stays in the
    // dropdown — but "reopen" is not what a primary button on a closed task
    // should invite.
    expect(nextStep("COMPLETED", PIC, INTERNAL)).toBeNull();
    expect(nextStep("COMPLETED_NO_RESPONSE", PIC, CLIENT)).toBeNull();
    expect(targets(availableTransitions("COMPLETED", PIC, INTERNAL))).toContain("ONGOING");
  });

  it("has nothing to say to somebody holding neither seat", () => {
    const stranger = { isAssignee: false, isQa: false, leadsDepartment: false, isAdmin: false };
    for (const task of [CLIENT, INTERNAL, PERSONAL]) {
      expect(nextStep("ONGOING", stranger, task)).toBeNull();
    }
  });

  it("only ever returns a move the server would accept", () => {
    // The whole safety property in one case: whatever this promotes must be in
    // the set `availableTransitions` produced, for every status and seat.
    for (const task of [CLIENT, INTERNAL, PERSONAL]) {
      for (const status of TASK_STATUSES) {
        const step = nextStep(status, ADMIN, task);
        if (step === null) continue;
        expect(targets(availableTransitions(status, ADMIN, task))).toContain(step.to);
      }
    }
  });
});

/**
 * A task can legitimately stand somewhere its own category has no stage for.
 * These are the two ways that happens, and in both the button is the way
 * onward — which is exactly when it must not disappear.
 */
describe("nextStep — off the category's own path", () => {
  it("still closes personal work that was sent to QA anyway", () => {
    // P7-13a lets personal work reach FOR_QA from the dropdown. Personal work
    // has no QA STAGE, so there is nothing after it on its own path — the next
    // step is the ending its owner is entitled to.
    expect(nextStep("FOR_QA", PIC, PERSONAL)).toMatchObject({ to: "COMPLETED" });
  });

  it("gives forced internal work a way out of the client gate", () => {
    // `vizserve_pms_force_task_status` does not consult the transition table,
    // so a lead can strand work with no client at FOR_CLIENT_APPROVAL. Free
    // movement is the way back and this is the button for it.
    const lead = { isAssignee: true, isQa: false, leadsDepartment: true, isAdmin: false };
    expect(nextStep("FOR_CLIENT_APPROVAL", lead, INTERNAL)).toMatchObject({ to: "COMPLETED" });
  });
});
