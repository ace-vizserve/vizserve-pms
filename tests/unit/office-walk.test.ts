import { describe, expect, it } from "vitest";

import { attendsTeamMeeting, EXECUTIVES, EXECUTIVE_MEETING_MINUTES, executiveMeetingStart, inExecutiveMeeting, isExecutiveHours, layoutOffice, meetsExecutives, roomIsClosed, TEAM_MEETING_MINUTES, teamMeetingsAt, type OfficePerson } from "@/lib/office";
import {
  GUARD_STAY,
  fitRounds,
  isVisited,
  leaveBuilding,
  meetingSeats,
  meetingStop,
  timeline,
  visitOverlaps,
  visitRoom,
  visitsIn,
  type CatStop,
  type Leg,
} from "@/lib/office-walk";

const SPINE = 32.8;
const HALL = 1.6;
const GARY = "b8072285-a114-4b63-a065-bfccd8aa2d8b";
const NINA = "a3ea1241-b507-494a-856b-0497b3c7e495";

const p = (id: string, departmentId: string | null, over: Partial<OfficePerson> = {}): OfficePerson => ({
  id,
  name: id,
  departmentId,
  status: "working",
  timeIn: null,
  timeOut: null,
  minutesSoFar: null,
  longShift: false,
  fromYesterday: false,
  ...over,
});

const stops = (legs: Leg[]) => legs.filter((leg): leg is Extract<Leg, { at: unknown }> => "at" in leg);

describe("timeline", () => {
  it("walks a stop back out, unless it is one-way", () => {
    const route: CatStop["route"] = [[0, 0], [2, 0]];
    expect(timeline([{ route, stay: 1 }], 1).total).toBe(5);
    expect(timeline([{ route, stay: 1, oneWay: true }], 1).total).toBe(5);
    const next = timeline([{ route, stay: 1, oneWay: true }, { route: [[2, 0], [2, 3]], stay: 1, oneWay: true }], 1);
    // On from where they stopped, then the walk home: 2 + 1 + 3 + 1 + hypot(2, 3).
    expect(next.total).toBeCloseTo(7 + Math.hypot(2, 3));
  });
});

describe("fitRounds", () => {
  const plans = [
    { id: "a", meet: meetingStop(0, 0, 0), rounds: [[{ route: [[0, 5], [8, 5]], stay: 5 }], [{ route: [[0, 1]], stay: 1 }], [{ route: [[0, 2]], stay: 1 }]] },
    { id: "b", meet: meetingStop(0, 0, 1), rounds: [[{ route: [[0, 1]], stay: 1 }]] },
    { id: "c", meet: meetingStop(0, 0, 3), rounds: [] },
  ] as Parameters<typeof fitRounds>[0];

  it("brings everybody to the meeting at the same moments", () => {
    const trips = fitRounds(plans, 1.4);
    const meetings = (id: string) => stops(trips.get(id)!.legs).filter((leg) => leg.does === "talk").map((leg) => leg.start);
    const a = meetings("a");
    expect(a).toHaveLength(3);
    for (const id of ["b", "c"]) {
      meetings(id).forEach((start, i) => expect(start).toBeCloseTo(a[i]));
    }
    expect(trips.get("b")!.total).toBeCloseTo(trips.get("a")!.total);
    expect(trips.get("c")!.total).toBeCloseTo(trips.get("a")!.total);
  });

  it("never shortens a stop", () => {
    const trips = fitRounds(plans, 1.4);
    for (const trip of trips.values()) {
      for (const leg of trip.legs) expect(leg.end).toBeGreaterThanOrEqual(leg.start);
    }
  });
});

