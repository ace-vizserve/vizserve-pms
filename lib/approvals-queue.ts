import type { SupabaseClient } from "@supabase/supabase-js";

import { canAccessDepartmentScope, roleAtLeast, type Role } from "@/lib/auth/roles";
import type { Database } from "@/lib/database.types";
import type { TimesheetWeekStatus } from "@/lib/schemas/timesheet";

/**
 * P12-15 — THE HALF OF THE APPROVALS QUEUE THE BROWSER IS ALLOWED TO HOLD.
 *
 * ------------------------------------------------------------------------
 * ⚠️ NOTHING HERE IS NEW. Every function below was in
 * `lib/approvals-queue-server.ts` and is UNCHANGED — same body, same comments,
 * same rules — and that file now re-exports them, so `/`, `/dashboard` and the
 * count that feeds the rail all keep the imports they had. This is a split, not
 * a rewrite, and the split is along exactly one line: what needs an
 * `AuthContext` and a server session, versus what only needs a Supabase client
 * and three plain fields.
 *
 * ⚠️ THE SPLIT EXISTS BECAUSE THE OTHER FILE IMPORTS `authorization.ts`, WHICH
 * IS `server-only`. Phase 4 moved `/approvals` and `/approvals/[id]` onto the
 * query cache, so the row that decides whether to draw a decision panel now
 * arrives in a client component — and `waitingOnMe` is the ONE definition of "is
 * this mine to decide" (the same one the dashboard tile counts from, which is
 * why the count that sends somebody here and the list they land on cannot
 * disagree). Importing it from the server file would have pulled `server-only`
 * into the browser bundle: a build failure that `tsc --noEmit`, eslint and
 * vitest are all blind to, and the exact break `new-task-button.tsx` shipped to
 * a browser with a green toolchain in Phase 3b.
 *
 * ⚠️ THE COUNTING HALF STAYED BEHIND, ON PURPOSE. `countWaitingOnYou` and
 * `listWaitingOnYou` take a full `AuthContext` and are read by two server
 * components; moving them would widen this file's surface for no caller. The
 * seam is deliberately the smallest one that lets a client component ask "is
 * this row mine".
 *
 * ⚠️ AND NONE OF IT IS ENFORCEMENT. `vizserve_pms_decide_internal_request` and
 * `vizserve_pms_may_decide_internal_stage` are the authority; a mistake here
 * shows the wrong button, never the wrong permission. Same sentence the original
 * carried, kept because it is what makes a client-side copy of this rule safe at
 * all.
 * ------------------------------------------------------------------------
 */

/**
 * Is this request waiting on ME?
 *
 * One function, because /approvals, /, /dashboard and the request page itself
 * all ask it, and four copies of a four-way rule is four chances to show
 * somebody work they cannot do.
 *
 * ⚠️ THIS IS FOR DISPLAY. `vizserve_pms_decide_internal_request` and
 * `vizserve_pms_may_decide_internal_stage` are the authority; a mistake here
 * shows the wrong button, not the wrong permission.
 *
 * ⚠️ THE SECOND ARGUMENT IS A SHAPE, NOT AN `AuthContext`. It always was — it
 * was declared `Pick<AuthContext, "userId" | "role" | "managedDepartmentIds">`
 * — and stating the three fields outright is what lets a client component pass
 * the viewer prop its page resolved on the server. The fields are the same
 * fields; nothing about who may decide has moved.
 */
export function waitingOnMe(
  row: { id: string; approval_stage: number | null; department_id: string; requester_id: string },
  viewer: { userId: string; role: Role | null; managedDepartmentIds: readonly string[] },
  /** The requests where I am a reliever who has not yet answered. */
  owedAsReliever: ReadonlySet<string>,
): boolean {
  // Nobody decides their own, at any stage, and the function refuses it too.
  if (row.requester_id === viewer.userId) return false;

  switch (row.approval_stage ?? 0) {
    // Mine only if my name is on it AND I have not answered. A reliever who has
    // already said yes is waiting on the others, not on themselves.
    case 1:
      return owedAsReliever.has(row.id);
    // Company-wide, and the one place in this app where approval authority is
    // not scoped to a managed department. Amier, 4 Sep.
    case 3:
      return roleAtLeast(viewer.role, "manager");
    // Stage 0 (every non-leave type) and stage 2 (the team leader) are the rule
    // that has always applied: a lead of the department the request was routed
    // to. `owner` passes through `canAccessDepartmentScope` with no managed set.
    default:
      return (
        roleAtLeast(viewer.role, "team_leader") &&
        canAccessDepartmentScope(viewer, row.department_id)
      );
  }
}

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
 * place — /, /dashboard and /approvals.
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

/** The status a week has to be in to be waiting on anybody. */
const WEEK_WAITING = "SUBMITTED" as const;

/**
 * The rows behind the `weeks` count on the dashboard.
 *
 * ⚠️ RETURNS ITS ERROR. Every other read on this page's callers does, because
 * `data ?? []` renders a failed query as an empty queue — and an empty APPROVALS
 * queue is the one people believe and act on. The counting half of the server
 * file can afford to swallow a failure into a zero on a dashboard tile; a list
 * somebody works off cannot.
 *
 * ⚠️ IT KEEPS THE `{ rows, error }` ENVELOPE RATHER THAN THROWING, even though
 * every OTHER read Phase 4 moved into the browser goes through `read()` and
 * throws. Two reasons, and both are about its OTHER callers: `/` and
 * `/dashboard` still call this from a Server Component with no error boundary
 * above them, where a throw is a blank landing page. The envelope is what those
 * two already handle, and `/approvals` unwraps it into a `QueryError` in the
 * space the queue would have occupied. Nothing here can render as an
 * indistinguishable zero either way, which is the property that matters.
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
    // the `.neq` on the count and the one on internal requests.
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

/**
 * P9-01 — the requests where I am a reliever who has not yet answered.
 *
 * ⚠️ THE ONE QUEUE THAT IS NOT GATED ON `isApprover`, and it must not become
 * one. A reliever is usually a plain `member`; every other read in the server
 * file returns `EMPTY` for them by design, because a member approves nothing.
 * Being named on somebody's hand-over is the exception — it is the one thing in
 * this app that puts a decision in front of a person with no role at all.
 *
 * `decision is null` rather than every row bearing my name: a reliever who has
 * already accepted is waiting on their colleagues, not on themselves, and the
 * request would sit in their queue until the whole chain finished.
 *
 * A failure comes back as an empty set, which understates the queue rather than
 * inventing one. Swallowed here because the caller renders somebody else's
 * approvals list around it and a thrown read would take the whole page.
 *
 * ⚠️ P12-01 — SWALLOWED, BUT NO LONGER SILENT. The empty set stays (there is no
 * error boundary above `/` or `/dashboard`, so a throw here is a blank page for
 * a decoration on somebody else's queue), and that is the whole reason it has to
 * be logged: an understated queue is a member being told they owe nobody cover,
 * which is the wrong zero the server file's header is about. Without the log
 * there was nothing anywhere — not on screen, not in the dev log — saying it had
 * happened.
 */
export async function listOwedAsReliever(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("vizserve_pms_internal_request_relievers")
    .select("request_id")
    .eq("reliever_id", userId)
    .is("decision", null);

  if (error) {
    console.error(
      `[approvals-queue] the cover queue for ${userId} could not be read — ${error.message}`,
    );
  }

  return new Set((data ?? []).map((row) => row.request_id));
}
