"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { RealtimeChannel } from "@supabase/supabase-js";

import { invalidateForTable, type RealtimeTable } from "@/lib/query/realtime";
import { createClient } from "@/utils/supabase/client";

/**
 * P8-03 — "SOMETHING YOU CAN SEE HAS CHANGED. GO AND LOOK."
 *
 * ⚠️ A SUBSCRIPTION HERE IS A PING, NOT A DATA CHANNEL, AND THAT IS THE WHOLE
 * DESIGN. The postgres_changes payload is never read, never merged into state
 * and never rendered. All this hook does is mark the query keys that event could
 * have touched as stale — the data still comes back through a query, under RLS,
 * shaped the way every other read is shaped.
 *
 * The alternative, patching rows into client state from the payload, was
 * rejected outright. It creates a second source of truth that drifts from the
 * database the first time a policy, a trigger or a derived column disagrees with
 * the row on the wire, and the drift is invisible: the screen looks right. It
 * also means the browser holds row data that a scoped read would have filtered,
 * shaped or joined. A re-read is slower and cannot be wrong.
 *
 * ⚠️ P12-02 CHANGED THE REACTION AND NOTHING ELSE. This was `router.refresh()`,
 * which re-rendered the WHOLE ROUTE — layout, rail and page — for every
 * notification anybody received. Completing a task therefore cost three full
 * server renders of the shell: the Server Action's `revalidatePath` payload, a
 * `router.refresh()` at the control, and this ping 300ms later. It is now
 * `invalidateForTable`, which marks the mapped keys stale and refetches only
 * what something is actually observing (`lib/query/realtime.ts`).
 *
 * ⚠️ THE COST OF THAT, WRITTEN DOWN HONESTLY — AND MOSTLY PAID OFF BY P12-09.
 * A page whose data is still SERVER-rendered does not redraw on somebody else's
 * write, because the keys this invalidates have no observer there. When P12-02
 * landed that was `/tasks`, `/tasks/board`, `/tasks/[id]` and `/requests`, and a
 * `router.refresh()` was kept here to cover them. P12-07 moved the three task
 * surfaces onto `qk.taskList` / `qk.taskBoard` / `qk.task`, so P12-09 took the
 * refresh out: they are live again, wider than before. What is left waiting for
 * a navigation is `/requests` and the inbox list, until Phase 4 puts them on
 * `qk.requests(f)` and `qk.inbox(f)` — no change here when it does. Do NOT
 * restore `router.refresh()` to close that gap; convert the page instead.
 *
 * ⚠️ THE FILTER IS EVALUATED SERVER-SIDE AND RLS RUNS ON TOP OF IT. A
 * filtered-out event never leaves the database, and an event that survives the
 * filter is still authorized against this subscriber's own JWT. That is why
 * `setAuth` below is not optional and why an empty filter is a refusal to
 * subscribe rather than a subscription with no filter.
 */

/** The four events Postgres Changes can deliver, plus the wildcard. */
export type RealtimeRefreshEvent = "*" | "INSERT" | "UPDATE" | "DELETE";