describe("the executives' day", () => {
  const layout = layoutOffice(
    [{ id: "d1", name: "VizBytes" }],
    [
      p("in", "d1"),
      p("out", "d1", { status: "out" }),
      p("walker", "d1", { roams: true }),
      p(GARY, null, { executive: true, roams: true, status: "out", hidden: true }),
      p(NINA, null, { executive: true, roams: true, status: "out", hidden: true }),
    ],
  );
  const room = layout.rooms[0];

  it("seats anybody with no department with them, and the room stays open", () => {
    const mixed = layoutOffice(
      [{ id: "d1", name: "VizBytes" }],
      [p(GARY, null, { executive: true, hidden: true }), p("none", null, { hidden: true }), p("left", "gone")],
    );
    expect(mixed.rooms.map((r) => r.name)).toEqual(["Executive Office"]);
    expect(mixed.rooms[0].desks).toHaveLength(3);
    expect(roomIsClosed(mixed.rooms[0])).toBe(false);
  });

  it("gives them their own room, open and counted in", () => {
    expect(layout.rooms.map((r) => r.name)).toEqual(["VizBytes", "Executive Office"]);
    expect(roomIsClosed(layout.rooms[1])).toBe(false);
    expect(layout.rooms[1].counts.working).toBe(2);
  });

  it("still closes a department's room to somebody outside it", () => {
    const other = layoutOffice([{ id: "d1", name: "VizBytes" }], [p("x", "d1", { hidden: true })]);
    expect(roomIsClosed(other.rooms[0])).toBe(true);
  });

  it("stops to talk to each person at their desk, and nobody else", () => {
    const talks = visitRoom(room, SPINE, HALL).filter((stop) => stop.does === "talk");
    expect(talks.map((stop) => stop.talksTo)).toEqual(["in"]);
  });

  it("looks round a room with nobody in, and comes back to where it joined", () => {
    const empty = layoutOffice([{ id: "d1", name: "VizBytes" }], [p("out", "d1", { status: "out" })]).rooms[0];
    const visit = visitRoom(empty, SPINE, HALL);
    expect(visit.some((stop) => stop.does === "talk")).toBe(false);
    expect(visit[visit.length - 1].route.at(-1)).toEqual(visit[0].route[0]);
  });

  it("talks to the guard, then goes out of the doors and comes back in", () => {
    const stopsOut = leaveBuilding({ spine: SPINE, entranceX: 22.6, depth: 30, lobbyEnd: 29.9 });
    expect(stopsOut[0]).toMatchObject({ does: "talk", stay: GUARD_STAY });
    expect(stopsOut[1].does).toBe("inside");
    expect(stopsOut[1].route.at(-1)![1]).toBeGreaterThan(30);
    expect(stopsOut[2].route.at(-1)![0]).toBe(SPINE);
  });

  it("goes straight out where there is no lobby and so no guard", () => {
    const stopsOut = leaveBuilding({ spine: SPINE, entranceX: 22.6, depth: 30, lobbyEnd: null });
    expect(stopsOut.map((stop) => stop.does)).toEqual(["inside"]);
  });

  it("is 8 to 5 on weekdays, in Manila", () => {
    const at = (iso: string) => new Date(`${iso}+08:00`);
    expect(isExecutiveHours(at("2026-11-04T08:00:00"))).toBe(true);
    expect(isExecutiveHours(at("2026-11-04T16:59:00"))).toBe(true);
    expect(isExecutiveHours(at("2026-11-04T17:00:00"))).toBe(false);
    expect(isExecutiveHours(at("2026-11-04T07:59:00"))).toBe(false);
    expect(isExecutiveHours(at("2026-11-07T10:00:00"))).toBe(false);
  });

  it("knows Gary and Nina, with the names a member's read withholds, and who they meet", () => {
    expect(EXECUTIVES[GARY].name).toBe("Gary Cacananta");
    expect(EXECUTIVES[NINA].name).toBe("Nina Cacananta");
    expect(meetsExecutives({ id: "37c09844-65f8-48d6-9dc9-396eb11e0930" })).toBe(true);
    expect(meetsExecutives({ id: "b21b4e11-b148-47f1-a7d8-d4b4c6d1b526" })).toBe(true);
    expect(meetsExecutives({ id: GARY })).toBe(false);
  });
});

