/**
 * Where people walk in the virtual office. Pure, so it is tested without a browser
 * (`tests/unit/office-walk.test.ts`). The drawing is `app/(app)/dtr/office-3d.tsx`.
 *
 * Everything here is a loop worked out once from the floor plan, and where somebody
 * is at any moment comes from the clock, so a walk costs no re-render.
 */

import type { OfficeDesk, OfficeRoom } from "@/lib/office";

export type Point = [number, number];

export type StopActivity = "smoke" | "squat" | "curl" | "run" | "bike" | "sit" | "inside" | "talk";

/**
 * A place somebody visits: `route[0]` is where they join it, the last point is where
 * they stay. They walk it back out afterwards, unless `oneWay`, when the next stop
 * carries on from there. `does` and `facing` are for people; the cat only sits.
 */
export type CatStop = {
  route: Point[];
  stay: number;
  does?: StopActivity;
  facing?: number;
  oneWay?: boolean;
  /** Who they are talking to. They are kept at their desk for it. */
  talksTo?: string;
};

export type Leg =
  | { from: Point; to: Point; start: number; end: number }
  | { at: Point; start: number; end: number; facing: number; does?: StopActivity; talksTo?: string };

export type Trip = { legs: Leg[]; total: number };

/** The cat's walking speed, units a second. */
const SPEED = 1.1;

/** Also the walk of whoever roams the floor (P17-13), at their own speed. */
export function timeline(stops: CatStop[], speed = SPEED): Trip {
  const legs: Leg[] = [];
  let t = 0;
  const walk = (from: Point, to: Point) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (length < 0.01) return;
    legs.push({ from, to, start: t, end: t + length / speed });
    t += length / speed;
  };

  let here: Point | null = null;
  for (const stop of stops) {
    if (stop.route.length === 0) continue;
    if (here) walk(here, stop.route[0]);
    for (let i = 1; i < stop.route.length; i++) walk(stop.route[i - 1], stop.route[i]);
    const last = stop.route[stop.route.length - 1];
    const prev = stop.route[stop.route.length - 2] ?? last;
    legs.push({
      at: last,
      start: t,
      end: t + stop.stay,
      facing: stop.facing ?? Math.atan2(-(last[0] - prev[0]), -(last[1] - prev[1])),
      does: stop.does,
      talksTo: stop.talksTo,
    });
    t += stop.stay;
    if (stop.oneWay) {
      here = last;
    } else {
      for (let i = stop.route.length - 1; i > 0; i--) walk(stop.route[i], stop.route[i - 1]);
      here = stop.route[0];
    }
  }
  // Back to the first junction, to close the loop.
  if (here && stops[0]?.route[0]) walk(here, stops[0].route[0]);
  return { legs, total: t };
}

/* -------------------------------------------------------------------------- */
/* Meeting up                                                                   */
/* -------------------------------------------------------------------------- */

/** Standing and talking when they all meet, in seconds. */
export const MEET_STAY = 15;
/** With each person at their desk, before padding, in seconds. */
export const TALK_STAY = 8;
/** At their own desk, before padding, in seconds. */
export const OFFICE_STAY = 45;
/** With the guard, before padding, in seconds. */
export const GUARD_STAY = 15;
/** Out of the building, before padding, in seconds. */
export const OUT_STAY = 30;

export type WalkPlan = {
  id: string;
  /** Where they stand when everybody meets: one point, so nobody is walking at the start of a round. */
  meet: CatStop;
  rounds: CatStop[][];
};

/**
 * Loops for people who keep meeting, which only works if each of them reaches the
 * meeting at the same moment. So everybody's loop is made of rounds of EXACTLY the
 * same length, each starting at the meeting: the longest round sets the length, and
 * anybody quicker spends the difference at their stops. The trips are started at the
 * same clock (no per-person offset), which is what keeps them together.
 */
