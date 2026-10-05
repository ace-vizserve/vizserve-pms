/**
 * P15-09 — the figures on /hr/reports, rolled up from the rows the two audit
 * documents already print.
 *
 * ⚠️ NO NEW DEFINITIONS. "Used" is the annual report's `days_used`: approved
 * leave, attributed to the year it STARTS in — the same figure the balances
 * screen and the December audit show. The month chart is the other report's
 * overlap count, so a request running 28 Jan – 3 Feb splits across both months.
 * The two can differ by the leave that crosses New Year, and the page says so.
 *
 * Pure, so the arithmetic is tested rather than read.
 */

export type LeaveReportStatRow = {
  user_id: string;
  full_name: string;
  department_name: string | null;
  leave_type_id: string;
  code: string;
  label: string;
  sort_order: number;
  days_allocated: number | string;
  days_used: number | string;
};

export type LeaveTypeStat = {
  id: string;
  code: string;
  label: string;
  allocated: number;
  used: number;
  remaining: number;
  /** Used as a share of allocated, 0–100, or null when nothing was allocated. */
  usedPercent: number | null;
};

export type DepartmentStat = {
  name: string;
  people: number;
  used: number;
  /** Days per person in the department, one decimal. */
  perPerson: number;
};

export type PersonStat = { id: string; name: string; department: string | null; used: number };

export type LeaveStats = {
  /** Every type: actual days away. */
  used: number;
  /** Regular leave only — see EVENT_LEAVE_CODES. */
  regularAllocated: number;
  regularUsed: number;
  regularRemaining: number;
  regularUsedPercent: number | null;
  people: number;
  peopleWhoTookLeave: number;
  byType: LeaveTypeStat[];
  byDepartment: DepartmentStat[];
  topTakers: PersonStat[];
};

/** Numeric columns arrive from PostgREST as strings. Half days survive. */
function num(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function share(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/**
 * Leave granted for a life event rather than taken through the year. Everyone
 * eligible is allocated it (105 days of maternity per woman), almost nobody
 * uses it in a given year, so counting it in "allocation used" buries the
 * figure at 0%. A type HR adds later counts as regular unless it is added here.
 */
export const EVENT_LEAVE_CODES: ReadonlySet<string> = new Set([
  "MATERNITY",
  "PATERNITY",
  "SOLO_PARENT",
  "SPECIAL_WOMEN",
  "VAWC",
]);

/** The department a person without one is counted under. */
export const NO_DEPARTMENT = "No department";

export function summariseLeave(rows: LeaveReportStatRow[], topCount = 10): LeaveStats {
  const types = new Map<string, LeaveTypeStat & { sort: number }>();
  const people = new Map<string, PersonStat>();

  for (const row of rows) {
    const allocated = num(row.days_allocated);
    const used = num(row.days_used);

    const type = types.get(row.leave_type_id) ?? {
      id: row.leave_type_id,
      code: row.code,
      label: row.label,
      sort: row.sort_order,
      allocated: 0,
      used: 0,
      remaining: 0,
      usedPercent: null,
    };
    type.allocated += allocated;
    type.used += used;
    types.set(row.leave_type_id, type);

    const person = people.get(row.user_id) ?? {
      id: row.user_id,
      name: row.full_name,
      department: row.department_name,
      used: 0,
    };
    person.used += used;
    people.set(row.user_id, person);
  }

  const byType = [...types.values()]
    .sort((a, b) => a.sort - b.sort || a.label.localeCompare(b.label))
    .map((type) => ({
      id: type.id,
      code: type.code,
      label: type.label,
      allocated: round1(type.allocated),
      used: round1(type.used),
      remaining: round1(type.allocated - type.used),
      usedPercent: share(type.used, type.allocated),
    }));

  const departments = new Map<string, { people: number; used: number }>();
  for (const person of people.values()) {
    const name = person.department ?? NO_DEPARTMENT;
    const entry = departments.get(name) ?? { people: 0, used: 0 };
    entry.people += 1;
    entry.used += person.used;
    departments.set(name, entry);
  }

  const byDepartment = [...departments.entries()]
    .map(([name, entry]) => ({
      name,
      people: entry.people,
      used: round1(entry.used),
      perPerson: round1(entry.people > 0 ? entry.used / entry.people : 0),
    }))
    .sort((a, b) => b.used - a.used || a.name.localeCompare(b.name));

  const topTakers = [...people.values()]
    .filter((person) => person.used > 0)
    .map((person) => ({ ...person, used: round1(person.used) }))
    .sort((a, b) => b.used - a.used || a.name.localeCompare(b.name))
    .slice(0, topCount);

  const used = byType.reduce((sum, type) => sum + type.used, 0);
  const regular = byType.filter((type) => !EVENT_LEAVE_CODES.has(type.code));
  const regularAllocated = regular.reduce((sum, type) => sum + type.allocated, 0);
  const regularUsed = regular.reduce((sum, type) => sum + type.used, 0);

  return {
    used: round1(used),
    regularAllocated: round1(regularAllocated),
    regularUsed: round1(regularUsed),
    regularRemaining: round1(regularAllocated - regularUsed),
    regularUsedPercent: share(regularUsed, regularAllocated),
    people: people.size,
    peopleWhoTookLeave: [...people.values()].filter((person) => person.used > 0).length,
    byType,
    byDepartment,
    topTakers,
  };
}

/** Days in one month's overlap rows, one decimal. */
export function sumDays(rows: { days: number | string }[]): number {
  return round1(rows.reduce((sum, row) => sum + num(row.days), 0));
}
