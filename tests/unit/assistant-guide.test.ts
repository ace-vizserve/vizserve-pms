import { describe, expect, it } from "vitest";

import {
  answerQuestion,
  GUIDE_DESTINATIONS,
  GUIDE_SUGGESTIONS,
  normalise,
  PAGE_TOURS,
  planFor,
  tourForPage,
  reachableHrefs,
  stepsFor,
  withinOneEdit,
} from "@/lib/assistant/guide";

/**
 * The assistant matches a question to a screen the viewer can open. These pin
 * the questions people actually ask, and that the answer never routes anybody
 * past what their sidebar offers.
 */

const member = reachableHrefs("member", {});
const hrMember = reachableHrefs("member", { isHr: true });
const lead = reachableHrefs("team_leader", {});
const admin = reachableHrefs("admin", { isHr: true });

function goesTo(question: string, reachable: Set<string>): string | null {
  const answer = answerQuestion(question, reachable);
  return answer.kind === "go" ? (answer.destination.then ?? answer.destination.href) : null;
}

describe("normalise", () => {
  it("drops case, punctuation and a plural s", () => {
    expect(normalise("Where are my Leave Balances?")).toBe("where are my leave balance");
    expect(normalise("What's new")).toBe("what new");
  });

  it("keeps a double s", () => {
    expect(normalise("access")).toBe("access");
  });
});

describe("answerQuestion", () => {
  it.each([
    ["How do I file a leave?", "/approvals?type=LEAVE"],
    ["nakalimutan mag time out kahapon", "/approvals?type=NO_TIME_OUT"],
    ["can I file OT for saturday", "/approvals?type=OVERTIME"],
    ["status of my request", "/approvals"],
    ["paano mag time in", "/dtr"],
    ["I forgot to time in yesterday", "/approvals?type=NO_TIME_IN"],
    ["how many leave credits do I have left", "/approvals/leave"],
    ["log my hours for this week", "/timesheet"],
    ["where are my tasks", "/tasks"],
    ["who mentioned me", "/inbox"],
    ["change password", "/settings"],
    ["what's new in the portal", "/changelog"],
    ["when is the next holiday", "/"],
    ["forms", "/respond"],
    ["where do I fill up a form", "/respond"],
    ["aprovals", "/approvals"],
    ["timeshet", "/timesheet"],
  ])("%s → %s for a member", (question, href) => {
    expect(goesTo(question, member)).toBe(href);
  });

  it("opens VizCore for a payslip, for anyone", () => {
    const answer = answerQuestion("where is my sahod", member);
    expect(answer.kind).toBe("go");
    if (answer.kind === "go") expect(answer.destination.external).toBe(true);
  });

  it("sends HR to the holiday editor and everybody else to the calendar", () => {
    expect(goesTo("holidays", hrMember)).toBe("/admin/holidays");
    expect(goesTo("holidays", member)).toBe("/");
  });

  it("sends a lead asking for forms to the builder", () => {
    expect(goesTo("forms", lead)).toBe("/forms");
    expect(goesTo("how do I make a client form", lead)).toBe("/forms");
    expect(goesTo("fill up a form", lead)).toBe("/respond");
  });

  it("sends a lead to the team week to approve timesheets", () => {
    expect(goesTo("approve timesheet", lead)).toBe("/timesheet/team");
  });

  it("says a screen is locked rather than routing a member there", () => {
    const answer = answerQuestion("open the audit trail", member);
    expect(answer.kind).toBe("locked");
    expect(goesTo("open the audit trail", admin)).toBe("/admin/audit");
  });

  it("admits it does not know", () => {
    expect(answerQuestion("asdf qwerty", member).kind).toBe("unknown");
    expect(answerQuestion("   ", member).kind).toBe("unknown");
  });
});

describe("the destinations", () => {
  it("each have an id, a keyword and a step", () => {
    const ids = new Set<string>();
    for (const destination of GUIDE_DESTINATIONS) {
      expect(ids.has(destination.id), destination.id).toBe(false);
      ids.add(destination.id);
      expect(destination.keywords.length, destination.id).toBeGreaterThan(0);
      expect(destination.steps.length, destination.id).toBeGreaterThan(0);
    }
  });

  it("point at a screen some role can open", () => {
    // The owner holding HR and a department admin tick sees all but the
    // admin-only rows; the admin sees those. Together they cover every screen.
    const everything = new Set([
      ...reachableHrefs("owner", { isHr: true, isDeptAdmin: true }),
      ...admin,
    ]);
    for (const destination of GUIDE_DESTINATIONS) {
      if (destination.external) continue;
      expect(everything.has(destination.href.split("?")[0]), destination.href).toBe(true);
    }
  });

  it("speak for every kind of answer", () => {
    expect(stepsFor(answerQuestion("time in", member)).length).toBeGreaterThan(0);
    expect(stepsFor(answerQuestion("audit", member))[0].text).toContain("Audit trail");
    expect(stepsFor({ kind: "unknown" }).length).toBeGreaterThan(0);
  });

  it("offer suggestions that each resolve for a member", () => {
    for (const suggestion of GUIDE_SUGGESTIONS) {
      expect(answerQuestion(suggestion.question, member).kind, suggestion.label).toBe("go");
    }
  });
});