export type UseRealtimeRefreshOptions = {
  /**
   * The published table to watch. Only what P8-03's migration publishes works.
   *
   * ⚠️ `RealtimeTable`, NOT `string`, AND THAT IS THE POINT. The type is the key
   * set of `INVALIDATES` in `lib/query/realtime.ts`, so a table nobody has
   * mapped cannot be subscribed to at all. Under `router.refresh()` an unmapped
   * table still worked — the refresh repainted everything regardless of what had
   * changed — so the omission cost nothing and left no trace. Under invalidation
   * it is a channel that joins, receives events and moves NOTHING, with no error
   * anywhere: the silent death this file's other comments exist to prevent.
   * A typecheck failure is the loudest place to find that out.
   */
  table: RealtimeTable;
  /**
   * A Postgres Changes filter string — `column=eq.value`, `column=in.(a,b)`.
   *
   * ⚠️ `null`/`undefined`/`""` MEANS DO NOT SUBSCRIBE. It does NOT mean "no
   * filter". A missing filter value must never become an unfiltered stream, so
   * the absence is handled here rather than trusted to each caller.
   */
  filter: string | null | undefined;
  /**
   * The channel topic. Must be unique per (table, filter) — two channels sharing
   * a topic collide on one socket and the second one's bindings are lost.
   */
  channelName: string;
  /** Escape hatch for a page that wants the subscription conditionally. */
  enabled?: boolean;
  /**
   * Fired alongside the invalidation, debounced with it.
   *
   * ⚠️ TAKES NO ARGUMENT, ON PURPOSE. There is nowhere to put the payload
   * because the payload is never read — a toast built from `payload.new.title`
   * would be rendering a row that RLS has authorized but the RSC layer has not
   * shaped, which is the exact second-source-of-truth this hook refuses.
   */
  onPing?: () => void;
  /** Defaults to every event. Narrowing this narrows the SERVER-side stream. */
  event?: RealtimeRefreshEvent;
};

/**
 * How long a burst of row events is allowed to collapse into one re-fetch.
 *
 * Approving a request writes a task, a status-history row and a notification in
 * one transaction, and moving a card writes several tasks' `sort_order` at once.
 * Without this the page would re-render once per row. 300ms is under the
 * threshold where a person reads the screen as "not updating" and comfortably
 * over the width of a single transaction's event burst.
 */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * ⚠️ THE SECOND HALF OF "AN UNMAPPED TABLE MUST NOT BE A SILENT NO-OP".
 *
 * `RealtimeTable` closes the door at compile time and that is the door that
 * matters; this is the runtime backstop for the ways past it — a cast, a name
 * widened to `string` somewhere on the way in, or a row deleted from
 * `INVALIDATES` while a subscription still asks for it. `console.error`, not
 * `warn`: unlike the degrade below this is not a capability that is merely
 * switched off, it is a subscription that will run for the life of the page and
 * do nothing at all.
 *
 * Once per table, for the same reason `reportOnce` is once per channel — a
 * message repeated on every navigation is a message nobody reads.
 */
const unmapped = new Set<string>();

function reportUnmapped(table: string) {
  if (unmapped.has(table)) return;
  unmapped.add(table);

  console.error(
    `[realtime] ${table} has no row in INVALIDATES (lib/query/realtime.ts). The channel will ` +
      `subscribe and receive events, and every one of them will invalidate nothing — this used ` +
      `to work by accident because the reaction was router.refresh(). Map the table.`,
  );
}

/**
 * ⚠️ ONE BROWSER CLIENT FOR THE WHOLE TAB, AND IT IS CREATED LAZILY.
 *
 * `createClient()` returns a NEW `createBrowserClient` every call. Calling it
 * per render churns the effect below on every re-render — a fresh client means a
 * fresh socket, so the channel is torn down and rebuilt continuously and the
 * page never actually receives anything. And the app shell plus the page both
 * mount this hook, so even one-per-component would open two websockets to carry
 * two pings.
 *
 * ⚠️ LAZY, NOT MODULE-INITIALISED, because a `"use client"` component is still
 * RENDERED ON THE SERVER for its initial HTML. Building a browser client during
 * that pass reaches for `document.cookie`. Everything here happens inside
 * `useEffect`, which only ever runs in the browser.
 */
let sharedClient: ReturnType<typeof createClient> | null = null;

function browserClient() {
  sharedClient ??= createClient();
  return sharedClient;
}

