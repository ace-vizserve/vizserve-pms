import type { Metadata } from "next";
import { Suspense } from "react";

import { BreadcrumbLabel } from "@/components/app-shell/dynamic-breadcrumb";
import { PageShell } from "@/components/page-shell";
import { RealtimeTasks } from "@/components/realtime-refresh";
import { BoardColumnSkeleton } from "@/components/skeletons";
import { realtimeDepartmentFilter, requireAuthContext, type AuthContext } from "@/lib/auth/authorization";
import { loadPendingRequests } from "@/lib/pending-requests-server";
import { requestToday } from "@/lib/dates-server";
import { createClient } from "@/utils/supabase/server";

import { PendingRequestColumn } from "../pending-requests";
import { TaskToolbar } from "../toolbar";
import { BoardColumns } from "./board-columns";
import { BoardDnd } from "./board-dnd";

export const metadata: Metadata = { title: "Board" };

/**
 * P3-04 — the board.
 *
 * The list view is the requirement and this is the optional companion, so it is
 * built as a second READ of the same data rather than as a second system: same
 * RLS, same ordering.
 *
 * ⚠️ THIS PARAGRAPH USED TO SAY "DRAGGING IS DELIBERATELY ABSENT", on the
 * grounds that half of these transitions need a comment or a resolution first
 * and a drag would either pop a modal or fail silently against the state
 * machine. P7-20 answered it — a card is handed the moves `availableTransitions`
 * says it may make, a column that cannot take it dims and refuses the drop, and
 * a move that needs words opens the same dialog the menu opens. P12-18 then made
 * the WHOLE CARD the drag surface rather than a grip in its corner, which is the
 * first thing anybody tries. See `board-dnd.tsx` for how that survives a card
 * covered in controls.
 *
 * THE TWO TERMINAL COLUMNS ARE OMITTED, and that is not an oversight. The board
 * shows live work; a column that accumulates every finished ticket since launch
 * stops being a board and becomes an archive nobody scrolls. Finished work is a
 * filter on the list view, which is the right shape for it.
 *
 * THE BOARD OWNS ITS OWN SCROLLING. The page is pinned to the viewport (100svh
 * less the 56px app header) and clips; the column row scrolls sideways inside
 * it, and each column scrolls down inside itself. That is the whole reason for
 * the height arithmetic below — before it, a wide board dragged the DOCUMENT
 * sideways and took the sidebar, the breadcrumb and the theme toggle off-screen
 * with it. The board scrolls; the app around it does not.
 */

type BoardSearchParams = {
  view?: string;
  kind?: string;
  list?: string;
  done?: string;
};

type Scope = "all" | "mine" | "qa";
type Kind = "all" | "internal" | "client";

/**
 * ⚠️ THIS FUNCTION AWAITS NOTHING THAT COSTS A ROUND TRIP.
 *
 * The board's frame is entirely static — `BOARD_COLUMNS` is `TASK_STATUSES`, a
 * compile-time constant — so the toolbar, the drag hint, the sideways scroller
 * and the fade all have everything they need before a query is issued. Only the
 * per-column count and the cards themselves depend on data, and they sit behind
 * the one boundary below.
 *
 * The reads are fired here, before the JSX is returned, so they are in flight
 * while the browser paints the chrome. The boundaries decide who WAITS on them,
 * not when they start.
 */
