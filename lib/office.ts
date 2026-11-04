/**
 * The office view on `/dtr` — who is at their desk right now, as rooms of desks.
 *
 * Pure: statuses and layout only, so both are tested without a browser
 * (`tests/unit/office.test.ts`). The drawing is `app/(app)/dtr/office-scene.tsx`.
 *
 * ⚠️ "WORKING" MEANS TIMED IN AND NOT TIMED OUT — NOTHING ELSE. Somebody who
 * forgot to time out is still drawn at their desk, including from yesterday:
 * the view shows what the DTR says, and an open shift IS what it says. After
 * `LONG_SHIFT_MINUTES` the figure is flagged, because that is usually the
 * forgotten time-out rather than a fourteen-hour day.
 */

import { formatAppTime, formatDuration, workedMinutes } from "@/lib/dates";

export type OfficeStatus = "working" | "gone" | "leave" | "out";

/** Past this, an open shift is flagged: "still timed in — forgot to time out?" */
export const LONG_SHIFT_MINUTES = 10 * 60;

export type OfficePunch = {
  user_id: string;
  work_date: string;
  time_in: string | null;
  time_out: string | null;
};

export type OfficePerson = {
  id: string;
  name: string;
  departmentId: string | null;
  status: OfficeStatus;
  timeIn: string | null;
  timeOut: string | null;
  /** Minutes since time-in, for someone still working. */
  minutesSoFar: number | null;
  /** Still timed in after `LONG_SHIFT_MINUTES`. */
  longShift: boolean;
  /** The open shift started yesterday. */
  fromYesterday: boolean;
  /**
   * In a department whose room the viewer sees closed (P17-07): the office
   * knows only that a desk is theirs, not who they are or whether they are in —
   * except at lunch and the all-hands, when anybody who is in is there for all to see
   * (P17-08). Even then their times stay withheld and their room stays closed.
   */
  hidden?: boolean;
  /**
   * Walks the floor rather than sitting at a desk, timed in or not (P17-13):
   * a Manager or Business Manager, during `isOfficeHours`. It changes where they
   * are drawn and nothing else — `status` still says what the DTR says.
   */
  roams?: boolean;
  /** From the staff record (P17-14). Null or absent: not set, and they keep the default hair. */
  longHair?: boolean | null;
};

export function officeStatus({
  person,
  punches,
  onLeave,
  inSharedRoom = false,
  today,
  yesterday,
  now,
}: {
  person: { id: string; full_name: string; primary_department_id: string | null };
  punches: readonly OfficePunch[];
  onLeave: boolean;
  /** The database says they are in and in a shared room, for a viewer not given their punches (P17-08). */
  inSharedRoom?: boolean;
  today: string;
  yesterday: string;
  now: Date;
}): OfficePerson {
  const base = {
    id: person.id,
    name: person.full_name,
    departmentId: person.primary_department_id,
    timeIn: null,
    timeOut: null,
    minutesSoFar: null,
    longShift: false,
    fromYesterday: false,
  };

  const mine = punches.filter((row) => row.user_id === person.id && row.time_in);
  const todayRow = mine.find((row) => row.work_date === today);
  const openYesterday = mine.find((row) => row.work_date === yesterday && !row.time_out);

  // An open shift wins over everything, leave included: if the DTR says they
  // are in, the desk is occupied.
  const open = todayRow && !todayRow.time_out ? todayRow : openYesterday;
  if (open) {
    const minutes = workedMinutes(open.time_in, now.toISOString());
    return {
      ...base,
      status: "working",
      timeIn: open.time_in,
      minutesSoFar: minutes,
      longShift: (minutes ?? 0) > LONG_SHIFT_MINUTES,
      fromYesterday: open.work_date === yesterday,
    };
  }

  if (inSharedRoom) return { ...base, status: "working" };
  if (todayRow) return { ...base, status: "gone", timeIn: todayRow.time_in, timeOut: todayRow.time_out };
  if (onLeave) return { ...base, status: "leave" };
  return { ...base, status: "out" };
}

/* -------------------------------------------------------------------------- */
/* Layout — grid units. The scene projects them isometrically.                 */
/* -------------------------------------------------------------------------- */

