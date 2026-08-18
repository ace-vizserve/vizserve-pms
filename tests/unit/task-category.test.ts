import { describe, expect, it } from "vitest";

import {
  TASK_TRANSITIONS,
  availableTransitions,
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

const PIC = { isPic: true, isQa: false, leadsDepartment: false, isAdmin: false };
const QA = { isPic: false, isQa: true, leadsDepartment: false, isAdmin: false };

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

  it("does not offer that on work somebody else assigned", () => {
    expect(targets(availableTransitions("ONGOING", PIC, INTERNAL))).not.toContain("COMPLETED");
    expect(targets(availableTransitions("ONGOING", PIC, CLIENT))).not.toContain("COMPLETED");
  });

  it("sends only client work to the client gate", () => {
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
    const stranger = { isPic: false, isQa: false, leadsDepartment: false, isAdmin: false };
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
