import { describe, expect, it } from "vitest";

import { BATHROOM_SLOT, BATHROOM_STAY, DESK_COLS, assignSeats, bathroomIsTaken, bathroomPeriod, describeOfficePerson, isOfficeHours, isSmoker, layoutOffice, wearsPink, officeActivity, officeStatus, officeTheme, type OfficePunch } from "@/lib/office";

const today = "2026-10-31";
const yesterday = "2026-10-30";
const now = new Date("2026-10-31T09:00:00Z"); // 17:00 Manila
const person = { id: "p1", full_name: "Ana Reyes", primary_department_id: "d1" };
const at = (iso: string) => `${iso}+08:00`;

const status = (punches: OfficePunch[], onLeave = false) =>
  officeStatus({ person, punches, onLeave, today, yesterday, now });

describe("officeStatus", () => {
  it("is working when timed in today and not out", () => {
    const s = status([{ user_id: "p1", work_date: today, time_in: at("2026-10-31T08:00:00"), time_out: null }]);
    expect(s.status).toBe("working");
    expect(s.minutesSoFar).toBe(9 * 60);
    expect(s.longShift).toBe(false);
  });

  it("is gone home once timed out", () => {
    const s = status([
      { user_id: "p1", work_date: today, time_in: at("2026-10-31T08:00:00"), time_out: at("2026-10-31T16:00:00") },
    ]);
    expect(s.status).toBe("gone");
  });

  it("is still at the desk after forgetting to time out yesterday — and flagged", () => {
    const s = status([{ user_id: "p1", work_date: yesterday, time_in: at("2026-10-30T08:00:00"), time_out: null }]);
    expect(s.status).toBe("working");
    expect(s.fromYesterday).toBe(true);
    expect(s.longShift).toBe(true);
  });

  it("is on leave with no punch, but working if they timed in anyway", () => {
    expect(status([], true).status).toBe("leave");
    expect(
      status([{ user_id: "p1", work_date: today, time_in: at("2026-10-31T08:00:00"), time_out: null }], true).status,
    ).toBe("working");
  });

  it("is out with nothing at all, and ignores other people's punches", () => {
    expect(status([{ user_id: "p2", work_date: today, time_in: at("2026-10-31T08:00:00"), time_out: null }]).status).toBe(
      "out",
    );
  });

  it("is in with no times when the database says only that they are in a shared room", () => {
    const s = officeStatus({ person, punches: [], onLeave: false, inSharedRoom: true, today, yesterday, now });
    expect(s.status).toBe("working");
    expect(s.timeIn).toBeNull();
    expect(describeOfficePerson({ ...s, hidden: true })).toBe("in today");
  });

  it("keeps the real times for a viewer who was given them", () => {
    const s = officeStatus({
      person,
      punches: [{ user_id: "p1", work_date: today, time_in: at("2026-10-31T08:00:00"), time_out: null }],
      onLeave: false,
      inSharedRoom: true,
      today,
      yesterday,
      now,
    });
    expect(s.timeIn).toBe(at("2026-10-31T08:00:00"));
    expect(s.minutesSoFar).toBe(9 * 60);
  });
});

describe("layoutOffice", () => {
  const p = (id: string, departmentId: string | null, s: "working" | "out" = "out") => ({
    id,
    name: id,
    departmentId,
    status: s,
    timeIn: null,
    timeOut: null,
    minutesSoFar: null,
    longShift: false,
    fromYesterday: false,
  });
  const depts = [
    { id: "d1", name: "Design" },
    { id: "d2", name: "Dev" },
    { id: "d3", name: "Empty" },
  ];

  it("gives each department with people a room, two per row, and counts them", () => {
    const layout = layoutOffice(depts, [p("a", "d1", "working"), p("b", "d1"), p("c", "d2")]);
    expect(layout.rooms.map((room) => room.name)).toEqual(["Design", "Dev"]);
    expect(layout.rooms[0].counts.working).toBe(1);
    expect(layout.rooms[1].x).toBeGreaterThan(layout.rooms[0].x);
    expect(layout.rooms[1].y).toBe(layout.rooms[0].y);
  });

  it("puts unknown or missing departments in the Executive Office", () => {
    const layout = layoutOffice(depts, [p("a", null), p("b", "shared-space")]);
    expect(layout.rooms.map((room) => room.name)).toEqual(["Executive Office"]);
    expect(layout.rooms[0].desks).toHaveLength(2);
  });

  it("wraps desks into rows and never overlaps two", () => {
    const many = Array.from({ length: DESK_COLS * 2 + 1 }, (_, i) => p(`p${i}`, "d1"));
    const desks = layoutOffice(depts, many).rooms[0].desks;
    expect(new Set(desks.map((desk) => `${desk.x},${desk.y}`)).size).toBe(desks.length);
    expect(new Set(desks.map((desk) => desk.y)).size).toBe(3);
  });
});