/** Desks per row in a room. */
export const DESK_COLS = 3;
export const CELL_W = 3;
export const CELL_D = 3.4;
/** Room margins: the back holds the sign and the plant, the front the walkway. */
const MARGIN_X = 1;
const MARGIN_BACK = 2.2;
const MARGIN_FRONT = 0.8;
/** The corridor between rooms. */
export const HALL = 1.6;
/**
 * The meeting corner at each room's right: a projector screen, a projector, a
 * small table. Furniture lives here rather than between the desks.
 */
export const AMENITY_W = 4.2;
export const ROOM_W = DESK_COLS * CELL_W + MARGIN_X * 2 + AMENITY_W;

export type OfficeDesk = { x: number; y: number; person: OfficePerson };

export type OfficeRoom = {
  id: string;
  name: string;
  /** Index into the scene's department palette. */
  colorIndex: number;
  x: number;
  y: number;
  w: number;
  d: number;
  desks: OfficeDesk[];
  counts: Record<OfficeStatus, number>;
};

export type OfficeLayout = { rooms: OfficeRoom[]; width: number; depth: number };

/**
 * Rooms in a grid two wide, each sized to its desks. A row of rooms takes the
 * depth of its deepest room, so the corridors line up.
 *
 * People are seated alphabetically. Working people are NOT moved to the front:
 * a desk is a place, and a seat that changes with the clock is not one.
 */
