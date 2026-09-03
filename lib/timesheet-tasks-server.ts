import "server-only";

import { createClient } from "@/utils/supabase/server";

/**
 * The tasks a person may log time against.
 *
 * ONE IMPLEMENTATION, TWO CALLERS: the timesheet page's initial list and the
 * picker's search action. They had drifted before — the page asked for PIC-or-QA
 * while `vizserve_pms_may_log_time` had allowed any assignee since P7-13 — and a
 * second copy of the scoping is how that happens again.
 *
 * THE SCOPE IS `vizserve_pms_is_on_task`: the accountable name, the QA reviewer,
 * or a row in `vizserve_pms_task_assignees`. All three are equal here, which is
 * the whole point — you do not have to be the PIC to log your own hours.
 *
 * NO STATUS FILTER AND NO DATE FILTER BY DEFAULT. `may_log_time` says nothing
 * about either, so the database accepts an entry against a finished task and
 * this must offer one — finish something on Friday, log Friday's hours on
 * Monday.
 *
 * ⚠️ TWO SHORT REQUESTS, NOT ONE LONG ONE, and that is a deliberate rewrite.
 * PostgREST cannot express "or exists in that other table", so the obvious
 * shape is to read the join table for ids and then send
 * `id.in.(<every one of them>)` — which puts an unbounded list of UUIDs into a
 * GET query string. At 37 bytes each that URL outgrows what the client will
 * send long before anybody suspects it, and the failure is not a tidy 414: it
 * arrives as `TypeError: fetch failed`, which reads like the network being
 * down and sent this bug hunting through RLS and migrations for a week.
 *
 * The second half is fetched THROUGH the join table as an embed instead —
 * `task_assignees → tasks`, filtered on `user_id` alone — so both requests are
 * a fixed size whatever anybody is assigned to. The merge, the ordering and the
 * limit move here: a few lines of TypeScript for a URL that cannot blow up.
 */

export type LoggableTask = {
  id: string;
  title: string;
  status: string;
  /**
   * "Department / List", resolved HERE rather than in the caller.
   *
   * The page could look these up from maps it already holds; the picker's
   * SEARCH cannot, because its results arrive in the browser long after those
   * maps were rendered. Resolving once, on the server, is what lets both
   * callers hand the same shape to the same component.
   */
  where: string;
  created_at: string;
};

/** What the picker shows before anybody types. Newest first. */
export const LOGGABLE_TASK_LIMIT = 20;

/** What a search may return, so a two-letter query cannot pull the whole board. */
export const LOGGABLE_SEARCH_LIMIT = 50;

export type LoggableTaskFilters = {
  /** Matched against the title. */
  query?: string | null;
  /** `YYYY-MM-DD`, inclusive, against the task's CREATED date. */
  from?: string | null;
  to?: string | null;
  /** One list, from `loadLoggableTaskLists` — never free text. */
  listId?: string | null;
  limit?: number;
};

/**
 * The columns both halves select.
 *
 * Embeds rather than a join by hand — `vizserve_pms_tasks` has exactly one
 * foreign key to each of these, so neither is ambiguous. (The DTR's two keys to
 * `vizserve_pms_users` are the counter-example, and there the constraint has to
 * be named or PostgREST refuses the whole query.)
 */
const TASK_COLUMNS =
  "id, title, status, created_at, vizserve_pms_departments(name), vizserve_pms_lists(name)";

type TaskRow = {
  id: string;
  title: string;
  status: string;
  created_at: string;
  vizserve_pms_departments: { name: string } | null;
  vizserve_pms_lists: { name: string } | null;
};

function toLoggable(row: TaskRow): LoggableTask {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    // Left embeds, so either half can be absent: a task with no list, or one
    // whose department this person cannot read. Both drop out rather than
    // rendering "undefined /".
    where: [row.vizserve_pms_departments?.name, row.vizserve_pms_lists?.name]
      .filter(Boolean)
      .join(" / "),
    created_at: row.created_at,
  };
}

/**
 * What a failed read should SAY.
 *
 * ⚠️ `TypeError: fetch failed` ON ITS OWN IS USELESS, and this screen showed
 * exactly that. It is Node's generic wrapper; the actual reason — a refused
 * connection, DNS, a timeout, a request too large to send — travels on `cause`,
 * which supabase-js surfaces in `details`. Printing both is the difference
 * between "the network is broken" and something somebody can act on.
 */
function describe(error: { message?: string; details?: string; code?: string } | null): string {
  const parts = [error?.message, error?.details, error?.code ? `(${error.code})` : null]
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.trim());

  // De-duplicated: some transports copy the message into `details`, and the same
  // sentence printed twice reads as two separate faults.
  return [...new Set(parts)].join(" — ") || "Unknown error.";
}