/**
 * ⚠️ THE DEGRADE, and the reason it exists is the deploy order.
 *
 * Migrations in this repo are pasted BY HAND into the Supabase SQL editor AFTER
 * the code is deployed (CLAUDE.md). So there is a real window in which this hook
 * is live and `20260903120000_p8_03_realtime.sql` has not been run — the tables
 * are not on the publication, and subscribing yields `CHANNEL_ERROR` and no
 * events. The same is true if Realtime is disabled for the project.
 *
 * In that window the page MUST still work. Nothing here may throw, and nothing
 * may retry in a loop: a channel that keeps re-joining spams the console, holds
 * a socket open and puts load on the Realtime service for a feature that is
 * simply not switched on yet. This follows the precedent of
 * `deptAdminColumnMissing` in lib/auth/authorization.ts — a capability nobody
 * can use yet is not worth degrading the app for.
 *
 * ⚠️ SO THE POLICY IS: LOG ONCE PER CHANNEL, THEN GO QUIET. On the first
 * `CHANNEL_ERROR` or `TIMED_OUT` the channel is removed, which also stops
 * realtime-js's own backoff re-join. There is no automatic retry — THE RETRY IS
 * NAVIGATION. Every route change remounts this hook and re-attempts, which is
 * exactly the cadence at which somebody would have got fresh data anyway.
 *
 * The cost is honest: a transient network blip kills live updates for the rest
 * of that page view. That is strictly better than the alternative, which was a
 * page that reconnects forever against a publication that will not exist until
 * Ace pastes the SQL.
 */
const reported = new Set<string>();

function reportOnce(channelName: string, status: string) {
  if (reported.has(channelName)) return;
  reported.add(channelName);

  // `warn`, not `error`. This is a degraded feature, not a fault: the page
  // renders, the data is correct, it just will not update itself.
  console.warn(
    `[realtime] ${channelName} could not subscribe (${status}). Live updates are off for this page; ` +
      `it will refresh on navigation. If this persists, check that the table is on the ` +
      `supabase_realtime publication (P8-03).`,
  );
}

/**
 * ⚠️ EVERY SUBSCRIPTION GETS ITS OWN TOPIC, AND THIS COUNTER IS WHY.
 *
 * The first version of this hook keyed the topic on WHAT WAS BEING WATCHED —
 * `p8-03:tasks:<filter>` — on the reasoning that the same person watching the
 * same departments is the same subscription, and that the four task pages never
 * co-exist anyway. Both halves of that are true and the conclusion was still
 * wrong, because THE PAGES OVERLAP DURING THE NAVIGATION BETWEEN THEM:
 *
 *   1. `RealtimeClient.channel(topic)` RETURNS AN EXISTING CHANNEL for a topic
 *      it already knows. It does not create a second one.
 *   2. The cleanup's `removeChannel()` needs a websocket `leave` round-trip
 *      before the channel actually drops out of `client.channels`, and it is
 *      deliberately not awaited (see `teardown`).
 *   3. So /tasks → /tasks/board mounts the new hook while the old channel is
 *      still LEAVING, and step 1 hands it that channel.
 *   4. `RealtimeChannel.subscribe()` only joins `if (isClosed())`. A `leaving`
 *      channel is not `closed`, so THE JOIN AND THE STATUS CALLBACK ARE BOTH
 *      SKIPPED — and the leave then completes and tears it down.
 *
 * The result was the exact silent death this file's comments claim to prevent:
 * no events, and no warning either, because `reportOnce` fires from a status
 * callback that was never registered. Nothing throws and the page looks fine.
 *
 * A monotonic counter rather than `useId()`: `useId` is derived from position in
 * the tree, and two pages rendering this hook at the same position can be handed
 * the SAME id — which is the bug again, in a form that only appears on the
 * routes that happen to line up. A counter cannot collide within a tab.
 *
 * ⚠️ AND IT IS READ INSIDE THE EFFECT, NOT DURING RENDER. Navigation is only one
 * of the ways this subscription restarts; the effect also re-runs when `filter`,
 * `table`, `event` or `enabled` change, and a topic minted once per MOUNT would
 * let a re-run collide with its own outgoing channel in exactly the way
 * described above. One topic per effect run is the only version that closes
 * both doors. (It also keeps the counter out of the render body, which the
 * `react-hooks/refs` rule forbids for a value like this.)
 */