describe("team meetings", () => {
  const at = (iso: string) => new Date(`${iso}+08:00`);
  const VIZBYTES = "a1000000-0000-4000-8000-000000000001";
  const VIZASSISTS = "a1000000-0000-4000-8000-000000000002";
  const VIZMEDIA = "some-other-department";
  const inVizBytes = (iso: string) => teamMeetingsAt(at(iso), [VIZBYTES]).length === 1;
  const noon = (i: number) => new Date(Date.UTC(2026, 10, 2 + i, 4));
  const weekdayOf = (day: Date) => new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", weekday: "short" }).format(day);
  // `day` is noon in Manila.
  const minutesInto = (day: Date, minute: number) => new Date(day.getTime() + (minute - 12 * 60) * 60000);
  const meetingOf = (day: Date, id: string) => {
    const minutes: number[] = [];
    for (let minute = 7 * 60; minute < 18 * 60; minute += 5) {
      if (teamMeetingsAt(minutesInto(day, minute), [id]).length === 1) minutes.push(minute);
    }
    return minutes;
  };

  it("holds VizBytes from 10 to 11, Monday to Wednesday", () => {
    for (const day of ["2026-11-09", "2026-11-10", "2026-11-11"]) {
      expect(inVizBytes(`${day}T09:59:00`)).toBe(false);
      expect(inVizBytes(`${day}T10:00:00`)).toBe(true);
      expect(inVizBytes(`${day}T10:59:00`)).toBe(true);
      expect(inVizBytes(`${day}T11:00:00`)).toBe(false);
      expect(inVizBytes(`${day}T13:30:00`)).toBe(false);
    }
  });

  it("holds VizBytes from 1:30 to 2:30 on Thursday and Friday", () => {
    for (const day of ["2026-11-05", "2026-11-06"]) {
      expect(inVizBytes(`${day}T13:29:00`)).toBe(false);
      expect(inVizBytes(`${day}T13:30:00`)).toBe(true);
      expect(inVizBytes(`${day}T14:29:00`)).toBe(true);
      expect(inVizBytes(`${day}T14:30:00`)).toBe(false);
      expect(inVizBytes(`${day}T10:30:00`)).toBe(false);
    }
  });

  it("gives every other department one hour every weekday, clear of lunch and the all-hands", () => {
    for (let i = 0; i < 120; i++) {
      const day = noon(i);
      const weekday = weekdayOf(day);
      const minutes = meetingOf(day, VIZMEDIA);
      if (weekday === "Sat" || weekday === "Sun") {
        expect(minutes).toEqual([]);
        continue;
      }
      expect(minutes).toHaveLength(TEAM_MEETING_MINUTES / 5);
      expect(minutes[0]).toBeGreaterThanOrEqual(8 * 60);
      expect(minutes.at(-1)!).toBeLessThan(17 * 60);
      expect(minutes.some((minute) => minute >= 12 * 60 && minute < 13 * 60)).toBe(false);
      if (weekday === "Fri") expect(minutes.some((minute) => minute >= 16 * 60)).toBe(false);
    }
  });

  it("moves from day to day, and differs between departments", () => {
    const first = Array.from({ length: 60 }, (_, i) => meetingOf(noon(i), VIZMEDIA)[0]).filter((start) => start !== undefined);
    expect(new Set(first).size).toBeGreaterThan(10);
    const other = Array.from({ length: 60 }, (_, i) => meetingOf(noon(i), VIZASSISTS)[0]).filter((start) => start !== undefined);
    expect(first.some((start, i) => start !== other[i])).toBe(true);
  });

  it("never holds the executive meeting during Amier's or Joel's team meeting", () => {
    for (let i = 0; i < 120; i++) {
      const day = noon(i);
      const start = executiveMeetingStart(day);
      if (start === null) continue;
      for (let minute = start; minute < start + EXECUTIVE_MEETING_MINUTES; minute += 5) {
        expect(teamMeetingsAt(minutesInto(day, minute), [VIZBYTES, VIZASSISTS])).toEqual([]);
      }
    }
  });

  it("is not on at the weekend", () => {
    expect(teamMeetingsAt(at("2026-11-07T10:30:00"), [VIZBYTES, VIZMEDIA])).toEqual([]);
    expect(teamMeetingsAt(at("2026-11-08T13:45:00"), [VIZBYTES, VIZMEDIA])).toEqual([]);
  });
});

describe("who attends a team meeting", () => {
  it("is a member only if they have timed in", () => {
    expect(attendsTeamMeeting({ status: "working" })).toBe(true);
    expect(attendsTeamMeeting({ status: "out" })).toBe(false);
    expect(attendsTeamMeeting({ status: "gone" })).toBe(false);
    expect(attendsTeamMeeting({ status: "leave" })).toBe(false);
  });

  it("is always somebody who does not need to time in, like Amier and Joel", () => {
    expect(attendsTeamMeeting({ status: "out", roams: true })).toBe(true);
    expect(attendsTeamMeeting({ status: "working", roams: true })).toBe(true);
  });

  it("is never somebody in a room closed to this viewer", () => {
    expect(attendsTeamMeeting({ status: "out", roams: true, hidden: true })).toBe(false);
    expect(attendsTeamMeeting({ status: "working", hidden: true })).toBe(false);
  });
});