export async function loadLoggableTasks(
  userId: string,
  filters: LoggableTaskFilters = {},
): Promise<{ tasks: LoggableTask[]; error: string | null }> {
  const supabase = await createClient();
  const limit = filters.limit ?? LOGGABLE_TASK_LIMIT;

  const term = filters.query?.trim();
  // Commas and parentheses terminate a PostgREST filter expression, so they are
  // stripped rather than escaped — nobody searches for one, and a search box
  // must not be able to rewrite the query around it.
  const safeTerm = term ? term.replace(/[,()]/g, " ") : null;
  const to = filters.to ? `${filters.to}T23:59:59.999Z` : null;

  /*
   * ⚠️ THE FILTERS ARE SPELLED OUT TWICE, ONCE PER HALF, and a shared helper
   * that took the builder and returned it is what was tried first. PostgREST's
   * builder types are chained generics — every `.eq()` returns a differently
   * parameterised type — so threading one through a generic function needs a
   * cast that throws away the column checking these queries are worth having.
   * Two readable copies beat one clever one that cannot tell `list_id` from a
   * typo.
   *
   * The column PREFIX differs anyway: on the join-table half every task column
   * is reached through the embed.
   */
  let direct = supabase
    .from("vizserve_pms_tasks")
    .select(TASK_COLUMNS)
    // Short and fixed-size. This half was never the problem.
    .or(`assignee_id.eq.${userId},qa_assignee_id.eq.${userId}`);

  if (safeTerm) direct = direct.ilike("title", `%${safeTerm}%`);
  if (filters.listId) direct = direct.eq("list_id", filters.listId);
  // The CREATED date, and `to` covers the whole day: `created_at` is a
  // timestamptz, so `lte('2026-09-04')` means midnight and would silently drop
  // everything made that day.
  if (filters.from) direct = direct.gte("created_at", filters.from);
  if (to) direct = direct.lte("created_at", to);

  /*
   * The extra assignees, reached THROUGH the join table so the request carries
   * one uuid instead of one per task.
   *
   * `!inner` is correct here and only here: a membership row whose task this
   * person cannot read is not a task they may log against, so dropping it is
   * the answer rather than a loss. It is also what lets the filters below apply
   * to the embedded table at all.
   */
  let joined = supabase
    .from("vizserve_pms_task_assignees")
    .select(`vizserve_pms_tasks!inner(${TASK_COLUMNS})`)
    .eq("user_id", userId);

  if (safeTerm) joined = joined.ilike("vizserve_pms_tasks.title", `%${safeTerm}%`);
  if (filters.listId) joined = joined.eq("vizserve_pms_tasks.list_id", filters.listId);
  if (filters.from) joined = joined.gte("vizserve_pms_tasks.created_at", filters.from);
  if (to) joined = joined.lte("vizserve_pms_tasks.created_at", to);

  /*
   * Both in parallel, each capped at `limit` on its own.
   *
   * Taking `limit` from each and then `limit` from the merge is not an
   * approximation: the newest N overall are necessarily a subset of the newest
   * N of one side unioned with the newest N of the other.
   */
  const [mine, added] = await Promise.all([
    direct.order("created_at", { ascending: false }).limit(limit),
    joined
      .order("created_at", { ascending: false, referencedTable: "vizserve_pms_tasks" })
      .limit(limit),
  ]);

  /*
   * ⚠️ ONE FAILURE IS NOT TOTAL FAILURE. If the join-table half falls over,
   * somebody who is the PIC on things can still log against them, and taking
   * the whole picker away would remove work that loaded perfectly well. It is
   * only an outright error when BOTH sides are gone.
   */
  /*
   * LOGGED WITH THE CAUSE ATTACHED, because the sentence that reaches the
   * screen cannot carry a stack and `TypeError: fetch failed` alone has sent
   * this bug down two wrong roads already. The dev server prints this; a
   * production one puts it in the Vercel log beside the request that failed.
   */
  if (mine.error || added.error) {
    console.error("[timesheet] loggable tasks", {
      userId,
      filters,
      direct: mine.error ?? null,
      joined: added.error ?? null,
    });
  }

  if (mine.error && added.error) return { tasks: [], error: describe(mine.error) };

  const rows: TaskRow[] = [
    ...((mine.data ?? []) as unknown as TaskRow[]),
    ...((added.data ?? []) as unknown as { vizserve_pms_tasks: TaskRow | null }[])
      .map((row) => row.vizserve_pms_tasks)
      .filter((row): row is TaskRow => row !== null),
  ];

  // Deduped: being the PIC AND carrying a join-table row is ordinary since
  // import_07, and it must not put the same task in the picker twice.
  const unique = new Map(rows.map((row) => [row.id, row]));

  const tasks = [...unique.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, limit)
    .map(toLoggable);

  // Partial, and said so — the picker still renders whatever did come back.
  const partial = mine.error ?? added.error;

  return { tasks, error: partial ? describe(partial) : null };
}

/**
 * The lists to offer in the picker's List filter.
 *
 * ⚠️ NOT "every list in your department" — only the ones you actually have work
 * in. A department's board can run to dozens of lists and a member is on a
 * handful; offering the rest is a filter whose options mostly return nothing,
 * which reads as a broken filter rather than an empty list.
 *
 * Same two-request shape and the same reason as above: no `id.in.(…)`, so no
 * URL that grows with how much work somebody has.
 *
 * No limit on either half, and that is the one place this differs: it selects a
 * single uuid per row, and taking it whole is what makes the option set
 * complete. Deriving it from the capped task list would offer only the lists
 * that happened to fall in the newest twenty.
 *
 * Degrades to whatever came back rather than throwing. This drives a FILTER;
 * failing it should cost you the filter, not the picker.
 */
export async function loadLoggableTaskLists(userId: string): Promise<string[]> {
  const supabase = await createClient();

  const [mine, added] = await Promise.all([
    supabase
      .from("vizserve_pms_tasks")
      .select("list_id")
      .not("list_id", "is", null)
      .or(`assignee_id.eq.${userId},qa_assignee_id.eq.${userId}`),

    supabase
      .from("vizserve_pms_task_assignees")
      .select("vizserve_pms_tasks!inner(list_id)")
      .eq("user_id", userId),
  ]);

  const ids = [
    ...((mine.data ?? []) as { list_id: string | null }[]).map((row) => row.list_id),
    ...((added.data ?? []) as unknown as { vizserve_pms_tasks: { list_id: string | null } | null }[])
      .map((row) => row.vizserve_pms_tasks?.list_id ?? null),
  ];

  return [...new Set(ids.filter((id): id is string => Boolean(id)))];
}
