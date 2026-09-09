"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Link2, ListTree } from "lucide-react";
import Link from "next/link";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { QueryError } from "@/components/query-error";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { BoardColumnSkeleton } from "@/components/skeletons";
import {
  TaskCategoryBadge,
  TaskPriorityBadge,
  TaskStatusBadge,
  taskCategoryEdge,
  taskStatusSurface,
} from "@/components/status-badge";
import { roleAtLeast } from "@/lib/auth/roles";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { formatDate, isOverdue } from "@/lib/dates";
import { browserClient } from "@/lib/query/browser-client";
import { fetchDirectory, fetchVisibleLists } from "@/lib/query/fetchers/task";
import {
  FINISHED_PER_COLUMN,
  fetchPendingRequests,
  fetchTaskBoardView,
  type TaskBoardView,
  type TaskViewKind,
  type TaskViewScope,
} from "@/lib/query/fetchers/task-list";
import { qk } from "@/lib/query/keys";
import { isRichTextEmpty } from "@/lib/rich-text";
import { pendingRequestsApply } from "@/lib/schemas/approvals";
import type { DirectoryPerson } from "@/lib/schemas/task-list";
import {
  INITIAL_TASK_STATUS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskPriority,
  availableTransitions,
  isTerminal,
  taskCategory,
} from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { BoardComposer } from "../add-task";
import { SubtaskProgress, TaskRowActions } from "../inline";
import { TaskStatusSelect } from "../status-select";
import { PendingRequestColumn } from "../pending-requests";
import { TaskToolbar } from "../toolbar";
import type { Viewer } from "../tasks-table";
import { BoardCard, BoardColumn, BoardDnd, BoardTaskGroup } from "./board-dnd";
import { HoverPrefetchLink } from "@/components/ui/hover-prefetch-link";

/**
 * P3-04 / P12-07 — the board, reading from the cache.
 *
 * The list view is the requirement and this is the optional companion, so it is
 * built as a second READ of the same data rather than as a second system: same
 * RLS, same ordering, same rules about what may move where.
 *
 * THE BOARD OWNS ITS OWN SCROLLING. The page is pinned to the viewport (100svh
 * less the 56px app header) and clips; the column row scrolls sideways inside
 * it, and each column scrolls down inside itself. That is the whole reason for
 * the height arithmetic below — before it, a wide board dragged the DOCUMENT
 * sideways and took the sidebar, the breadcrumb and the theme toggle off-screen
 * with it. The board scrolls; the app around it does not.
 *
 * ------------------------------------------------------------------------
 * ⚠️ WHAT MOVED, AND WHAT DID NOT.
 *
 * This was a 1,051-line RSC: two card queries, a dependent subtask query and
 * every derivation below, behind ONE cache entry — the route's own render. The
 * reads are now four query keys (`lib/query/fetchers/task-list.ts` argues which
 * key owns which), so dragging a card refetches the cards rather than the route.
 *
 * ⚠️ AUTHENTICATION DID NOT MOVE AND MUST NOT. `requireAuthContext()` runs in
 * `page.tsx` beside this, and every role and department decision arrives here as
 * `viewer`, resolved on the server where `canAdminDepartment` lives. Nothing in
 * this file decides what anybody may see — `viewer` is PRESENTATION ONLY, and
 * every rule here is re-checked in `vizserve_pms_transition_task` and in both
 * tasks policies.
 *
 * ⚠️ AND ONE READ CHANGED SHAPE ON THE WAY: the P7-13 seat. It was
 * `fetchJoinedTaskIdSet(userId)` — every task this person is on, anywhere —
 * called on the server and asked per card. That module is `server-only`, so the
 * board now asks the question the LIST has always asked instead: the join rows
 * for the cards on screen. Same mirror of `v_is_pic`, one key, and it stays
 * correct after a write because it is invalidated with the cards.
 * ------------------------------------------------------------------------
 */

/*
 * How many finished cards a terminal column shows before it stops.
 *
 * Small on purpose. These columns answer "what just closed", not "everything we
 * have ever done" — that question belongs to the list view, which has filters,
 * sorting and pagination built for it.
 *
 * ⚠️ THE NUMBER ITSELF LIVES IN `lib/query/fetchers/task-list.ts` NOW and is
 * imported, because the query asks for `FINISHED_PER_COLUMN * 2 + 1` in order to
 * make truncation detectable without a second count. Two copies of it is a board
 * that claims a cap it does not apply.
 */

const FINISHED_COLUMNS = TASK_STATUSES.filter((status) => isTerminal(status));

/** `Amier Bautista` → `AB`. Two letters, because three is a monogram. */
function initials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export type BoardSearchParams = { view?: string; kind?: string; list?: string; done?: string };

/**
 * ⚠️ THE FRAME COSTS NO QUERY, WHICH IS WHY IT IS DRAWN FIRST.
 *
 * `BOARD_COLUMNS` is `TASK_STATUSES`, a compile-time constant — so the toolbar,
 * the drag hint, the sideways scroller and the fade all have everything they
 * need before a row is read. Only the per-column count and the cards themselves
 * depend on data, and they are the one region below that waits.
 */