export function fitRounds(plans: readonly WalkPlan[], speed: number): Map<string, Trip> {
  const count = Math.max(1, ...plans.map((plan) => plan.rounds.length));
  const roundAt = (plan: WalkPlan, i: number) => (plan.rounds.length > 0 ? plan.rounds[i % plan.rounds.length] : []);
  const duration = (plan: WalkPlan, round: CatStop[]) => timeline([plan.meet, ...round], speed).total;
  const length = Math.max(
    0,
    ...plans.flatMap((plan) => plan.rounds.map((round) => duration(plan, round))),
    ...plans.map((plan) => duration(plan, [])),
  );

  const out = new Map<string, Trip>();
  for (const plan of plans) {
    const stops: CatStop[] = [];
    for (let i = 0; i < count; i++) {
      const round = roundAt(plan, i);
      const spare = length - duration(plan, round);
      const stayers = round.filter((stop) => stop.stay > 0).length;
      const share = stayers > 0 ? spare / stayers : 0;
      stops.push(
        { ...plan.meet, stay: plan.meet.stay + (stayers > 0 ? 0 : spare) },
        ...round.map((stop) => (stop.stay > 0 ? { ...stop, stay: stop.stay + share } : stop)),
      );
    }
    out.set(plan.id, timeline(stops, speed));
  }
  return out;
}

/** When, in each `period`, somebody is being talked to. */
export type Visit = { start: number; end: number; period: number };

/** Who a trip stops to talk to, and when. */
export function visitsIn(trip: Trip): Map<string, Visit[]> {
  const out = new Map<string, Visit[]>();
  for (const leg of trip.legs) {
    if (!("at" in leg) || !leg.talksTo) continue;
    out.set(leg.talksTo, [...(out.get(leg.talksTo) ?? []), { start: leg.start, end: leg.end, period: trip.total }]);
  }
  return out;
}

export function isVisited(visits: readonly Visit[], time: number): boolean {
  return visits.some((visit) => {
    const into = time - Math.floor(time / visit.period) * visit.period;
    return into >= visit.start && into < visit.end;
  });
}

/** Would somebody leaving at `from` and back at `to` miss a visit? Then they stay put. */
export function visitOverlaps(visits: readonly Visit[], from: number, to: number): boolean {
  return visits.some((visit) => {
    // The first time this visit ends after `from`.
    const next = Math.floor((from - visit.end) / visit.period) + 1;
    return visit.start + next * visit.period < to;
  });
}

/* -------------------------------------------------------------------------- */
/* The executives' day                                                          */
/* -------------------------------------------------------------------------- */

/** Who is at their desk to be talked to: `Occupant`'s figures, no others. */
export function canBeVisited(desk: OfficeDesk): boolean {
  const { person } = desk;
  return person.status === "working" && !person.hidden && !person.roams;
}

const doorway = (room: OfficeRoom, spine: number, hallWidth: number): Point[] => {
  const hall = room.y + room.d + hallWidth / 2;
  const door = room.x + room.w / 2;
  const inside = room.y + room.d - 0.6;
  return [[spine, hall], [door, hall], [door, inside], [room.x + 9.6, inside]];
};

/** Off the main corridor to their own chair. */
export function workInOffice(room: OfficeRoom, desk: OfficeDesk, spine: number, hallWidth: number): CatStop {
  const chair: Point = [desk.x + 1.1, desk.y + 1.6];
  const aisle = desk.y + 2.55;
  return {
    route: [...doorway(room, spine, hallWidth), [room.x + 9.6, aisle], [chair[0], aisle], chair],
    stay: OFFICE_STAY,
    does: "sit",
    facing: 0,
  };
}

/**
 * Into a department and along its desks, a word with each person in, standing at
 * the side of their chair, then back out. Nobody in: a look round, and on.
 */