let channelSequence = 0;

/**
 * Subscribes to one published table and invalidates the query keys that table
 * can have touched when it changes. Renders nothing, returns nothing.
 */
export function useRealtimeRefresh({
  table,
  filter,
  channelName,
  enabled = true,
  onPing,
  event = "*",
}: UseRealtimeRefreshOptions): void {
  const queryClient = useQueryClient();

  /*
   * `onPing` is almost always an inline arrow, so it is a new function on every
   * render. Held in a ref rather than named in the dependency array below,
   * because a changed identity there would tear the channel down and rebuild it
   * on every render — the subscription would never live long enough to deliver
   * anything.
   */
  const onPingRef = useRef(onPing);
  useEffect(() => {
    onPingRef.current = onPing;
  }, [onPing]);

  /*
   * The reaction, pulled out as a stable callback so the effect depends on one
   * function rather than on the whole client. `useQueryClient()` returns the one
   * instance the provider holds — one per tab, per `lib/query/provider.tsx` —
   * but that is an implementation detail of that file, and this effect opens a
   * WEBSOCKET: it must not be torn down and rebuilt because something above
   * changed identity. Exactly the reasoning that used to apply to `useRouter()`.
   *
   * ⚠️ IT REPORTS AN UNMAPPED TABLE RATHER THAN RETURNING QUIETLY. See
   * `reportUnmapped` — an event that invalidates nothing is indistinguishable
   * from an event that never arrived, and the old `router.refresh()` made the
   * whole question moot by repainting the route either way.
   */
  const invalidate = useCallback(() => {
    const keys = invalidateForTable(queryClient, table);
    if (keys.length === 0) reportUnmapped(table);

    /*
     * ⚠️ P12-09 — `router.refresh()` WAS HERE, AND ITS OWN STATED CONDITION IS
     * WHAT REMOVED IT. It read: "DELETE THIS THE DAY `qk.taskList` /
     * `qk.taskBoard` / `qk.task` HAVE OBSERVERS." P12-07 gave them observers.
     *
     * The argument for keeping it was that invalidation only repaints what a
     * query is OBSERVING, and until this week exactly one thing was: the rail.
     * `/tasks`, `/tasks/board` and `/tasks/[id]` read their rows in an RSC, so
     * dropping the refresh would have taken cross-user live updates with it — a
     * colleague moving a card would stop repainting the board you left open,
     * which is the whole of P8-03. All three read from the cache now, and the
     * `vizserve_pms_tasks` row of `INVALIDATES` reaches every one of them.
     *
     * ⚠️ TWO SURFACES STILL READ IN RSC AND KNOWINGLY LOSE THE PUSH:
     * `/requests` (its table waits for a navigation — that page already carries
     * this note, and Phase 4 puts it on `qk.requests(f)`, at which point the same
     * event moves the rows with no change here) and the inbox list (same, on
     * `qk.inbox(f)`). Their COUNTS stay live either way, because the rail
     * observes `qk.snapshot()` and both rows carry it.
     *
     * The alternative was keeping a whole-route render on every event anybody
     * receives so that two unconverted pages stay live — which is the storm
     * P12-02 exists to stop, paid by every screen in the product. Do not restore
     * it; convert the page instead.
     */
  }, [queryClient, table]);

  useEffect(() => {
    if (!enabled) return;

    // ⚠️ NO FILTER, NO SUBSCRIPTION. See `realtimeDepartmentFilter` — an empty
    // scope must never widen into a stream of everything.
    if (!filter) return;

    /*
     * ⚠️ STRICT MODE DOUBLE-INVOKES THIS EFFECT IN DEVELOPMENT (React 19), and
     * the body is ASYNC — `await setAuth()` means the setup can resolve AFTER
     * the cleanup has already run. Without this flag the second invocation
     * leaves a channel nobody holds a reference to, subscribed forever, writing
     * into the query cache from an unmounted tree.
     */
    let cancelled = false;
    let channel: RealtimeChannel | null = null;
    let authWatch: { unsubscribe: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const supabase = browserClient();

    /*
     * ⚠️ MINTED HERE, INSIDE THE EFFECT — ONE TOPIC PER EFFECT RUN, NOT PER
     * MOUNT. See `channelSequence` above for what goes wrong when two channels
     * share a topic; the point of putting it here rather than in the render body
     * is that A MOUNT IS NOT THE ONLY THING THAT RESTARTS THIS SUBSCRIPTION.
     * The effect also re-runs whenever `filter`, `table`, `event` or `enabled`
     * changes — a lead's departments changing mid-session is exactly that — and
     * a per-mount topic would hand the re-run the very channel its own cleanup
     * had just started tearing down. Same silent death, different door.
     *
     * A plain module-scope counter and not `useId()`, which is derived from
     * position in the tree and can hand the same value to two different pages.
     */
    const topic = `${channelName}#${++channelSequence}`;

    const ping = () => {
      if (cancelled) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (cancelled) return;
        invalidate();
        onPingRef.current?.();
      }, REFRESH_DEBOUNCE_MS);
    };

    const teardown = (dead: RealtimeChannel | null) => {
      if (!dead) return;
      // The promise is deliberately not awaited and its rejection is swallowed:
      // a failure to remove a channel that is already broken is not news, and an
      // unhandled rejection in a cleanup path is.
      void Promise.resolve(supabase.removeChannel(dead)).catch(() => {});
    };

    const start = async () => {
      try {
        /*
         * ⚠️ WITHOUT THIS THE SOCKET CARRIES THE ANON KEY AND RLS SEES NO USER,
         * so every authorized event is refused and the channel goes quiet in a
         * way that looks exactly like "nothing is happening".
         *
         * Called with NO ARGUMENT on purpose: that form pulls the current
         * session's access token out of the auth client rather than making the
         * caller find and pass one.
         */
        await supabase.realtime.setAuth();
      } catch {
        // A failed token read is the degrade case, not a crash. Fall through and
        // let `subscribe` report whatever the server makes of it.
      }

      if (cancelled) return;

      channel = supabase.channel(topic);

      channel
        .on(
          "postgres_changes",
          { event, schema: "public", table, filter },
          /*
           * ⚠️ THE CALLBACK TAKES NO ARGUMENT. The payload is right there and is
           * deliberately not named — naming it is the first step towards
           * rendering it. `select: [...]` on the binding could shrink the
           * payload further, but it depends on a recent Realtime server and
           * would be an optimisation of something we already throw away.
           */
          () => {
            ping();
          },
        )
        .subscribe((status) => {
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
            reportOnce(channelName, status);
            const dead = channel;
            channel = null;
            teardown(dead);
          }
        });

      /*
       * ⚠️ THE SOCKET'S JWT EXPIRES AFTER AN HOUR AND NOTHING TELLS YOU.
       *
       * `setAuth()` above stamps the token onto the socket ONCE. When Supabase
       * rotates it, the socket keeps the old one; the channel stays SUBSCRIBED
       * and authorized events silently stop arriving. That is the worst possible
       * failure shape — a page that was live at 09:00 and is quietly dead at
       * 10:00, with no error anywhere.
       *
       * SIGNED_OUT clears it rather than leaving a stale token on a socket that
       * outlives the session.
       */
      authWatch = supabase.auth.onAuthStateChange((authEvent) => {
        if (cancelled) return;
        if (authEvent === "TOKEN_REFRESHED") {
          void supabase.realtime.setAuth().catch(() => {});
        } else if (authEvent === "SIGNED_OUT") {
          void supabase.realtime.setAuth(null).catch(() => {});
        }
      }).data.subscription;
    };

    void start();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      authWatch?.unsubscribe();
      teardown(channel);
      channel = null;
    };
  }, [table, filter, channelName, enabled, event, invalidate]);
}