describe("meeting seats", () => {
  // As `layoutOffice` and `meetingDepth` size a room for this many desks.
  const roomFor = (people: number) => {
    const d = 2.2 + Math.max(1, Math.ceil(people / 3)) * 3.4 + 0.8;
    return { y: 10, d, tableZ: 10 + Math.max(2.8, d / 2 + 0.3) };
  };

  it("seats a whole department, however big, on different chairs inside the room", () => {
    for (let people = 0; people <= 40; people++) {
      const room = roomFor(people);
      const seats = meetingSeats(room, 50, room.tableZ, people);
      expect(seats).toHaveLength(people);
      expect(new Set(seats.map((seat) => `${seat.x},${seat.z}`)).size).toBe(people);
      for (const seat of seats) {
        expect(seat.z).toBeGreaterThan(room.y);
        expect(seat.z).toBeLessThan(room.y + room.d);
      }
    }
  });

  it("draws a chair only beyond the table's four", () => {
    const room = roomFor(6);
    const seats = meetingSeats(room, 50, room.tableZ, 6);
    expect(seats.filter((seat) => seat.drawn)).toHaveLength(2);
    expect(meetingSeats(room, 50, room.tableZ, 4).some((seat) => seat.drawn)).toBe(false);
  });
});

describe("the daily executive meeting", () => {
  const at = (iso: string) => new Date(`${iso}+08:00`);
  const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  // Nov 2026 onwards, a year of days.
  const days = Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2026, 10, 2 + i, 4)));

  it("never runs into lunch, the all-hands, or past 5", () => {
    for (const day of days) {
      const start = executiveMeetingStart(day);
      const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", weekday: "short" }).format(day);
      if (weekday === "Sat" || weekday === "Sun") {
        expect(start).toBeNull();
        continue;
      }
      expect(start).not.toBeNull();
      const end = start! + EXECUTIVE_MEETING_MINUTES;
      expect(start!).toBeGreaterThanOrEqual(8 * 60);
      expect(end).toBeLessThanOrEqual(weekday === "Fri" ? 16 * 60 : 17 * 60);
      expect(end <= 12 * 60 || start! >= 13 * 60).toBe(true);
    }
  });

  it("moves from day to day, morning and afternoon", () => {
    const starts = days.map(executiveMeetingStart).filter((start): start is number => start !== null);
    expect(new Set(starts).size).toBeGreaterThan(30);
    expect(starts.some((start) => start < 12 * 60)).toBe(true);
    expect(starts.some((start) => start >= 13 * 60)).toBe(true);
  });

  it("is the same whole day, for everybody, and runs thirty minutes", () => {
    const start = executiveMeetingStart(at("2026-11-05T08:00:00"))!;
    expect(executiveMeetingStart(at("2026-11-05T16:59:00"))).toBe(start);
    expect(inExecutiveMeeting(at(`2026-11-05T${clock(start)}:00`))).toBe(true);
    expect(inExecutiveMeeting(at(`2026-11-05T${clock(start + 29)}:00`))).toBe(true);
    expect(inExecutiveMeeting(at(`2026-11-05T${clock(start + 30)}:00`))).toBe(false);
    expect(inExecutiveMeeting(at(`2026-11-05T${clock(start - 1)}:00`))).toBe(false);
  });

  it("does not happen at the weekend", () => {
    expect(inExecutiveMeeting(at("2026-11-07T10:00:00"))).toBe(false);
  });
});

describe("being visited", () => {
  const trip = timeline([{ route: [[0, 0]], stay: 10, does: "talk", talksTo: "ana" }, { route: [[0, 0]], stay: 90 }], 1);
  const visits = visitsIn(trip).get("ana")!;

  it("reads off the loop, every time round", () => {
    expect(visits).toEqual([{ start: 0, end: 10, period: 100 }]);
    expect(isVisited(visits, 5)).toBe(true);
    expect(isVisited(visits, 50)).toBe(false);
    expect(isVisited(visits, 205)).toBe(true);
  });

  it("keeps somebody in for a trip that would miss it", () => {
    expect(visitOverlaps(visits, 95, 105)).toBe(true);
    expect(visitOverlaps(visits, 20, 60)).toBe(false);
    expect(visitOverlaps(visits, 205, 210)).toBe(true);
    // Before the clock's zero, as a first comfort-room trip can start.
    expect(visitOverlaps(visits, -20, -5)).toBe(false);
    expect(visitOverlaps(visits, -5, 5)).toBe(true);
  });
});