export function BoardView({
  params,
  viewer,
  realtimeFilter,
}: {
  params: BoardSearchParams;
  /** Every role and department decision, made on the server. See `page.tsx`. */
  viewer: Viewer;
  /** `realtimeDepartmentFilter(context)`, computed with the rest of the seat. */
  realtimeFilter: string | null;
}) {
  /*
   * ONE LIST, and without this the sidebar and the board were two structures
   * that never met.
   *
   * The project tree links every list to `?list=<id>`, the list view honoured
   * it, and the board did not read the parameter at all — so a list had exactly
   * one shape available to it, and switching to the board silently widened the
   * page to every task in the department while the URL still claimed a list.
   *
   * Now that the Tasks nav group is gone (lib/navigation.ts) and a list is
   * reached only through the tree, this is what makes Board a VIEW of that list
   * rather than a different destination.
   */
  const listId = params.list ?? null;

  /*
   * The client/internal split, which the toolbar has been CARRYING here since it
   * was built and the board ignored.
   *
   * `VIEWS` in toolbar.tsx lists `kind` among the parameters that survive the
   * switch from list to board, so a filtered list produced a URL saying
   * `?kind=internal` on a board that showed everything — a control that claims a
   * filter it does not apply. Same one-column test as the list, and the same one
   * `taskCategory` uses.
   */
  const kind: TaskViewKind =
    params.kind === "internal" || params.kind === "client" ? params.kind : "all";

  /* Read once rather than twice below: the pending column and the card query
     both need the same answer to "which scope is this". */
  const scope: TaskViewScope =
    params.view === "mine" || params.view === "qa" ? params.view : "all";

  /*
   * ⚠️ `browserClient()` IS CALLED INSIDE EVERY `queryFn`, NEVER IN THIS BODY.
   * A `"use client"` component is still RENDERED ON THE SERVER for its initial
   * HTML, and `createBrowserClient` reaches for `document.cookie` — which is why
   * that helper is lazy. A `queryFn` only ever runs in the browser.
   */

  /*
   * ⚠️ `""` WHERE THERE IS NO LIST, AND IT IS A REAL KEY RATHER THAN A GAP.
   * `/tasks/board` with no `?list=` is legal — unlike `/tasks`, which redirects
   * — and it means "every list you can see". `normalize()` drops empty values
   * from the FILTER bag, not from the positional id, so the two cases stay
   * distinct entries and cannot serve each other's cards.
   */
  const boardQuery = useQuery({
    queryKey: qk.taskBoard(listId ?? "", { view: params.view, kind: params.kind, list: params.list }),
    queryFn: () =>
      fetchTaskBoardView(browserClient(), { listId, view: scope, kind, userId: viewer.userId }),
  });

  const peopleQuery = useQuery({
    queryKey: qk.ref("users"),
    queryFn: () => fetchDirectory(browserClient()),
  });

  /* The breadcrumb's only reader, and it shares the entry `/tasks` fills. */
  const listsQuery = useQuery({
    queryKey: qk.listsVisible(),
    queryFn: () => fetchVisibleLists(browserClient()),
  });

  /*
   * P7-26 — the requests that have not been decided yet, as the first column.
   *
   * The board has no status or priority filter to honour, so the only task-only
   * filter it can carry is none — `hasTaskOnlyFilter` stays false. The rule about
   * which filters a request can answer at all lives in `pendingRequestsApply`,
   * which is pure and unit-tested; `enabled` is how this page obeys it without
   * fetching and discarding.
   */
  const showsPending = pendingRequestsApply({ kind, scope });

  const pendingQuery = useQuery({
    queryKey: qk.pendingRequests({ list: params.list, kind: params.kind, view: params.view }),
    queryFn: () =>
      fetchPendingRequests(browserClient(), { listId, kind, scope }),
    enabled: showsPending,
  });

  const crumb = listId
    ? (listsQuery.data ?? []).find((list) => list.id === listId)?.name
    : undefined;

  return (
    <PageShell className="h-[calc(100svh-3.5rem)] min-h-0 gap-3 overflow-hidden">
      {/*
        P8-03 — the board is the screen this matters most on, because it is
        the one people leave open.

        Renders nothing, and patches nothing into the columns: the payload
        is thrown away unread, so a card can never appear here that the
        policy would have refused.

        ⚠️ P12-07 CLOSED THE REGRESSION P12-02 KNOWINGLY OPENED HERE. That
        change narrowed the ping from `router.refresh()` to invalidating
        `qk.tasks()` and `qk.snapshot()`, and recorded that NOTHING on this
        page observed the first of those — the board still read its columns
        in an RSC, so a colleague moving a card left this screen alone until
        somebody navigated. `qk.taskBoard` lives under `["tasks"]`, so the
        cards are observing it now and the board is live again on the screen
        people leave open. The refresh does not come back: restoring it would
        mean every notification anybody receives costs a full server render
        of the shell, which is the storm P12-02 exists to stop.
      */}
      <RealtimeTasks filter={realtimeFilter} />

      {/* No <h1> — the breadcrumb is the page label. Now that a board can be a
          view of ONE list, the crumb has to name it, or two lists' boards are
          the same page with different cards on it and nothing on screen says
          which one you opened. `BreadcrumbLabel` clears itself on unmount, so
          leaving the list takes the name with it.

          The sentence below stays because it is the rule for DRAGGING: internal
          work goes anywhere, client work follows its gates, and a column that
          cannot take the card dims rather than accepting it and springing back
          (P7-20).

          ⚠️ IT NO LONGER COSTS A QUERY AT ALL. This was one row by primary
          key, fetched by a server component behind its own Suspense boundary so
          it could not queue behind the cards. The name comes out of
          `qk.listsVisible()` now — the entry `/tasks`, its filter panel and the
          detail page's move picker already share — so opening a board from a
          list the reader has seen before names it with no round trip at all.

          Only when the id resolves, which is the same rule as before: that
          fetcher filters `is_active`, so a bookmarked `?list=` whose list has
          since been archived draws no label rather than a stale one. */}
      {crumb ? <BreadcrumbLabel value={crumb} /> : null}

      {/* Zero queries: the scope tabs and the drag rule are on screen before a
          single card has been read. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <TaskToolbar view="board" />
        <p className="min-w-0 text-xs text-muted-foreground">
          Drag a card by its handle, or use the status control. Internal work goes to any stage; client work follows its gates.
        </p>

      </div>

      {/*
        The sideways scroller. `min-w-0` is what stops a flex item sizing itself
        to its own content and widening the page instead of scrolling; the
        negative margin with matching padding keeps the focus ring on the first
        card from being shaved off by the scroll box's own edge.
      */}
      <BoardDnd>
      {/*
        ⚠️ THE FADE IS AN AFFORDANCE, NOT DECORATION.

        Six live columns at w-64 need roughly 1600px and a laptop with the
        sidebar open has about 1360px, so at least one stage is off the right
        edge on most screens. Reported as "the board doesn't show all stages" —
        which is what a horizontal scroller with no visible edge looks like.

        `relative` on the wrapper and a gradient pinned to the right, above the
        scroller and `pointer-events-none` so it cannot swallow a drag. It is
        drawn unconditionally rather than only when scrollable: knowing whether
        there is overflow needs a client component measuring on resize, and a
        16px wash over the last column's own padding costs nothing when there is
        nothing to scroll to.
      */}
      <div className="relative min-h-0 min-w-0 flex-1">
      {/*
        ⚠️ ABSOLUTE, AND THAT IS WHAT CAPS THE BOARD AT ONE SCREEN.

        It was `h-full` in normal flow, and the board ran past the bottom of the
        window — a stage with thirty cards made the whole page scroll instead of
        the column. `PageShell` above is capped and clipped, but a cap cannot
        hold against pressure from BELOW: the columns' intrinsic height climbed
        the flex chain to `(app)/layout.tsx`'s `<main>`, which has no `min-h-0`
        because every ordinary page needs to grow and scroll the document. So
        `main` grew, the provider grew with it, and the shell — being `flex-1` —
        grew to match the space it had just been given.

        Out of flow, the strip contributes nothing upward. `main` stays at one
        viewport, the shell's `calc(100svh - 3.5rem)` holds, and `inset-0` gives
        the columns a definite box to resolve `h-full` against and scroll inside.

        Do NOT put `min-h-0` on that `<main>` to fix this from the other end: it
        would cap every page in the app at a screen and clip the ones that are
        meant to scroll.
      */}
      <div className="absolute inset-0 -mx-1 overflow-x-auto overflow-y-hidden px-1 pb-1">
        <div className="flex h-full min-w-max items-stretch gap-3">
          {/* Before every stage, and deliberately not one of them: nothing in
              it has a status yet. It is not a `BoardColumn` either — that is a
              drop target, and approving needs a PIC, a QA reviewer and a list
              that a drag cannot express. Renders nothing for a member.

              ⚠️ ITS OWN BOUNDARY, WITH A `null` FALLBACK, and it is the one
              streaming region here that says nothing while it loads. It renders
              nothing at all on most loads — a member has no readable requests
              and a lead's queue is usually empty — so there is no width to
              reserve, and a polite "loading" that resolves to silence is worse
              than saying nothing. It also must not be held behind the card
              query: this column is the reason somebody opened the board on a
              morning when three requests are waiting. */}
          {showsPending && pendingQuery.isError ? (
            /* ⚠️ A COLUMN THAT SAYS IT IS BROKEN, NOT AN ABSENT ONE. The server
               version of this read returned `[]` on failure, so a fault rendered
               as "no requests waiting" — which on the one screen a lead opens to
               find them is the P12-01 lie in its most expensive place. The cards
               beside it are a different key and are unaffected. */
            <section
              role="alert"
              className="flex w-72 shrink-0 flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
              <p className="text-xs font-semibold">Awaiting approval could not be loaded</p>
              <p className="text-2xs text-muted-foreground">
                This is a fault — it does not mean there are none.{" "}
                {pendingQuery.error.message}
              </p>
            </section>
          ) : (
            <PendingRequestColumn requests={pendingQuery.data ?? []} />
          )}

          {/*
            THE CARDS, AND EVERYTHING THAT COSTS A QUERY.

            ONE PLACEHOLDER FOR THE WHOLE COLUMN STRIP rather than one per
            column: the count in each heading comes from the same rows the cards
            do, so a per-column one would be eight placeholders that all resolve
            on the same round trip — eight places for the layout to twitch
            instead of one.

            It is the shape `app/(app)/tasks/board/loading.tsx` already draws, so
            a navigation into the board and an in-page refresh of it look the
            same; and it is a FRAGMENT, so its columns sit beside the pending
            column in this flex row rather than inside a wrapper that would
            collapse the gaps.
          */}
          {/*
            ⚠️ `isPending` IS "NO DATA YET", NOT "FETCHING". A background refetch
            over cards we already have must NOT throw them away and redraw twenty
            grey rectangles, which is the flicker the whole cache exists to
            remove — and on this screen it would happen on every colleague's
            status change.

            ⚠️ AND THE DIRECTORY IS PART OF THE FIRST PAINT. Every monogram is
            resolved through `nameOf`, and a card with neither name resolved
            renders "Unassigned" — a STATEMENT ABOUT THE TASK rather than a gap.
            Drawing the board before the people are back would tell somebody a
            whole department's work has nobody on it for as long as that query
            takes. The two fire in parallel, so this waits on the slower of them
            rather than on both in turn.

            ⚠️ `role="status"` on an `sr-only` line, not `aria-hidden` on the
            lot. `loading.tsx` is announced by the ROUTER; a placeholder rendered
            inside a page is announced by nothing at all. The grey bars stay
            hidden — a screen reader enumerating twenty rectangles is not a
            loading message — and the label is what speaks. `sr-only` is
            absolutely positioned, so it takes no space in this flex row.
          */}
          {boardQuery.isError ? (
            /* ⚠️ `QueryError` RATHER THAN A THROW TO `app/(app)/error.tsx`, and
               it is the same call `/tasks` makes: the toolbar, the drag hint and
               the awaiting-approval column are all still usable, so a failed card
               read is a failure of the COLUMNS and not of the page. The detail
               page decides the opposite way for its task row and says so —
               without that row there is no page to render. Here there is. */
            <div className="min-w-0 flex-1">
              <QueryError what="the board" message={boardQuery.error.message} />
            </div>
          ) : boardQuery.isPending || peopleQuery.isPending ? (
            <>
              <span role="status" aria-busy="true" className="sr-only">
                Loading the board…
              </span>
              <BoardColumnSkeleton />
            </>
          ) : (
            <BoardColumns
              board={boardQuery.data}
              people={peopleQuery.data ?? []}
              peopleUnavailable={peopleQuery.isError}
              viewer={viewer}
            />
          )}
        </div>
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-background to-transparent"
      />
      </div>
      </BoardDnd>
    </PageShell>
  );
}

