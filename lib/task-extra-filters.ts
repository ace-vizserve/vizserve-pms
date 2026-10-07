import { addDays, startOfWeek, todayInAppZone } from "@/lib/dates";

/**
 * P12 — the filters the list and the board share beyond scope and kind:
 * a title search, a person (by role), and a due-date window. All in the URL,
 * like every other task filter, so a filtered view survives a refresh and can
 * be sent to somebody.
 *
 *   ?q=      text in the title
 *   ?person= "me" or a user id
 *   ?role=   any | pic | qa | assignee   (only read with ?person=)
 *   ?due=    overdue | this_week | next_week | none
 */

export const PERSON_ROLES = ["any", "pic", "qa", "assignee"] as const;
export type PersonRole = (typeof PERSON_ROLES)[number];

export const PERSON_ROLE_LABELS: Record<PersonRole, string> = {
  any: "Any role",
  pic: "PIC",
  qa: "QA reviewer",
  assignee: "Assignee (incl. PIC)",
};

export const DUE_FILTERS = ["overdue", "this_week", "next_week", "none"] as const;
export type DueFilter = (typeof DUE_FILTERS)[number];

export const DUE_FILTER_LABELS: Record<DueFilter, string> = {
  overdue: "Overdue",
  this_week: "Due this week",
  next_week: "Due next week",
  none: "No due date",
};

/** The URL keys these filters own — for "is anything filtered" and for Clear. */
export const EXTRA_FILTER_KEYS = ["q", "person", "role", "due"] as const;

export type ExtraTaskFilters = {
  /** Trimmed search text, or null. */
  q: string | null;
  /** A resolved user id ("me" already swapped for the viewer), or null. */
  person: string | null;
  role: PersonRole;
  due: DueFilter | null;
};

/** No search, no person, no due window — what a plain link to a list shows. */
export const NO_EXTRA_FILTERS: ExtraTaskFilters = { q: null, person: null, role: "any", due: null };

/** Reads the four params. `selfId` resolves `?person=me`. */
export function readExtraFilters(get: (key: string) => string | null, selfId: string): ExtraTaskFilters {
  const q = get("q")?.trim() || null;
  const personParam = get("person");
  const person = personParam === "me" ? selfId : personParam || null;
  const roleParam = get("role");
  const role = (PERSON_ROLES as readonly string[]).includes(roleParam ?? "") ? (roleParam as PersonRole) : "any";
  const dueParam = get("due");
  const due = (DUE_FILTERS as readonly string[]).includes(dueParam ?? "") ? (dueParam as DueFilter) : null;
  return { q, person, role, due };
}

/** Flattened for a query key: only what is set, as strings. */
export function extraFiltersKey(filters: ExtraTaskFilters): Record<string, string | undefined> {
  return {
    q: filters.q ?? undefined,
    person: filters.person ?? undefined,
    role: filters.person ? filters.role : undefined,
    due: filters.due ?? undefined,
  };
}

/** `%` and `_` are ILIKE wildcards; a search for "100%" must mean the character. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** The subset of the PostgREST builder the search and due filters touch. */
type FilterableTaskQuery<T> = {
  ilike(column: "title", pattern: string): T;
  lt(column: "due_date", value: string): T;
  gte(column: "due_date", value: string): T;
  lte(column: "due_date", value: string): T;
  is(column: "due_date", value: null): T;
  not(column: "status", operator: "in", value: string): T;
};

/**
 * Applies the search and due-date filters. The PERSON filter is not applied
 * here: it changes the query's BASE (`vizserve_pms_tasks_for_person`), which
 * the fetchers choose before building on it.
 *
 * "Overdue" excludes finished work, the same rule `isTaskOverdue` applies.
 */
export function applyExtraFilters<T extends FilterableTaskQuery<T>>(query: T, filters: ExtraTaskFilters): T {
  let scoped = query;

  if (filters.q) scoped = scoped.ilike("title", `%${escapeLike(filters.q)}%`);

  if (filters.due) {
    const today = todayInAppZone();
    const monday = startOfWeek(today)!;

    if (filters.due === "overdue") {
      scoped = scoped.lt("due_date", today).not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE,CANCELLED)");
    } else if (filters.due === "this_week") {
      scoped = scoped.gte("due_date", monday).lte("due_date", addDays(monday, 6)!);
    } else if (filters.due === "next_week") {
      scoped = scoped.gte("due_date", addDays(monday, 7)!).lte("due_date", addDays(monday, 13)!);
    } else {
      scoped = scoped.is("due_date", null);
    }
  }

  return scoped;
}