describe("the tour", () => {
  it("opens the request form only after the tour, on the page it ran on", () => {
    for (const destination of GUIDE_DESTINATIONS) {
      if (!destination.then) continue;
      expect(destination.then.split("?")[0], destination.id).toBe(destination.href);
    }
  });

  it("points at selectors a browser can parse", () => {
    // `document.querySelector` throws on a malformed selector, which would end
    // a tour mid-flight. jsdom is not loaded here, so check the shape instead.
    for (const destination of GUIDE_DESTINATIONS) {
      for (const step of destination.steps) {
        if (!step.target) continue;
        // Several selectors joined by ", " for one control under different ids.
        for (const part of step.target.split(", ")) {
          expect(part, destination.id).toMatch(/^[a-z]*\[[a-z-]+="[^"]+"\]$/);
        }
      }
    }
  });
});

describe("withinOneEdit", () => {
  it("allows one letter added, dropped or changed, and no more", () => {
    expect(withinOneEdit("aproval", "approval")).toBe(true);
    expect(withinOneEdit("timeshet", "timesheet")).toBe(true);
    expect(withinOneEdit("leabe", "leave")).toBe(true);
    expect(withinOneEdit("lve", "leave")).toBe(false);
    expect(withinOneEdit("inbox", "index")).toBe(false);
  });
});

describe("touring the page already open", () => {
  const clientForm = new URLSearchParams("purpose=CLIENT_REQUEST");
  const page = tourForPage("/forms/new", clientForm);

  function planOnNewForm(question: string) {
    return planFor(question, lead, "/forms/new", page);
  }

  it("picks the page by its query where one route draws several screens", () => {
    expect(page?.title).toBe("New client form");
    expect(tourForPage("/forms/new", new URLSearchParams("purpose=INTERNAL"))?.title).toBe("New internal form");
    expect(tourForPage("/forms/new", new URLSearchParams())?.title).toBe("New form");
  });

  it("falls back to a destination's own steps for its page", () => {
    expect(tourForPage("/timesheet", new URLSearchParams())?.title).toBe("Timesheet");
    expect(tourForPage("/nowhere", new URLSearchParams())).toBeNull();
  });

  it.each(["how do I fill this up?", "help", "paano dito", "guide me through this page", "asdf"])(
    "%s → this page",
    (question) => {
      expect(planOnNewForm(question).kind).toBe("here");
    },
  );

  it("still goes elsewhere for a clear request", () => {
    const plan = planOnNewForm("how do I file a leave here");
    expect(plan.kind).toBe("answer");
    if (plan.kind === "answer" && plan.answer.kind === "go") expect(plan.answer.destination.then).toBe("/approvals?type=LEAVE");
  });

  it("tours the page asked for by name when already on it", () => {
    expect(planFor("timesheet", member, "/timesheet", tourForPage("/timesheet", new URLSearchParams())).kind).toBe("here");
  });

  it("points every page-tour step at a parseable selector", () => {
    for (const tour of PAGE_TOURS) {
      for (const step of tour.steps) {
        if (step.target) expect(step.target, tour.title).toMatch(/^[a-z]*\[[a-z-]+="[^"]+"\]$/);
      }
    }
  });
});

describe("the task tour", () => {
  const steps = GUIDE_DESTINATIONS.find((d) => d.id === "tasks")!.steps;

  it("opens New task by clicking it, then explains the dialog", () => {
    const click = steps.findIndex((step) => step.click);
    expect(steps[click].target).toBe('[data-tour="new-task"]');
    expect(steps.slice(click + 1).length).toBeGreaterThan(0);
    // Every step after the click is inside the dialog, so none may wait on a press.
    expect(steps.slice(click + 1).every((step) => step.modal)).toBe(true);
    expect(steps.slice(0, click + 1).some((step) => step.modal)).toBe(false);
  });
});
