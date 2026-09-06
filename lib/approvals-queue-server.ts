import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  canAccessDepartment,
  type AuthContext,
} from "@/lib/auth/authorization";
import { roleAtLeast } from "@/lib/auth/roles";
import type { Database } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";
import {
  INTERNAL_REQUEST_LABELS,
  describeLeaveSpan,
} from "@/lib/schemas/internal-requests";
import type { TimesheetWeekStatus } from "@/lib/schemas/timesheet";

/**
 * "Waiting on you" — the one definition of an approver's queue.
 *
 * THERE ARE THREE QUEUES, NOT ONE, and forgetting that is a bug this app has
 * already shipped twice. `/dashboard` counted `vizserve_pms_requests` alone and
 * had done since P0-08, when client Gate 1 was the only thing anybody approved.
 * It has not been the only one since P5 added internal requests (leave,
 * reimbursement, the two corrections, and now OVERTIME) or since P7-05 added
 * submitted timesheet weeks — so a lead with four leave requests and three
 * handed-in weeks and no client work read "Pending approvals: 0".
 *
 * A zero is not a soft failure on a landing page. It does not say "nothing has
 * loaded", it says THERE IS NOTHING TO DO, and people act on it by closing the
 * tab.
 *
 * It lives here rather than in a page because it was written inline twice and
 * the copies had already diverged. A rule that decides whether somebody sees
 * their work gets one home.
 *
 * NO DEPARTMENT FILTER on any of the three. All three tables scope by policy
 * through `vizserve_pms_manages_department`; restating it here would imply the
 * policy is optional.
 */
export type WaitingOnYou = {
  /** Client requests at Gate 1. */
  client: number;
  /** Leave, reimbursement, corrections, overtime — excluding the caller's own. */
  internal: number;
  /** Timesheet weeks handed in — excluding the caller's own. */
  weeks: number;
  total: number;
  /** `"2 client · 4 internal · 3 weeks"`, omitting the empty ones. */
  breakdown: string;
};

const EMPTY: WaitingOnYou = {
  client: 0,
  internal: 0,
  weeks: 0,
  total: 0,
  breakdown: "",
};

/**
 * P9-04 — IS THIS PARTICULAR REQUEST WAITING ON *ME*?
 *
 * Until the chain, `status = 'PENDING_REVIEW'` and RLS answered this between
 * them: everything you could see that was pending was yours to decide. That is
 * no longer true in either direction.
 *
 *   * A lead can SEE a stage-1 request — they lead the department — and must
 *     not act on it. The relievers have not answered yet.
 *   * A manager can see a stage-3 request through the P9-04 policy and IS the
 *     person it is waiting for, even when they lead no department at all.
 *   * A reliever is usually a plain `member`, so every `isApprover` gate in
 *     this file returns zero for them.
 *
 * One function, because /approvals, /, /dashboard and the request page itself
 * all ask it, and four copies of a four-way rule is four chances to show
 * somebody work they cannot do.
 *
 * ⚠️ THIS IS FOR DISPLAY. `vizserve_pms_decide_internal_request` and
 * `vizserve_pms_may_decide_internal_stage` are the authority; a mistake here
 * shows the wrong button, not the wrong permission.
 */
export function waitingOnMe(
  row: { id: string; approval_stage: number | null; department_id: string; requester_id: string },
  context: Pick<AuthContext, "userId" | "role" | "managedDepartmentIds">,
  /** The requests where I am a reliever who has not yet answered. */
  owedAsReliever: ReadonlySet<string>,
): boolean {
  // Nobody decides their own, at any stage, and the function refuses it too.
  if (row.requester_id === context.userId) return false;

  switch (row.approval_stage ?? 0) {
    // Mine only if my name is on it AND I have not answered. A reliever who has
    // already said yes is waiting on the others, not on themselves.
    case 1:
      return owedAsReliever.has(row.id);
    // Company-wide, and the one place in this app where approval authority is
    // not scoped to a managed department. Amier, 4 Sep.
    case 3:
      return roleAtLeast(context.role, "manager");
    // Stage 0 (every non-leave type) and stage 2 (the team leader) are the rule
    // that has always applied: a lead of the department the request was routed
    // to. `owner` passes through `canAccessDepartment` with no managed set.
    default:
      return (
        roleAtLeast(context.role, "team_leader") &&
        canAccessDepartment(context as AuthContext, row.department_id)
      );
  }
}

