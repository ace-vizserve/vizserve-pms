import { describe, expect, it } from "vitest";

import { clientTimelineSteps, parseClientTimeline } from "@/lib/client-timeline";

/** P16-09 — what the approval page and the Gate 3 email both draw. */
describe("clientTimelineSteps", () => {
  const full = {
    requested_at: "2026-10-01T02:00:00Z",
    accepted_at: "2026-10-01T05:00:00Z",
    started_at: "2026-10-02T01:00:00Z",
    finished_at: "2026-10-05T08:00:00Z",
    reviewed_at: "2026-10-06T03:00:00Z",
    pic_name: "Test Pic",
    qa_name: "Test Reviewer",
  };

  it("draws the milestones in order, with the PIC and the reviewer", () => {
    expect(clientTimelineSteps(full)).toEqual([
      { key: "requested", label: "Request submitted", date: "1 Oct 2026", person: null },
      { key: "accepted", label: "Accepted by the team", date: "1 Oct 2026", person: null },
      { key: "started", label: "Work started", date: "2 Oct 2026", person: null },
      { key: "finished", label: "Work finished", date: "5 Oct 2026", person: "Test Pic" },
      { key: "reviewed", label: "Checked by QA", date: "6 Oct 2026", person: "Test Reviewer" },
    ]);
  });

  it("dates in Manila time, not UTC", () => {
    // 20:00 UTC on 5 Oct is 04:00 on 6 Oct in Manila.
    const steps = clientTimelineSteps({ ...full, finished_at: "2026-10-05T20:00:00Z" });
    expect(steps.find((step) => step.key === "finished")?.date).toBe("6 Oct 2026");
  });

  it("omits a step that never happened rather than drawing a dash", () => {
    const steps = clientTimelineSteps({ ...full, accepted_at: null, reviewed_at: null });
    expect(steps.map((step) => step.key)).toEqual(["requested", "started", "finished"]);
  });

  it("draws nothing for a missing or malformed payload", () => {
    expect(clientTimelineSteps(parseClientTimeline(undefined))).toEqual([]);
    expect(clientTimelineSteps(parseClientTimeline({ requested_at: 5 }))).toEqual([]);
  });
});