export function layoutOffice(
  departments: readonly { id: string; name: string }[],
  people: readonly OfficePerson[],
  columns = 2,
): OfficeLayout {
  // A department missing from the list — the shared collaboration space, an
  // inactive one — is no room to sit in; those people go to "No department".
  const known = new Set(departments.map((dept) => dept.id));
  const byDept = new Map<string, OfficePerson[]>();
  for (const person of people) {
    const key = person.departmentId && known.has(person.departmentId) ? person.departmentId : "none";
    byDept.set(key, [...(byDept.get(key) ?? []), person]);
  }

  const named = departments
    .filter((dept) => byDept.has(dept.id))
    .map((dept) => ({ id: dept.id, name: dept.name }));
  if (byDept.has("none")) named.push({ id: "none", name: "No department" });

  const sized = named.map((dept, index) => {
    const members = [...(byDept.get(dept.id) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    const rows = Math.max(1, Math.ceil(members.length / DESK_COLS));
    return { ...dept, colorIndex: index, members, d: MARGIN_BACK + rows * CELL_D + MARGIN_FRONT };
  });

  const rooms: OfficeRoom[] = [];
  let y = 0;
  for (let start = 0; start < sized.length; start += columns) {
    const row = sized.slice(start, start + columns);
    const depth = Math.max(...row.map((room) => room.d));
    row.forEach((room, col) => {
      const x = col * (ROOM_W + HALL);
      const counts: Record<OfficeStatus, number> = { working: 0, gone: 0, leave: 0, out: 0 };
      const desks = room.members.map((person, index) => {
        counts[person.status] += 1;
        return {
          x: x + MARGIN_X + (index % DESK_COLS) * CELL_W,
          y: y + MARGIN_BACK + Math.floor(index / DESK_COLS) * CELL_D,
          person,
        };
      });
      rooms.push({ id: room.id, name: room.name, colorIndex: room.colorIndex, x, y, w: ROOM_W, d: depth, desks, counts });
    });
    y += depth + HALL;
  }

  const cols = Math.min(columns, Math.max(1, sized.length));
  return { rooms, width: cols * ROOM_W + (cols - 1) * HALL, depth: Math.max(0, y - HALL) };
}

/** One line for a desk's hover card and its accessible name. */
export function describeOfficePerson(person: OfficePerson): string {
  // Their DTR is withheld from this viewer, and "not timed in" would be a claim about it.
  if (person.roams && person.hidden) return "on the floor today";
  switch (person.status) {
    case "working":
      // Another department's, seen in a shared room: in, and no more than that.
      if (person.hidden) return "in today";
      return person.fromYesterday
        ? `still timed in since yesterday ${formatAppTime(person.timeIn)}`
        : `working since ${formatAppTime(person.timeIn)} · ${formatDuration(person.minutesSoFar)}`;
    case "gone":
      return `went home at ${formatAppTime(person.timeOut)}`;
    case "leave":
      return "on leave today";
    case "out":
      return "not timed in today";
  }
}

/**
 * Which way a department's room is dressed in the 3D office, guessed from its
 * name. Anything unrecognised gets the plain poster.
 */
export type OfficeTheme = "media" | "bytes" | "books" | "assist" | "plain";

export function officeTheme(name: string): OfficeTheme {
  const n = name.toLowerCase();
  if (/media|market|creative|design/.test(n)) return "media";
  if (/byte|dev|tech|engineer|\bit\b|automat/.test(n)) return "bytes";
  if (/book|account|financ|payroll/.test(n)) return "books";
  if (/assist|\bva\b|support|admin/.test(n)) return "assist";
  return "plain";
}

/* -------------------------------------------------------------------------- */
/* The office day                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Where the people who are in should be, by the clock in Manila:
 * - "lunch"    12:00–13:00 every day — at the canteen.
 * - "allhands" Fridays 16:00–17:00 — every department together in the all-hands room.
 * - "desk"     otherwise — at their desks, now and then walking somewhere.
 */
export type OfficeActivity = "desk" | "lunch" | "allhands";

function manilaClock(now: Date): { weekday: string; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Manila",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

export function officeActivity(now: Date): OfficeActivity {
  const { weekday, minutes } = manilaClock(now);

  if (weekday === "Fri" && minutes >= 16 * 60 && minutes < 17 * 60) return "allhands";
  if (minutes >= 12 * 60 && minutes < 13 * 60) return "lunch";
  return "desk";
}

/** Weekdays, 8 AM to 6 PM in Manila: when somebody who does not time in is taken to be about. */
export function isOfficeHours(now: Date): boolean {
  const { weekday, minutes } = manilaClock(now);
  return weekday !== "Sat" && weekday !== "Sun" && minutes >= 8 * 60 && minutes < 18 * 60;
}

/**
 * Who takes smoke breaks in the office: Amier, Kier and Ace, at the user's request
 * (P17-13). Read off the first name because this is a joke about three people, not
 * a rule, and a column for it would be absurd.
 */
export function isSmoker(person: Pick<OfficePerson, "name">): boolean {
  return /^(amier|kier|ace)\b/i.test(person.name);
}

/** Raiza dresses in pink, at the user's request. A joke about one person, like `isSmoker`. */
export function wearsPink(person: Pick<OfficePerson, "name">): boolean {
  return /^raiza\b/i.test(person.name);
}

/** Seconds of the comfort room each person gets, out of each slot of `BATHROOM_SLOT`. */
export const BATHROOM_STAY = 20;
export const BATHROOM_SLOT = 60;
/** Fewer people than this still wait as long, so a small team is not always in there. */
const BATHROOM_MIN_SLOTS = 8;

/** How often, in seconds, each of `count` people gets a turn. */
export function bathroomPeriod(count: number): number {
  return BATHROOM_SLOT * Math.max(count, BATHROOM_MIN_SLOTS);
}

/**
 * Whether somebody is inside at `time` seconds. One at a time holds by construction:
 * person `i` of `count` is inside only from `i * BATHROOM_SLOT` for `BATHROOM_STAY`
 * in each period, and those windows never touch.
 */
export function bathroomIsTaken(time: number, count: number): boolean {
  if (count <= 0) return false;
  const inPeriod = ((time % bathroomPeriod(count)) + bathroomPeriod(count)) % bathroomPeriod(count);
  return inPeriod < count * BATHROOM_SLOT && inPeriod % BATHROOM_SLOT < BATHROOM_STAY;
}

/**
 * Seats for the people who are in, in a stable order — the same person keeps
 * the same seat all lunch. Anyone past the last seat is left out of the map
 * (and stays at their desk).
 */
export function assignSeats<T>(peopleIds: readonly string[], seats: readonly T[]): Map<string, T> {
  const out = new Map<string, T>();
  [...peopleIds].sort().forEach((id, i) => {
    if (i < seats.length) out.set(id, seats[i]);
  });
  return out;
}
