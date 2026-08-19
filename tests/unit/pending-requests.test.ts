import { describe, expect, it } from "vitest";

import { pendingRequestsApply } from "@/lib/schemas/approvals";

/**
 * P7-26 — which task-view filters a PENDING REQUEST can answer.
 *
 * The rule these pin down is the one thing that makes putting requests beside
 * tasks honest: a request has no status, no priority, no assignee and no QA
 * reviewer. Where the page asks a question a request cannot answer, the
 * requests are DROPPED — never shown regardless.
 *
 * Getting this wrong is not cosmetic. A page filtered to "For QA" that still
 * lists three requests is a page whose filter is a suggestion, and the count at
 * the top of it is a lie. It is the same trap the board's `kind` note records,
 * one table along.
 */

describe("pendingRequestsApply — the unfiltered page", () => {
  it("shows them when nothing is filtered", () => {
    expect(pendingRequestsApply()).toBe(true);
    expect(pendingRequestsApply({})).toBe(true);
  });

  it("shows them on the explicit defaults", () => {
    expect(pendingRequestsApply({ kind: "all", scope: "all", hasTaskOnlyFilter: false })).toBe(
      true,
    );
  });
});

describe("pendingRequestsApply — the kind split", () => {
  it("hides them on internal work", () => {
    // Internal work is defined as having no client behind it, and a pending
    // request is nothing but a client behind it.
    expect(pendingRequestsApply({ kind: "internal" })).toBe(false);
  });

  it("keeps them on client work", () => {
    expect(pendingRequestsApply({ kind: "client" })).toBe(true);
  });
});

describe("pendingRequestsApply — the seat filters", () => {
  it("hides them under Mine", () => {
    // Nobody is assigned yet. Assigning is what approving decides.
    expect(pendingRequestsApply({ scope: "mine" })).toBe(false);
  });

  it("hides them under Waiting on my QA", () => {
    expect(pendingRequestsApply({ scope: "qa" })).toBe(false);
  });

  it("keeps them under All", () => {
    expect(pendingRequestsApply({ scope: "all" })).toBe(true);
  });
});

describe("pendingRequestsApply — filters on columns a request has not got", () => {
  it("hides them whenever a task-only filter is set", () => {
    // Status, priority and folder collapse into one boolean on purpose: the
    // rule is "any question about a task column hides these", and this function
    // should not have to learn what a status is to say so.
    expect(pendingRequestsApply({ hasTaskOnlyFilter: true })).toBe(false);
  });

  it("keeps them when no such filter is set", () => {
    expect(pendingRequestsApply({ hasTaskOnlyFilter: false })).toBe(true);
  });
});

describe("pendingRequestsApply — filters combine", () => {
  it("stays hidden when any one rule hides them", () => {
    expect(pendingRequestsApply({ kind: "client", scope: "mine" })).toBe(false);
    expect(pendingRequestsApply({ kind: "internal", scope: "all" })).toBe(false);
    expect(pendingRequestsApply({ kind: "client", scope: "all", hasTaskOnlyFilter: true })).toBe(
      false,
    );
  });

  it("is shown only when every rule allows it", () => {
    expect(
      pendingRequestsApply({ kind: "client", scope: "all", hasTaskOnlyFilter: false }),
    ).toBe(true);
  });
});
