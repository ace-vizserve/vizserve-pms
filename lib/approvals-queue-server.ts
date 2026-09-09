import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AuthContext } from "@/lib/auth/authorization";
import type { Database } from "@/lib/database.types";
import { formatDate } from "@/lib/dates";
import {
  INTERNAL_REQUEST_LABELS,
  describeLeaveSpan,
} from "@/lib/schemas/internal-requests";

/**
 * ⚠️ P12-15 — FIVE THINGS MOVED OUT OF THIS FILE AND ARE RE-EXPORTED FROM IT.
 *
 * `waitingOnMe`, `timesheetWeekHref`, `PendingWeek`, `listPendingTimesheetWeeks`
 * and `listOwedAsReliever` now live in `lib/approvals-queue.ts`, byte for byte
 * — same bodies, same comments, same rules. Nothing about any queue changed.
 *
 * WHY: this module imports `lib/auth/authorization.ts`, which is `server-only`
 * by design, so importing ANY name from here drags `server-only` into whatever
 * bundle asks. Phase 4 moved `/approvals` and `/approvals/[id]` onto the query
 * cache, and a client component now has to ask `waitingOnMe` whether to draw a
 * decision panel. That import would have failed only in `npm run build` —
 * `tsc --noEmit`, eslint and vitest cannot see an RSC boundary violation, which
 * is how `new-task-button.tsx` shipped one to a browser in Phase 3b.
 *
 * THE RE-EXPORTS ARE NOT A TRANSITIONAL SHIM. `/` and `/dashboard` import
 * `listPendingTimesheetWeeks` and `timesheetWeekHref` from here alongside
 * `countWaitingOnYou` and `listWaitingOnYou`, which genuinely stayed — those two
 * take a full `AuthContext`. One import line for "the approvals queue" is right
 * for a Server Component; the split is only about what a BROWSER may hold.
 */
export {
  listOwedAsReliever,
  listPendingTimesheetWeeks,
  timesheetWeekHref,
  waitingOnMe,
  type PendingWeek,
} from "@/lib/approvals-queue";

import { listOwedAsReliever, listPendingTimesheetWeeks, waitingOnMe } from "@/lib/approvals-queue";

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
  /**
   * P12-01 — ⚠️ AT LEAST ONE OF THE QUEUES COULD NOT BE READ, so `total` is a
   * FLOOR rather than a fact and must not be rendered as a plain number.
   *
   * The header above already argues that a zero here is not a soft failure: it
   * does not say "nothing has loaded", it says THERE IS NOTHING TO DO, and
   * people act on it by closing the tab. Until this flag existed that argument
   * had no way of reaching the screen — `client.count ?? 0` folded a failed
   * head count into the same zero a quiet Tuesday produces.
   *
   * The caller decides what to draw. `StatTile` takes `value={null}` and shows
   * a dash with `count unavailable` beside it, which is the same three-state
   * rule `FolderCounts` in `components/app-shell/nav-projects.tsx` follows —
   * null is UNKNOWN, 0 is nothing to do, n is the number.
   *
   * ⚠️ IT COVERS THE THREE APPROVER QUEUES ONLY. The reliever read
   * (`listOwedAsReliever`) still degrades to an empty set by design — see the
   * note there — and logs. Widening this to cover it means giving that function
   * an error channel, and its other caller is `/approvals`.
   */
  unavailable: boolean;
};

const EMPTY: WaitingOnYou = {
  client: 0,
  internal: 0,
  weeks: 0,
  total: 0,
  breakdown: "",
  unavailable: false,
};



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

  /*
   * ⚠️ P12-01 — THE ERRORS ARE READ NOW, and the `?? 0` below survives only
   * because this flag rides beside it.
   *
   * The old code destructured nothing but `count` and `data`. A failed head
   * count arrives as `{ count: null, error }`, so `client.count ?? 0` produced
   * exactly the figure a quiet day produces and the tile said "Waiting on you:
   * 0" — the sentence this whole module's header is about, restored by the
   * fallback that was supposed to be a convenience.
   *
   * The counts are still summed rather than abandoned: two queues that DID come
   * back are a real floor, and the caller says the total is not vouched for
   * rather than pretending it has nothing to show.
   */
  const failure = client.error ?? internal.error ?? weeks.error ?? null;

  if (failure) {
    console.error(`[approvals-queue] a queue count failed — ${failure.message}`);
  }

  const counts = {
    client: client.count ?? 0,
    // P9-04. Counted in TypeScript because the rule is a four-way switch on the
    // stage that no PostgREST filter expresses — see `waitingOnMe`.
    internal: (internal.data ?? []).filter((row) => waitingOnMe(row, context, owed)).length,
    weeks: weeks.count ?? 0,
  };

  return {
    ...counts,
    unavailable: failure !== null,
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

/**
 * ⚠️ P12-01 — RETURNS ITS ERROR, exactly as `listPendingTimesheetWeeks` above
 * does and for the same reason spelled out there.
 *
 * This used to return a bare `WaitingRow[]`, built out of three reads whose
 * `error` nobody destructured. `/` renders it under "Nothing awaiting your
 * decision. Requests appear here the moment somebody files one." and
 * `/dashboard` renders it under a green tick — two of the most reassuring
 * sentences in the product, drawn over a queue nobody could read. A person
 * holding four leave requests and three handed-in weeks was told they were
 * clear, and there was nothing on screen or in the log to say otherwise.
 *
 * The rows that DID arrive are still returned beside the error. A partial queue
 * plus "some of this could not be loaded" is strictly more than either half.
 */
export async function listWaitingOnYou(
  supabase: SupabaseClient<Database>,
  context: Pick<AuthContext, "userId" | "role" | "managedDepartmentIds">,
  isApprover: boolean,
  /** Per queue, not in total. Five each is enough to fill any list that shows them. */
  perQueue = 5,
): Promise<{ rows: WaitingRow[]; error: { message: string } | null }> {
  const userId = context.userId;

  // P9-01. Read for everybody, before the approver gate — a reliever named on
  // somebody's hand-over is usually a plain member. See `listOwedAsReliever`.
  // Memoised, so the dashboard — which calls this AND `countWaitingOnYou` —
  // asks once rather than twice. See `owedFor`.
  const owedPromise = owedFor(supabase, userId);

  // Short-circuited on purpose: only a non-approver can trip this guard, so an
  // approver never waits on the reliever read before the batch starts.
  if (!isApprover && (await owedPromise).size === 0) return { rows: [], error: null };

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
      : // ⚠️ `error: null` RIDES ALONG, and it is not decoration. A
        // non-approver has no client queue to fail at reading, so the branch
        // that skips the query must report "nothing went wrong" rather than
        // leaving the property off — `client.error` is read below, and an
        // absent one would type as `undefined` and read as falsy by luck
        // rather than by statement.
        { data: null, error: null },

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

  /*
   * ⚠️ P12-01 — THE FOUR READS THAT DECIDE WHETHER A ROW EXISTS, and the one
   * that only decides what it is called.
   *
   * `client`, `internal` and `weeks` ARE the queue: a failure in any of them
   * removes rows, so it is reported. `people` is a name lookup — a failure
   * there costs "A colleague" instead of a name on a row that is still there,
   * still linked and still workable, so it is deliberately not part of the
   * error and does not turn a readable queue into "couldn't load".
   */
  const error = client.error ?? internal.error ?? weeks.error ?? null;

  if (error) {
    console.error(`[approvals-queue] a queue could not be listed — ${error.message}`);
  }

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

  const rows: WaitingRow[] = [
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

  return { rows, error };
}