/**
 * P9-01 — the requests where I am a reliever who has not yet answered.
 *
 * ⚠️ THE ONE QUEUE THAT IS NOT GATED ON `isApprover`, and it must not become
 * one. A reliever is usually a plain `member`; every other read in this file
 * returns `EMPTY` for them by design, because a member approves nothing. Being
 * named on somebody's hand-over is the exception — it is the one thing in this
 * app that puts a decision in front of a person with no role at all.
 *
 * `decision is null` rather than every row bearing my name: a reliever who has
 * already accepted is waiting on their colleagues, not on themselves, and the
 * request would sit in their queue until the whole chain finished.
 *
 * A failure comes back as an empty set, which understates the queue rather than
 * inventing one. Swallowed here because the caller renders somebody else's
 * approvals list around it and a thrown read would take the whole page.
 */
export async function listOwedAsReliever(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Set<string>> {
  const { data } = await supabase
    .from("vizserve_pms_internal_request_relievers")
    .select("request_id")
    .eq("reliever_id", userId)
    .is("decision", null);

  return new Set((data ?? []).map((row) => row.request_id));
}

/**
 * The same read, ONCE per request.
 *
 * `countWaitingOnYou` and `listWaitingOnYou` both open with `listOwedAsReliever`
 * and `/dashboard` calls both, so the reliever query ran TWICE on every
 * dashboard render for an answer that cannot have changed between them. Same
 * treatment `fetchJoinedTaskIds` and `resolveAuth` get: `cache()`, per request.
 *
 * ⚠️ KEYED ON THE USER ID, NOT THE CLIENT, and that is the whole reason this is
 * a Map rather than `cache(listOwedAsReliever)`. `cache()` memoises on its
 * arguments, and the first argument would be a request-scoped SupabaseClient —
 * a caller that built its own instance misses the memo silently, and a
 * per-request client held in a cache key is a thing to keep out of a module
 * anyway. So the cache holds the Map and the client rides through unkeyed.
 *
 * Internal on purpose. Both callers below are Server Components handing in
 * their own RLS-scoped client, so there is no second client in a request for
 * the key to have had to tell apart — and `listOwedAsReliever` stays exported
 * unchanged for /approvals, which reads it once and needs no memo.
 *
 * Outside a React request — the unit tests — `cache()` is a pass-through, so a
 * fresh Map comes back per call and each test's fake client is read for itself.
 *
 * ⚠️ THE SET IS SHARED between the two callers now. Both only `.has()` and
 * `.size` it; nothing may mutate it.
 *
 * ⚠️ NEVER HAND THIS AN ADMIN CLIENT. The key is the user id and the client
 * rides through unkeyed, so within one request the FIRST call for a given id
 * wins and every later caller is handed that result. Two callers passing
 * differently-scoped clients for the same id — one RLS-scoped, one from
 * `utils/supabase/admin`, which bypasses RLS — would silently serve one
 * scope's answer to the other. No such caller exists today: every call site
 * passes the request's own `createClient()`. This comment is the only thing
 * enforcing that, which is why it is stated as a rule rather than an
 * observation.
 *
 * ⚠️ NAMED `owedFor`, NOT `owedAsReliever`. `waitingOnMe` above already has a
 * PARAMETER called `owedAsReliever`, and a module function of the same name is
 * shadowed inside it — correct today only because the parameter happens to be a
 * `ReadonlySet`. Rename that parameter away and `.has()` would silently resolve
 * to this function instead.
 */
const owedMemo = cache(() => new Map<string, Promise<Set<string>>>());

function owedFor(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Set<string>> {
  const memo = owedMemo();
  const hit = memo.get(userId);
  if (hit) return hit;

  const owed = listOwedAsReliever(supabase, userId);
  memo.set(userId, owed);
  return owed;
}

// ---------------------------------------------------------------------------
// The timesheet-week queue
// ---------------------------------------------------------------------------

/**
 * The status a week is in while it waits on a lead.
 *
 * RETURNED is back with the member and APPROVED is finished — the same
 * three-way split `vizserve_pms_timesheet_week_locked` reads, and the reason
 * RETURNED appears in none of these lists. Named once because three queries in
 * this file now filter on it.
 */
const WEEK_WAITING = "SUBMITTED" as const;

/**
 * Where a submitted week is DECIDED.
 *
 * ⚠️ NOT `/approvals/<id>`. `vizserve_pms_decide_timesheet_week` is reachable
 * from the team grid and only from there, deliberately: a queue of weeks with no
 * view of the hours inside them is a rubber stamp, which is the argument
 * `app/(app)/timesheet/team/page.tsx` opens with. A second route to the same
 * transition would be a second thing to keep in step with it.
 *
 * It lives here so every screen that lists a pending week points at the same
 * place — /, /dashboard and now /approvals.
 */
export function timesheetWeekHref(weekStart: string): string {
  return `/timesheet/team?week=${weekStart}`;
}

/**
 * A week handed in and waiting on somebody other than the person who handed it
 * in.
 *
 * Richer than `WaitingRow` on purpose: /approvals renders these as table rows
 * with the submitted total and the week's own status on them, and a flattened
 * "Week of 18 Aug" string cannot be widened back into columns.
 */
export type PendingWeek = {
  id: string;
  userId: string;
  /** Null when the users policy withheld the row. Callers pick their own fallback. */
  name: string | null;
  /** Monday, `YYYY-MM-DD`. */
  weekStart: string;
  /**
   * What the person ATTESTED TO — not what the grid shows now. The reviewer sees
   * live entries, and the two can differ; the team grid says so where they do.
   */
  submittedMinutes: number;
  submittedAt: string;
  /**
   * Always `SUBMITTED` given the filter, and carried anyway so callers render
   * the week's own vocabulary rather than borrowing the internal-request one.
   * ⚠️ A week is never `rejected` and a request is never `returned` (D23) — the
   * two label sets stay apart.
   */
  status: TimesheetWeekStatus;
  href: string;
};

/**
 * The rows behind the `weeks` count above.
 *
 * ⚠️ RETURNS ITS ERROR. Every other read on this page's callers does, because
 * `data ?? []` renders a failed query as an empty queue — and an empty APPROVALS
 * queue is the one people believe and act on. The counting half of this file can
 * afford to swallow a failure into a zero on a dashboard tile; a list somebody
 * works off cannot.
 *
 * NO DEPARTMENT FILTER. `vizserve_pms_timesheet_weeks` scopes by the department
 * snapshotted at submission, through the policy.
 */
export async function listPendingTimesheetWeeks(
  supabase: SupabaseClient<Database>,
  userId: string,
  isApprover: boolean,
  limit = 5,
): Promise<{ rows: PendingWeek[]; error: { message: string } | null }> {
  if (!isApprover) return { rows: [], error: null };

  const { data, error } = await supabase
    .from("vizserve_pms_timesheet_weeks")
    /*
     * ⚠️ THE CONSTRAINT IS NAMED, AND IT HAS TO BE. `vizserve_pms_timesheet_weeks`
     * has TWO foreign keys to `vizserve_pms_users` — `user_id` and
     * `reviewed_by` (p7_05:41, :66) — so an unqualified embed is ambiguous and
     * PostgREST refuses the WHOLE query with PGRST201. Measured against the live
     * project: unqualified → 300 PGRST201, hinted → 200.
     *
     * This exact shape shipped once before on `vizserve_pms_dtr_entries` and
     * read as "no entries in this range", because the page did `data ?? []` and
     * the empty state explained the failure away. `tests/db/phase5.test.ts`
     * pins that one. Here it would be worse: the dashboard head-count query has
     * no embed, so the tile would keep saying "3 waiting" while the list it
     * links to showed none.
     */
    .select(
      "id, user_id, week_start, submitted_minutes, submitted_at, status, " +
        "vizserve_pms_users!vizserve_pms_timesheet_weeks_user_id_fkey(full_name)",
    )
    .eq("status", WEEK_WAITING)
    // ⚠️ SELF-APPROVAL. A lead hands in a week like everybody else and
    // `vizserve_pms_decide_timesheet_week` refuses to let them decide it, so
    // listing it would put work in a queue that cannot be worked off. Mirrors
    // the `.neq` on the count above and the one on internal requests.
    .neq("user_id", userId)
    // Oldest first: the bottom of a newest-first queue is the part that has been
    // waiting longest, and nobody reaches it.
    .order("week_start", { ascending: true })
    .limit(limit);

  const rows = ((data ?? []) as unknown as Array<{
    id: string;
    user_id: string;
    week_start: string;
    submitted_minutes: number;
    submitted_at: string | null;
    status: TimesheetWeekStatus;
    vizserve_pms_users: { full_name: string } | null;
  }>).map((week) => ({
    id: week.id,
    userId: week.user_id,
    name: week.vizserve_pms_users?.full_name ?? null,
    weekStart: week.week_start,
    submittedMinutes: week.submitted_minutes,
    // The column is NOT NULL, and the fallback stays because a row that somehow
    // lacks one should still sort and render as of its own week rather than
    // crashing a queue.
    submittedAt: week.submitted_at ?? week.week_start,
    status: week.status,
    href: timesheetWeekHref(week.week_start),
  }));

  return { rows, error: error ?? null };
}

export async function countWaitingOnYou(
  supabase: SupabaseClient<Database>,
  context: Pick<AuthContext, "userId" | "role" | "managedDepartmentIds">,
  isApprover: boolean,
): Promise<WaitingOnYou> {
  const userId = context.userId;

  /*
   * ⚠️ P9-01 — THE EARLY RETURN MOVED, and this is the subtle part of the whole
   * change. It used to be the first line: "a member approves nothing".
   *
   * That stopped being true the day a member could be named as somebody's
   * reliever. A reliever with no role at all is owed a real decision, and an
   * `isApprover` gate in front of everything sent them a zero — which is not a
   * soft failure on a landing page. It says THERE IS NOTHING TO DO, and people
   * act on it by closing the tab.
   *
   * So the reliever queue is read for everybody, and the three approver queues
   * keep their gate below.
   */
  const owedPromise = owedFor(supabase, userId);

  if (!isApprover) {
    const owed = await owedPromise;
    if (owed.size === 0) return EMPTY;
    return {
      ...EMPTY,
      internal: owed.size,
      total: owed.size,
      breakdown: `${owed.size} to cover`,
    };
  }

  // ⚠️ IT IS IN THE BATCH, NOT IN FRONT OF IT. This used to be an `await` on its
  // own line and the three approver queues waited a whole round trip behind it —
  // for a set none of them filter on. `owed` is read by the early return above
  // and by `waitingOnMe` below, and by nothing in here, so it goes in the batch.
  const [owed, client, internal, weeks] = await Promise.all([
    owedPromise,

    supabase
      .from("vizserve_pms_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "PENDING_REVIEW"),

    // Excluding their own, mirroring the approvals list: a lead files leave
    // like everybody else, and `vizserve_pms_decide_internal_request` refuses a
    // self-decision. Counting it would put a number here that cannot be worked
    // off.
    //
    // ⚠️ P9-04 — NOT A HEAD COUNT ANY MORE, and that is the whole reason this
    // query grew columns. "Pending and not mine" used to mean "mine to decide",
    // and since the chain it means neither direction reliably: a lead sees
    // stage-1 requests they must not touch, and a manager is owed stage-3 ones
    // in departments they do not lead. The four-way rule is `waitingOnMe`, it
    // cannot be expressed as a PostgREST filter, and a count that overstates by
    // three is worse than no tile — somebody opens the queue and finds nothing
    // they can do.
    supabase
      .from("vizserve_pms_internal_requests")
      .select("id, approval_stage, department_id, requester_id")
      .eq("status", "PENDING_REVIEW")
      .neq("requester_id", userId),

    // The same pair `listPendingTimesheetWeeks` applies — `WEEK_WAITING` and not
    // your own. Written out rather than shared through that function because a
    // head count wants no columns and no embed back; the two filters are the
    // part that must not drift, and `tests/unit/approvals-queue.test.ts` pins
    // them saying the same thing.
    supabase
      .from("vizserve_pms_timesheet_weeks")
      .select("id", { count: "exact", head: true })
      .eq("status", WEEK_WAITING)
      .neq("user_id", userId),
  ]);

  const counts = {
    client: client.count ?? 0,
    // P9-04. Counted in TypeScript because the rule is a four-way switch on the
    // stage that no PostgREST filter expresses — see `waitingOnMe`.
    internal: (internal.data ?? []).filter((row) => waitingOnMe(row, context, owed)).length,
    weeks: weeks.count ?? 0,
  };

  return {
    ...counts,
    total: counts.client + counts.internal + counts.weeks,
    // Only the live ones. "2 client · 0 internal · 0 weeks" spends three
    // quarters of the line saying nothing.
    breakdown: (
      [
        [counts.client, "client"],
        [counts.internal, "internal"],
        [counts.weeks, "weeks"],
      ] as const
    )
      .filter(([count]) => count > 0)
      .map(([count, label]) => `${count} ${label}`)
      .join(" · "),
  };
}

/**
 * The same three queues as ROWS, not counts.
 *
 * A count tells a lead there are seven things without telling them what any of
 * them are, and the only way to find out is to open Approvals — which is the
 * click the tile was supposed to save. Both `/` and `/dashboard` need the rows,
 * and both had grown their own copy of this mapping: `/` built it inline across
 * three query results and forty lines, and slice I was about to write a second.
 * That is exactly the divergence the counting half of this file was extracted to
 * stop, so the listing half lives here too.
 *
 * ONE QUERY MORE THAN THE COUNTS NEED: the names. A row saying "a colleague
 * filed leave" is a row nobody can act on, and the requester id is a uuid. The
 * users select is policy-scoped like everything else.
 *
 * `since` is a DATE STRING, not a formatted phrase. Callers render it — `/` wants
 * "3 days ago" and the dashboard wants the same, but a module that returns prose
 * has decided the tense for every future caller.
 */
export type WaitingRow = {
  /** Unique across the three sources — the queue prefix is part of it. */
  id: string;
  /** Which queue, in the words that queue uses. Goes on the chip. */
  kind: string;
  tone: "info" | "warning" | "brand" | "neutral";
  title: string;
  /** Who is waiting. Always a name where one exists. */
  who: string;
  /** `YYYY-MM-DD` — when it started waiting. */
  since: string;
  href: string;
};

export async function listWaitingOnYou(
  supabase: SupabaseClient<Database>,
  context: Pick<AuthContext, "userId" | "role" | "managedDepartmentIds">,
  isApprover: boolean,
  /** Per queue, not in total. Five each is enough to fill any list that shows them. */
  perQueue = 5,
): Promise<WaitingRow[]> {
  const userId = context.userId;

  // P9-01. Read for everybody, before the approver gate — a reliever named on
  // somebody's hand-over is usually a plain member. See `listOwedAsReliever`.
  // Memoised, so the dashboard — which calls this AND `countWaitingOnYou` —
  // asks once rather than twice. See `owedFor`.
  const owedPromise = owedFor(supabase, userId);

  // Short-circuited on purpose: only a non-approver can trip this guard, so an
  // approver never waits on the reliever read before the batch starts.
  if (!isApprover && (await owedPromise).size === 0) return [];

  // ⚠️ IN THE BATCH, as in `countWaitingOnYou`. Nothing in the four queries
  // below filters on `owed`; it is spent on the guard above and on `waitingOnMe`
  // in the mapping, so blocking the batch on it bought a round trip and nothing.
  const [owed, client, internal, weeks, people] = await Promise.all([
    owedPromise,

    isApprover
      ? supabase
          .from("vizserve_pms_requests")
          .select("id, reference_no, title, requester_org, submitted_at")
          .eq("status", "PENDING_REVIEW")
          // Oldest first, everywhere. A queue read newest-first is a queue whose
          // bottom nobody reaches, and the bottom is the part that has been waiting.
          .order("submitted_at", { ascending: true })
          .limit(perQueue)
      : { data: null },

    /*
     * ⚠️ P9-04 — `approval_stage` and `department_id` are here for
     * `waitingOnMe`, and NO `.limit()` is applied any more.
     *
     * The rows this query returns are no longer the rows this person is owed:
     * a lead sees stage-1 requests the relievers still hold. Taking the first
     * five and THEN filtering would show three, or none, while five others sat
     * below the cut — a queue that silently shortens is the failure this file
     * was extracted to stop. The set is small (pending internal requests in
     * departments you lead), so filtering in full and slicing after is cheap.
     */
    supabase
      .from("vizserve_pms_internal_requests")
      // ⚠️ ONE STRING LITERAL, not a concatenation. PostgREST's generated types
      // parse this select at the type level, and a `+` makes it an opaque
      // `string` — every row comes back as `GenericStringError` and the whole
      // block stops typechecking.
      .select(
        "id, request_type, requester_id, department_id, approval_stage, created_at, start_date, end_date, work_date, start_half, end_half",
      )
      .eq("status", "PENDING_REVIEW")
      .neq("requester_id", userId)
      .order("created_at", { ascending: true }),

    // The SAME read /approvals now renders as rows. It was inline here until
    // that page needed the submitted total and the week's status, which a
    // `WaitingRow` has nowhere to put — and a second copy of "which weeks are
    // waiting on you" is exactly the divergence this file exists to stop.
    listPendingTimesheetWeeks(supabase, userId, isApprover, perQueue),

    supabase.from("vizserve_pms_users").select("id, full_name"),
  ]);

  const nameOf = new Map((people.data ?? []).map((row) => [row.id, row.full_name]));

  /**
   * A leave span, a one-day span, or a correction's single day.
   *
   * Formatted here, unlike `since`. The distinction is that this IS the row's
   * title — the only thing naming which request it is — whereas `since` is
   * relative prose whose tense belongs to the caller.
   */
  const when = (row: {
    start_date: string | null;
    end_date: string | null;
    work_date: string | null;
    start_half?: "MORNING" | "AFTERNOON" | null;
    end_half?: "MORNING" | "AFTERNOON" | null;
  }): string => {
    if (row.start_date && row.end_date) {
      // P7-16, through the shared description so a half day reads the same here
      // as it does on the request itself.
      return describeLeaveSpan(
        row.start_date,
        row.end_date,
        row.start_half ?? null,
        row.end_half ?? null,
        formatDate,
      );
    }
    return formatDate(row.work_date);
  };

  return [
    ...(client.data ?? []).map((request) => ({
      id: `req-${request.id}`,
      kind: "Client",
      tone: "brand" as const,
      // The reference number is the fallback rather than the label: a title is
      // what a lead recognises, and every request has a reference anyway.
      title: request.title || request.reference_no,
      who: request.requester_org || "Client request",
      since: request.submitted_at.slice(0, 10),
      href: `/requests/${request.id}`,
    })),

    // P9-04. Filtered to what is actually mine, THEN cut to `perQueue`. See the
    // note on the query — slicing first would hide work below the cut.
    ...(internal.data ?? [])
      .filter((request) => waitingOnMe(request, context, owed))
      .slice(0, perQueue)
      .map((request) => ({
        id: `int-${request.id}`,
        // A reliever is not approving a leave request, they are agreeing to
        // hold somebody's work — and "Leave" on the chip would send them to a
        // screen asking a question they did not expect.
        kind:
          request.approval_stage === 1
            ? "Cover"
            : (INTERNAL_REQUEST_LABELS[request.request_type] ?? "Request"),
        tone: "warning" as const,
        title: when(request),
        who: nameOf.get(request.requester_id) ?? "A colleague",
        since: request.created_at.slice(0, 10),
        href: `/approvals/${request.id}`,
      })),

    ...weeks.rows.map((week) => ({
      id: `wk-${week.id}`,
      kind: "Timesheet",
      tone: "neutral" as const,
      title: `Week of ${formatDate(week.weekStart)}`,
      // The embedded name, falling back to the shared map for a row whose embed
      // came back empty, and to prose only when neither knows.
      who: week.name ?? nameOf.get(week.userId) ?? "A colleague",
      since: week.submittedAt.slice(0, 10),
      // `/timesheet/team` anchored on the week in question, so the row lands on
      // the grid that shows it rather than on this week's.
      href: week.href,
    })),
  ];
}