/**
 * Every column, its count and its cards.
 *
 * Split out of the view so the loading, failed and loaded branches are one
 * component's whole output. Every derivation below is the same lines in the same
 * order they were in when they lived in the RSC; what they lost is the queries
 * above them and the `?? []` around each one.
 */
function BoardColumns({
  board,
  people,
  peopleUnavailable,
  viewer,
}: {
  board: TaskBoardView;
  people: DirectoryPerson[];
  /** A failed directory read. The monograms go, the cards stay — see below. */
  peopleUnavailable: boolean;
  viewer: Viewer;
}) {
  /*
   * ⚠️ A COMPILE-TIME CONSTANT, which is why the frame above can be drawn
   * before this component has a single row: the columns and their headings are
   * known, and only the count and the cards are not.
   *
   * ⚠️ EVERY STAGE IS A COLUMN, COMPLETED AND COMPLETED (NO RESPONSE) INCLUDED.
   * The archive argument for omitting them was real and the omission was the
   * wrong answer to it — a board whose columns are not the status enum disagrees
   * with the list, the status dropdown and the state machine about what the
   * stages are. It is solved in HOW MUCH is fetched instead; see
   * `fetchTaskBoardView`.
   */
  const BOARD_COLUMNS = TASK_STATUSES;

  /*
   * P7-13 — who is on each card, from the join rows for the cards on screen.
   *
   * `seat()` below asks this per card, which is why it is a map of sets rather
   * than a list to scan. See `TaskBoardView.assignees` for why the board stopped
   * asking the server-only "every task this person is on" question.
   */
  const onTask = new Map<string, Set<string>>();
  for (const row of board.assignees) {
    const holders = onTask.get(row.task_id) ?? new Set<string>();
    holders.add(row.user_id);
    onTask.set(row.task_id, holders);
  }

  const nameOf = new Map(people.map((person) => [person.id, person.full_name]));

  /**
   * Subtasks are counted on their parent, not dealt as their own cards (P7-09).
   *
   * A board that lists a parent and its ten children as eleven equal cards is a
   * board that has stopped saying anything about how much work there is. The
   * count is derived from the SAME rows the board already fetched, so a subtask
   * the policy hides is a subtask this does not claim exists.
   */
  const subtaskCount = new Map<string, number>();
  for (const task of board.live) {
    if (!task.parent_task_id) continue;
    subtaskCount.set(task.parent_task_id, (subtaskCount.get(task.parent_task_id) ?? 0) + 1);
  }

  const topLevel = board.live.filter((task) => !task.parent_task_id);

  /*
   * P7-09. The subtasks the board can actually render, bucketed by parent.
   *
   * Only the ones in `tasks` — the board excludes the two terminal statuses, so
   * a FINISHED subtask is not here at all. That is the behaviour the list has
   * too: a subtask leaves its parent's nest when it is done. The COUNT on the
   * button still comes from `subtaskCount`, which is unfiltered, so a parent
   * reads "10 subtasks" and unfolds the seven that are still outstanding.
   */
  const childrenByParent = new Map<string, typeof topLevel>();
  for (const task of board.live) {
    if (!task.parent_task_id) continue;
    const bucket = childrenByParent.get(task.parent_task_id) ?? [];
    bucket.push(task);
    childrenByParent.set(task.parent_task_id, bucket);
  }

  /*
   * K5 — PROGRESS, and the board cannot derive it the way the list does.
   *
   * The board excludes the two terminal statuses by design (a column that
   * accumulates every finished ticket since launch is an archive nobody
   * scrolls), so a finished subtask is not in `tasks` at all — counting done
   * children from these rows would report 0/3 on a task whose three subtasks are
   * all complete. Hence a separate query, unfiltered by status.
   */
  const progress = new Map<string, { done: number; total: number }>();
  for (const child of board.children) {
    if (!child.parent_task_id) continue;
    const entry = progress.get(child.parent_task_id) ?? { done: 0, total: 0 };
    entry.total += 1;
    // Both terminal statuses count as done. They are deliberately distinct, but
    // "the work is finished" is true of each and that is all a bar asks.
    if (isTerminal(child.status)) entry.done += 1;
    progress.set(child.parent_task_id, entry);
  }

  /**
   * Which seat the reader is in, per task — for the status control on the card.
   *
   * Not an authorization decision: `vizserve_pms_transition_task` re-checks all
   * of it. It only decides which moves are worth offering.
   */
  /** Who the composer may assign to — P7-14's rule, same as the list's. */
  const assignableScope = new Set(
    [viewer.primaryDepartmentId, ...viewer.managedDepartmentIds].filter((id): id is string => Boolean(id)),
  );

  /* ⚠️ `is_active` IS TESTED HERE AND NOT IN THE QUERY. `qk.ref("users")` holds
     the WHOLE directory now — the people who leave are exactly the ones whose old
     comments still need a name — so every consumer that offers somebody a SEAT
     filters for itself. See `fetchDirectory`. */
  const assignable = people
    .filter(
      (person) =>
        person.is_active &&
        person.id !== viewer.userId &&
        person.primary_department_id !== null &&
        (roleAtLeast(viewer.role, "owner") ||
          assignableScope.has(person.primary_department_id)),
    )
    .map((person) => ({ id: person.id, full_name: person.full_name }));

  const isAdmin = roleAtLeast(viewer.role, "owner");
  function seat(task: {
    id: string;
    assignee_id: string | null;
    qa_assignee_id: string | null;
    department_id: string;
  }) {
    return {
      // Mirrors vizserve_pms_transition_task's v_is_pic: the column OR the
      // join table, read for the cards on screen rather than from the
      // server-only set of every task this person has ever been added to.
      // See `TaskBoardView.assignees`.
      isAssignee:
        task.assignee_id === viewer.userId || (onTask.get(task.id)?.has(viewer.userId) ?? false),
      isQa: task.qa_assignee_id === viewer.userId,
      leadsDepartment:
        roleAtLeast(viewer.role, "owner") ||
        viewer.managedDepartmentIds.includes(task.department_id),
      // P11-05. Mirrors `v_in_dept` — see `lib/schemas/tasks.ts`.
      inDepartment: viewer.primaryDepartmentId === task.department_id,
      isAdmin,
    };
  }


  /**
   * P7-19 — whether to offer the trash on this row.
   *
   * Mirrors `vizserve_pms_can_delete_task` exactly: internal work only, and only
   * for a lead of the department, A DEPARTMENT ADMIN OF IT (P8-01c), whoever
   * created it, or the owner of a personal task. The database is still the
   * authority — this only decides whether to ask, so nobody is offered a control
   * that can only answer no.
   */
  function canDelete(task: {
    request_id: string | null;
    department_id: string;
    created_by: string | null;
    is_personal: boolean;
    assignee_id: string | null;
  }) {
    if (task.request_id !== null) return false;
    // The lead test inline rather than through `seat()`, which also wants a
    // `qa_assignee_id` that has nothing to do with deleting.
    const leads =
      roleAtLeast(viewer.role, "owner") ||
      viewer.managedDepartmentIds.includes(task.department_id);
    return (
      leads ||
      // P8-01c. Beside the lead test, never folded into it: leading a department
      // carries approval authority and the tick carries none. `canAdminDepartment`
      // is `server-only`, so this is the same mirror-across-the-wire the lead test
      // above already is — the server resolved it with that function before
      // handing over `deptAdminOf`, exactly as `tasks-table.tsx` has always done.
      task.department_id === viewer.deptAdminOf ||
      task.created_by === viewer.userId ||
      (task.is_personal && task.assignee_id === viewer.userId)
    );
  }

  const byStatus = new Map<VizservePmsTaskStatus, typeof topLevel>(BOARD_COLUMNS.map((status) => [status, []]));
  for (const task of topLevel) byStatus.get(task.status)?.push(task);

  /*
   * The two finished columns, from their own bounded query.
   *
   * Subtasks are dropped here for the same reason they are above: a board that
   * deals a parent and its ten children as eleven equal cards has stopped
   * saying how much work there is.
   *
   * `truncated` is per column, and it is the reason the query asks for more
   * than it renders: a column that silently shows twelve of forty is a column
   * somebody counts off and then stops trusting.
   */
  const truncated = new Map<VizservePmsTaskStatus, boolean>();
  for (const status of FINISHED_COLUMNS) {
    const all = board.finished.filter(
      (task) => task.status === status && !task.parent_task_id,
    );
    truncated.set(status, all.length > FINISHED_PER_COLUMN);
    byStatus.set(status, all.slice(0, FINISHED_PER_COLUMN));
  }

  return (
    <>
      {/* ⚠️ A COLUMN-WIDTH SENTENCE, NOT A BOARD WITHOUT NAMES. A failed
          directory read leaves every monogram unresolved, and a card with
          neither name renders "Unassigned" — which is a claim about the task
          rather than about the read. The cards are a different key and are
          fine, so this says what is missing and lets them draw. */}
      {peopleUnavailable ? (
        <section
          role="alert"
          className="flex w-64 shrink-0 flex-col gap-1 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
          <p className="text-xs font-semibold">Names could not be loaded</p>
          <p className="text-2xs text-muted-foreground">
            Cards below show &ldquo;Unassigned&rdquo; where a name should be. Nobody has been
            unassigned — this is a fault.
          </p>
        </section>
      ) : null}

      {BOARD_COLUMNS.map((status) => {
        const column = byStatus.get(status) ?? [];

        return (
          <BoardColumn
            key={status}
            status={status}
            // The LABEL, never the enum — a screen reader announcing
            // "FOR_CLIENT_APPROVAL column" is reading a database value out
            // loud (§6).
            aria-label={`${TASK_STATUS_LABELS[status]} column`}
            className={cn(
              // FLAT, per the elevation rule: a column is a place, not a
              // control. Its fill and hairline tell it apart, and the cards
              // inside are the only things carrying a lift.
              "flex h-full w-64 shrink-0 flex-col rounded-lg border",
              // The wash is the status' own tone, thinned so a white card
              // still reads as raised on it. It comes from status-badge.tsx
              // because that file is the only place a status is allowed to
              // become a colour.
              taskStatusSurface(status),
            )}>
            {/*
              The status chip IS the column heading — same component, same
              tone map as every other status in the app, so a column and a
              card badge cannot drift into disagreeing about what colour
              "For QA" is. It takes the stage glyph rather than the dot and
              sets in caps, because a heading and an inline note should not
              read as the same object.
            */}
            <div className="flex shrink-0 items-center gap-2 border-b px-2.5 py-2.5">
              <TaskStatusBadge status={status} icon className="uppercase tracking-[0.03em]" />
              <span className="font-mono text-2xs font-semibold tabular-nums text-muted-foreground">
                {column.length}
              </span>
            </div>

            {/*
              Each column scrolls on its own. `min-h-0` is the flex escape
              hatch again: without it the list refuses to shrink below its
              content and the overflow never engages.
            */}
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
              {column.length === 0 ? (
                <p className="px-1 py-6 text-center text-xs text-muted-foreground">
                  {status === INITIAL_TASK_STATUS
                    ? "Nothing waiting to be picked up."
                    : isTerminal(status)
                      ? // A finished column is empty because nothing has
                        // finished, not because work has not reached it —
                        // "work reaches this stage from the one before" is
                        // true of the pipeline and false of an archive.
                        "Nothing finished this way yet."
                      : "Nothing here yet. Work reaches this stage from the one before it."}
                </p>
              ) : (
                column.map((task) => {
                  const late = isOverdue(task.due_date);
                  const subtasks = subtaskCount.get(task.id) ?? 0;
                  const bars = progress.get(task.id);
                  const pic = task.assignee_id ? nameOf.get(task.assignee_id) : null;
                  const qa = task.qa_assignee_id ? nameOf.get(task.qa_assignee_id) : null;

                  return (
                    /*
                      A DIV, not a Link, and the title carries the href.

                      K3 put a status control, a rename and a subtask add on
                      this card, and an interactive control inside an anchor
                      is invalid HTML that swallows its own clicks: the
                      anchor wins and the popover never opens. So the
                      whole-card link is gone and the title is the
                      affordance.
                    */
                    <BoardTaskGroup
                      key={task.id}
                      count={subtasks}
                      label={task.title}
                      parent={
                    <BoardCard
                      taskId={task.id}
                      title={task.title}
                      status={task.status}
                      // P7-20. The SAME function the status dropdown uses,
                      // which mirrors `vizserve_pms_transition_task`. The
                      // board does not get an opinion of its own about what
                      // is legal — that would be a fourth copy of the rules.
                      allowed={availableTransitions(task.status, seat(task), task).map(
                        (transition) => transition.to,
                      )}
                      className={cn(
                        "group/task flex flex-col gap-2.5 rounded-md border bg-card grade-surface p-2.5 pl-5 shadow-raised transition-all hover:border-primary/50 hover:shadow-raised-lg",
                        // P7-27. Client work carries an accented edge, so a
                        // column of cards says which ones have somebody
                        // outside waiting without anybody reading a word.
                        taskCategoryEdge(taskCategory(task)),
                      )}>
                      <div className="flex items-start gap-1.5">
                        {/* See the note in tasks-table: a board column is the
                            same problem, one card at a time. */}
                        <HoverPrefetchLink
                          href={`/tasks/${task.id}`}
                          className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug font-medium hover:underline">
                          {task.title}
                        </HoverPrefetchLink>

                        <TaskRowActions
                          taskId={task.id}
                          title={task.title}
                          priority={task.priority as TaskPriority | null}
                          assignable={assignable}
                          deletable={canDelete(task)}>
                          {/* The glyph, not the chip: this card sits IN the
                              column whose heading is its status. */}
                          <TaskStatusSelect
                            taskId={task.id}
                            status={task.status}
                            viewer={seat(task)}
                            task={task}
                            resolutionMissing={isRichTextEmpty(task.resolution)}
                            variant="compact"
                            align="end"
                          />
                        </TaskRowActions>
                      </div>

                      <span className="flex flex-wrap items-center gap-1.5">
                        {/* P7-27 — WHICH KIND OF WORK THIS IS, which the
                            board did not say at all. The list has said it
                            since P7-01 and the board never did, so the same
                            card meant two different things depending on
                            which view you opened it from. Client work is the
                            only category that takes an accent. */}
                        <TaskCategoryBadge
                          category={taskCategory(task)}
                          className="h-5 px-1.5"
                        />
                        {/* Renders nothing when unranked, which is most
                            tasks: a mark carried by everything marks
                            nothing. Read-only here, because the hover
                            strip's flag is where it changes and one field
                            does not get two controls on one card. */}
                        <TaskPriorityBadge priority={task.priority as TaskPriority | null} className="h-5 px-1.5" />

                        {/* PIC and QA, in that order. The second assignee is
                            the thing this product turns on, so a board that
                            showed only the PIC would be hiding half of who
                            is on the hook. */}
                        {pic ? <Avatar name={pic} title={`PIC ${pic}`} /> : null}
                        {qa ? <Avatar name={qa} title={`QA ${qa}`} tone="qa" /> : null}
                        {!pic && !qa ? <span className="text-2xs text-muted-foreground">Unassigned</span> : null}

                        {task.due_date ? (
                          <span
                            className={cn(
                              // A bordered chip rather than loose text, so
                              // the date reads as one object beside the
                              // avatars instead of a second line of prose.
                              "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-2xs tabular-nums",
                              late
                                ? "border-destructive-border bg-destructive-subtle font-semibold text-destructive"
                                : "border-border bg-muted text-muted-foreground",
                            )}>
                            <CalendarDays className="size-3.5 shrink-0" aria-hidden />
                            {task.start_date
                              ? `${formatDate(task.start_date)} – ${formatDate(task.due_date)}`
                              : formatDate(task.due_date)}
                            {/* Never colour alone. */}
                            {late ? " · overdue" : null}
                          </span>
                        ) : null}

                        {task.output_link ? (
                          <Link2 className="size-3.5 text-foreground-faint" aria-label="Has an output link" />
                        ) : null}
                      </span>

                      {/* Its own line under a rule, as on the reference
                          board: a subtask count is about the task's shape,
                          not about who or when. */}
                      {/*
                        THE COUNT AND THE RATIO COME FROM DIFFERENT QUERIES,
                        deliberately. `subtasks` counts the children still
                        live on this board; `bars` counts every child,
                        including the finished ones the board excludes by
                        design. The ratio needs the second, so it is
                        preferred — the count is the fallback for a parent
                        whose children the policy did not return.
                      */}
                      {bars ? (
                        <span className="inline-flex items-center gap-1.5 border-t pt-2 text-2xs text-muted-foreground">
                          <ListTree className="size-3.5 shrink-0" aria-hidden />
                          <SubtaskProgress done={bars.done} total={bars.total} />
                        </span>
                      ) : subtasks > 0 ? (
                        <span className="inline-flex items-center gap-1.5 border-t pt-2 text-2xs text-muted-foreground">
                          <ListTree className="size-3.5 shrink-0" aria-hidden />
                          {subtasks} {subtasks === 1 ? "subtask" : "subtasks"}
                        </span>
                      ) : null}
                    </BoardCard>
                      }>
                      {(childrenByParent.get(task.id) ?? []).map((child) => {
                        const childPic = child.assignee_id ? nameOf.get(child.assignee_id) : null;
                        const childLate = isOverdue(child.due_date);

                        return (
                          /*
                            A SUBTASK CARD, and deliberately not a `BoardCard`.
                            No drag handle: its stage follows the work it
                            belongs to, and dragging one into another column
                            is the exact move the nesting exists to prevent.
                            It keeps its status control, because finishing one
                            is a real thing to do — and finishing it is what
                            takes it out of here.

                            ⚠️ IT USED TO BE A TITLE AND A GLYPH, which made a
                            subtask read as a label rather than as work. It is
                            a task: it has an owner, a date and a priority
                            exactly as its parent does, and the one view that
                            folds it under its parent was the only one showing
                            none of them.

                            The second line is the parent's, minus the two
                            things a child cannot say differently. No category
                            badge — a subtask carries no `request_id` of its
                            own, so it would read "Internal" directly beneath
                            a parent marked "Client". No QA avatar — this is
                            always internal work, which needs no reviewer
                            (P7-13a).
                          */
                          <div
                            key={child.id}
                            className="group/task flex flex-col gap-1.5 rounded-md border bg-card px-2 py-1.5 shadow-raised">
                            <div className="flex items-start gap-1.5">
                              <HoverPrefetchLink
                                href={`/tasks/${child.id}`}
                                className="line-clamp-2 min-w-0 flex-1 text-2xs leading-snug hover:underline">
                                {child.title}
                              </HoverPrefetchLink>

                              {/* The same hover strip the parent carries, so
                                  a subtask can be renamed, re-flagged and
                                  deleted where it lives. Without it the only
                                  way to rename one was to open it. */}
                              <TaskRowActions
                                taskId={child.id}
                                title={child.title}
                                priority={child.priority as TaskPriority | null}
                                assignable={assignable}
                                deletable={canDelete(child)}>
                                <TaskStatusSelect
                                  taskId={child.id}
                                  status={child.status}
                                  viewer={seat(child)}
                                  task={child}
                                  resolutionMissing={isRichTextEmpty(child.resolution)}
                                  variant="compact"
                                  align="end"
                                />
                              </TaskRowActions>
                            </div>

                            {/* Drawn only when there is something to say. A
                                subtask with no owner, date or priority keeps
                                the single line it had. */}
                            {childPic || child.due_date || child.priority ? (
                              <span className="flex flex-wrap items-center gap-1.5">
                                <TaskPriorityBadge
                                  priority={child.priority as TaskPriority | null}
                                  className="h-4.5 px-1"
                                />
                                {childPic ? <Avatar name={childPic} title={`PIC ${childPic}`} /> : null}
                                {child.due_date ? (
                                  <span
                                    className={cn(
                                      "inline-flex items-center gap-1 rounded-sm border px-1 py-0.5 text-2xs tabular-nums",
                                      childLate
                                        ? "border-destructive-border bg-destructive-subtle font-semibold text-destructive"
                                        : "border-border bg-muted text-muted-foreground",
                                    )}>
                                    <CalendarDays className="size-3 shrink-0" aria-hidden />
                                    {child.start_date
                                      ? `${formatDate(child.start_date)} – ${formatDate(child.due_date)}`
                                      : formatDate(child.due_date)}
                                    {/* Never colour alone. */}
                                    {childLate ? " · overdue" : null}
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                          </div>
                        );
                      })}
                    </BoardTaskGroup>
                  );
                })
              )}
            </div>

            {/*
              ⚠️ THE CAP, STATED. A finished column shows the most recent
              `FINISHED_PER_COLUMN` and no more — and a column that quietly
              shows twelve of forty is a column somebody counts off once and
              then stops trusting. The list view is where the rest lives,
              because it has the filters and the sorting for it.
            */}
            {truncated.get(status) ? (
              <Link
                href={`/tasks?status=${status}`}
                className="block border-t px-2.5 py-2 text-center text-2xs text-muted-foreground hover:text-foreground"
              >
                Showing the {FINISHED_PER_COLUMN} most recent — see all in the list
              </Link>
            ) : null}

            {/* Renders nothing at all for a member — creating work for other
                people is a Team Leader decision, and the button settles that
                for itself rather than the board guessing at the role. */}
            {/*
              EVERY column but one, reversed from first-only on 19 Aug — this
              is the board's half of the same change. A card dragged between
              columns is still not a thing (see the note at the top of this
              file), but typing a task straight into the column it belongs in
              is, and for internal work the move it implies is always legal.

              `FOR_CLIENT_APPROVAL` is dropped: a task with no client that
              landed there could never be finished or moved back.

              ⚠️ THE TWO TERMINAL COLUMNS ARE DROPPED TOO, and that note used
              to read "they are not drawn on this board at all". They are
              now. Typing a new task straight into Completed would be
              creating work that is already over — the composer creates at
              the status of its column, and there is no honest reading of
              that one.
            */}
            {status === "FOR_CLIENT_APPROVAL" || isTerminal(status) ? null : (
              <>
                <BoardComposer status={status} assignable={assignable} />
              </>
            )}
          </BoardColumn>
        );
      })}
    </>
  );
}

/**
 * A monogram tile, not a photo. There are no avatars in this system and
 * inventing a placeholder face for a colleague is worse than two letters.
 *
 * Round, because an avatar is one of the two things `--radius-pill` still
 * exists for. `title` carries the whole name and the role, because the initials
 * alone are ambiguous the moment two people share them.
 */
function Avatar({ name, title, tone = "pic" }: { name: string; title: string; tone?: "pic" | "qa" }) {
  return (
    <span
      title={title}
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold grade-chip shadow-raised",
        tone === "qa"
          ? "border-info-border bg-info-subtle text-info"
          : "border-accent-border bg-accent text-accent-foreground",
      )}>
      {initials(name)}
      <span className="sr-only">{title}</span>
    </span>
  );
}