export function visitRoom(room: OfficeRoom, spine: number, hallWidth: number): CatStop[] {
  const way = doorway(room, spine, hallWidth);
  const corridor = room.x + 9.6;
  const inside = way[way.length - 1];
  const talks = room.desks.filter(canBeVisited).map((desk): CatStop => {
    const stand = desk.x + 1.95;
    const aisle = desk.y + 2.55;
    return {
      route: [[corridor, aisle], [stand, aisle], [stand, desk.y + 1.6]],
      stay: TALK_STAY,
      does: "talk",
      facing: Math.PI / 2,
      talksTo: desk.person.id,
    };
  });
  const lookRound: CatStop = { route: [inside, [corridor, room.y + 1.4]], stay: TALK_STAY };
  return [
    { route: way, stay: 0, oneWay: true },
    ...(talks.length > 0 ? talks : [lookRound]),
    { route: [...way].reverse(), stay: 0, oneWay: true },
  ];
}

/**
 * Down to the lobby, a word with the guard, out of the front doors for a while, and
 * back. `lobbyEnd` is the lobby's edge at the doors, null if the floor has no room
 * for a lobby and so no guard. Offsets follow where `Lobby` draws the desk.
 */
export function leaveBuilding({
  spine,
  entranceX,
  depth,
  lobbyEnd,
}: {
  spine: number;
  entranceX: number;
  depth: number;
  lobbyEnd: number | null;
}): CatStop[] {
  const outside: Point = [entranceX, depth + 2.5];
  if (lobbyEnd === null) {
    return [{ route: [[spine, depth - 0.8], [entranceX, depth - 0.8], outside], stay: OUT_STAY, does: "inside" }];
  }
  // Clear of the desk and the turnstiles, and through the middle lane.
  const clear = lobbyEnd - 4.4;
  const desk = lobbyEnd - 2.4;
  const guard: Point = [entranceX + 2.3, desk];
  return [
    {
      route: [[spine, clear], [entranceX, clear], [entranceX, desk], guard],
      stay: GUARD_STAY,
      does: "talk",
      facing: -Math.PI / 2,
      oneWay: true,
    },
    { route: [guard, [entranceX, desk], outside], stay: OUT_STAY, does: "inside", oneWay: true },
    { route: [outside, [entranceX, clear], [spine, clear]], stay: 0, oneWay: true },
  ];
}

/**
 * Seats for a meeting at a room's table, `tableX`, `tableZ`: the four chairs `MeetingCorner`
 * draws, far side then near, then as many more as it takes in pairs either side of it,
 * facing it, kept clear of the printer and the room's front. `drawn` is false on those
 * first four, which are already there.
 */
export function meetingSeats(
  room: Pick<OfficeRoom, "y" | "d">,
  tableX: number,
  tableZ: number,
  count: number,
): { x: number; z: number; facing: number; drawn: boolean }[] {
  const seats = [
    { x: tableX - 0.45, z: tableZ - 0.8, facing: Math.PI, drawn: false },
    { x: tableX + 0.45, z: tableZ - 0.8, facing: Math.PI, drawn: false },
    { x: tableX - 0.45, z: tableZ + 0.8, facing: 0, drawn: false },
    { x: tableX + 0.45, z: tableZ + 0.8, facing: 0, drawn: false },
  ];
  for (let row = 0; seats.length < count; row++) {
    const near = tableZ + 1.7 + row * 0.9;
    const far = tableZ - 1.7 - row * 0.9;
    const nearFits = near <= room.y + room.d - 1.2;
    const farFits = far >= room.y + 1.6;
    if (!nearFits && !farFits) break;
    for (const dx of [-0.45, 0.45]) {
      if (nearFits) seats.push({ x: tableX + dx, z: near, facing: 0, drawn: true });
      if (farFits) seats.push({ x: tableX + dx, z: far, facing: Math.PI, drawn: true });
    }
  }
  return seats.slice(0, Math.max(count, 0));
}

/** Standing round one spot on the main corridor, each facing the middle. */
export function meetingStop(spine: number, z: number, place: number): CatStop {
  const [dx, dz] = ([[0, -0.7], [0.6, 0], [0, 0.7], [-0.6, 0]] as const)[place % 4];
  return { route: [[spine + dx, z + dz]], stay: MEET_STAY, does: "talk", facing: Math.atan2(dx, dz) };
}