describe("officeTheme", () => {
  it.each([
    ["VizMedia", "media"],
    ["Marketing", "media"],
    ["VizBytes", "bytes"],
    ["IT", "bytes"],
    ["VizBooks", "books"],
    ["Accounting", "books"],
    ["VizAssists", "assist"],
    ["Operations", "plain"],
  ] as const)("%s → %s", (name, theme) => {
    expect(officeTheme(name)).toBe(theme);
  });
});

describe("roaming", () => {
  const at = (iso: string) => new Date(`${iso}+08:00`);

  it("is office hours on a weekday from 8 to 6, in Manila", () => {
    expect(isOfficeHours(at("2026-11-04T08:00:00"))).toBe(true); // Wednesday
    expect(isOfficeHours(at("2026-11-04T17:59:00"))).toBe(true);
    expect(isOfficeHours(at("2026-11-04T18:00:00"))).toBe(false);
    expect(isOfficeHours(at("2026-11-04T07:59:00"))).toBe(false);
    expect(isOfficeHours(at("2026-11-07T10:00:00"))).toBe(false); // Saturday
    expect(isOfficeHours(at("2026-11-08T10:00:00"))).toBe(false); // Sunday
  });

  it("makes Amier, Kier and Ace the smokers, by first name only", () => {
    expect(isSmoker({ name: "Amier Ordonez" })).toBe(true);
    expect(isSmoker({ name: "Kier Santos" })).toBe(true);
    expect(isSmoker({ name: "Ace Guevarra" })).toBe(true);
    expect(isSmoker({ name: "Joel Santos" })).toBe(false);
    expect(isSmoker({ name: "Grace Ace" })).toBe(false);
    expect(isSmoker({ name: "Amierah Cruz" })).toBe(false);
    expect(isSmoker({ name: "" })).toBe(false);
  });

  it("makes no claim about the DTR of a roamer whose DTR is withheld", () => {
    const base = officeStatus({ person, punches: [], onLeave: false, today, yesterday, now });
    expect(describeOfficePerson({ ...base, roams: true, hidden: true })).toBe("on the floor today");
    expect(describeOfficePerson({ ...base, roams: true, hidden: false })).toBe("not timed in today");
  });
});

describe("wearsPink", () => {
  it("dresses Raiza in pink, by first name only", () => {
    expect(wearsPink({ name: "Raiza Cruz" })).toBe(true);
    expect(wearsPink({ name: "Maria Raiza" })).toBe(false);
    expect(wearsPink({ name: "" })).toBe(false);
  });
});

describe("the comfort room", () => {
  it("gives each person a turn that never overlaps the next", () => {
    expect(BATHROOM_STAY).toBeLessThan(BATHROOM_SLOT);
    const count = 12;
    const period = bathroomPeriod(count);
    expect(period).toBe(count * BATHROOM_SLOT);
    for (let i = 0; i < count; i++) {
      const next = (i * BATHROOM_SLOT + BATHROOM_STAY) % period;
      expect(next).toBeLessThanOrEqual(((i + 1) * BATHROOM_SLOT) % period || period);
    }
  });

  it("is taken during a turn and free between turns", () => {
    expect(bathroomIsTaken(5, 3)).toBe(true);
    expect(bathroomIsTaken(BATHROOM_STAY + 1, 3)).toBe(false);
    expect(bathroomIsTaken(BATHROOM_SLOT + 5, 3)).toBe(true);
    // Three people on eight slots: the fourth slot has nobody in it.
    expect(bathroomIsTaken(BATHROOM_SLOT * 3 + 5, 3)).toBe(false);
  });

  it("is never taken with nobody in", () => {
    expect(bathroomIsTaken(5, 0)).toBe(false);
  });
});

describe("officeActivity", () => {
  // Manila is UTC+8.
  const at = (iso: string) => new Date(`${iso}+08:00`);

  it("is lunch at noon, any day", () => {
    expect(officeActivity(at("2026-10-28T12:30:00"))).toBe("lunch"); // Wednesday
    expect(officeActivity(at("2026-10-30T12:00:00"))).toBe("lunch"); // Friday
  });

  it("is the all-hands on Friday from 4 to 5", () => {
    expect(officeActivity(at("2026-10-30T16:00:00"))).toBe("allhands");
    expect(officeActivity(at("2026-10-30T16:59:00"))).toBe("allhands");
    expect(officeActivity(at("2026-10-30T17:00:00"))).toBe("desk");
  });

  it("is not the all-hands on another day at 4", () => {
    expect(officeActivity(at("2026-10-29T16:30:00"))).toBe("desk"); // Thursday
  });

  it("reads Manila time, not the machine's", () => {
    expect(officeActivity(new Date("2026-10-30T08:30:00Z"))).toBe("allhands"); // 16:30 Manila
  });
});

describe("assignSeats", () => {
  it("seats people in a stable order and leaves the overflow out", () => {
    const seats = assignSeats(["c", "a", "b"], [1, 2]);
    expect(seats.get("a")).toBe(1);
    expect(seats.get("b")).toBe(2);
    expect(seats.has("c")).toBe(false);
  });
});