export default async function TaskBoardPage({ searchParams }: { searchParams: Promise<BoardSearchParams> }) {
  const context = await requireAuthContext();
  const params = await searchParams;

  /*
   * ONE LIST, and without this the sidebar and the board were two structures
   * that never met.
   *
   * The project tree links every list to `?list=<id>`, the list view honoured
   * it, and the board did not read the parameter at all — so a list had exactly
   * one shape available to it, and switching to the board silently widened the
   * page to every task in the department while the URL still claimed a list.
   * That is the same "a control that claims a filter it does not apply" trap the
   * `kind` note below records, one parameter along.
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
   * filter it does not apply, which is trap 4's shape in the UI rather than in
   * SQL. Same one-column test as the list, and the same one `taskCategory` uses.
   */
  const kind: Kind = params.kind === "internal" || params.kind === "client" ? params.kind : "all";

  /* Read here rather than twice below: the pending column and the card query
     both need the same answer to "which scope is this". */
  const scope: Scope = params.view === "mine" || params.view === "qa" ? params.view : "all";

  return (
    <PageShell className="h-[calc(100svh-3.5rem)] min-h-0 gap-3 overflow-hidden">
      {/*
        P8-03 — the board is the screen this matters most on, because it is
        the one people leave open. A colleague moving a card, or a Gate 1
        approval creating a task, now redraws it within a moment instead of
        on the next navigation.

        Renders nothing, and patches nothing into the columns: the ping
        triggers `router.refresh()` and the whole board is re-queried under
        RLS. That is why a card can never appear here that the policy would
        have refused — the payload is thrown away unread.
      */}
      <RealtimeTasks filter={realtimeDepartmentFilter(context)} />


      {/* No <h1> — the breadcrumb is the page label. Now that a board can be a
          view of ONE list, the crumb has to name it, or two lists' boards are
          the same page with different cards on it and nothing on screen says
          which one you opened. `BreadcrumbLabel` clears itself on unmount, so
          leaving the list takes the name with it.

          The sentence below stays because it is the rule for DRAGGING: internal
          work goes anywhere, client work follows its gates, and a column that
          cannot take the card dims rather than accepting it and springing back
          (P7-20).

          Its own boundary, with NO fallback and no announcement: it renders
          null and only sets a context value, so there is nothing to hold a
          place for — and one row by primary key must not queue behind the
          board's own reads the way it did when it shared their batch. */}
      {listId ? (
        <Suspense fallback={null}>
          <BoardCrumb listId={listId} />
        </Suspense>
      ) : null}

      {/* Zero queries: the scope tabs and the drag rule are on screen before a
          single card has been read. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <TaskToolbar view="board" />
        <p className="min-w-0 text-xs text-muted-foreground">
          Drag a card by its handle, or use the status control. Internal work goes to any stage; client work follows its
          gates.
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
              <Suspense fallback={null}>
                <PendingColumn listId={listId} kind={kind} scope={scope} />
              </Suspense>

              {/*
            THE CARDS, AND EVERYTHING THAT COSTS A QUERY.

            One boundary around the whole column strip rather than one per
            column: the count in each heading comes from the same rows the cards
            do, so a per-column boundary would be eight fallbacks that all
            resolve on the same round trip — eight places for the layout to
            twitch instead of one.

            The fallback is the shape `app/(app)/tasks/board/loading.tsx`
            already draws, so a navigation into the board and an in-page refresh
            of it look the same; and it is a FRAGMENT, so its columns sit beside
            the pending column in this flex row rather than inside a wrapper
            that would collapse the gaps.

            ⚠️ `role="status"` on an `sr-only` line, not `aria-hidden` on the
            lot. `loading.tsx` is announced by the ROUTER; a Suspense fallback
            inside a page is announced by nothing at all. The grey bars stay
            hidden — a screen reader enumerating twenty rectangles is not a
            loading message — and the label is what speaks. `sr-only` is
            absolutely positioned, so it takes no space in this flex row.
          */}
              <Suspense
                fallback={
                  <>
                    <span role="status" aria-busy="true" className="sr-only">
                      Loading the board…
                    </span>
                    <BoardColumnSkeleton />
                  </>
                }>
                <BoardColumnsToday context={context} listId={listId} kind={kind} scope={scope} />
              </Suspense>
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
 * The open list's name for the breadcrumb.
 *
 * Just the name, and only when there is one to fetch. The board has no list
 * picker to populate — this is purely so the page can say which list you are
 * looking at, now that a board can be a view of one.
 */
async function BoardCrumb({ listId }: { listId: string }) {
  const supabase = await createClient();
  const { data: openList } = await supabase.from("vizserve_pms_lists").select("name").eq("id", listId).maybeSingle();

  return openList ? <BreadcrumbLabel value={openList.name} /> : null;
}

/**
 * P7-26 — the requests that have not been decided yet, as the first column.
 *
 * This note has said two different things and both still hold. It was awaited
 * on its own so that a failure here could not stop the board rendering — still
 * true, because `loadPendingRequests` returns [] on its own errors rather than
 * throwing (lib/pending-requests-server.ts). Then it moved into the card batch
 * to save the round trip that separate await cost — also still true, because
 * sibling boundaries render concurrently and this read starts alongside the
 * card query rather than after it.
 *
 * What it no longer does is FINISH alongside the cards. It is one indexed read
 * against a small table and it paints as soon as it lands.
 *
 * The board has no status or priority filter to honour, so the only task-only
 * filter it can carry is none — `hasTaskOnlyFilter` stays false.
 */
async function PendingColumn({ listId, kind, scope }: { listId: string | null; kind: Kind; scope: Scope }) {
  const pendingRequests = await loadPendingRequests({ listId, kind, scope });

  return <PendingRequestColumn requests={pendingRequests} />;
}

/**
 * Every column, its count and its cards — P12-08, now a client view over the
 * query cache (`board-columns.tsx`).
 *
 * ⚠️ THIS WRAPPER STAYS A SERVER COMPONENT FOR TWO THINGS ONLY: today, read at
 * request time INSIDE the boundary (P12-20 — above it, `connection()` would make
 * the whole board request-time and lose the prerendered shell), and the viewer's
 * seat, which is `AuthContext` output the browser never holds.
 */
async function BoardColumnsToday({
  context,
  listId,
  kind,
  scope,
}: {
  context: AuthContext;
  listId: string | null;
  kind: Kind;
  scope: Scope;
}) {
  const today = await requestToday();

  return (
    <BoardColumns
      viewer={{
        userId: context.userId,
        role: context.role,
        managedDepartmentIds: context.managedDepartmentIds,
        primaryDepartmentId: context.primaryDepartmentId,
        isDeptAdmin: context.isDeptAdmin,
      }}
      listId={listId}
      kind={kind}
      scope={scope}
      today={today}
      // Once per request on the server — the fact being reported, not an
      // impure render. See `useRefetchOnServerRender`.
      // eslint-disable-next-line react-hooks/purity -- see the note above
      serverRenderedAt={Date.now()}
    />
  );
}
