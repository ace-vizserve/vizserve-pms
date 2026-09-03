"use client";

import { toast } from "sonner";

import { useRealtimeRefresh } from "@/hooks/use-realtime-refresh";

/**
 * P8-03 — the mount points for the live-refresh subscriptions.
 *
 * ⚠️ EVERY COMPONENT HERE RENDERS NOTHING AND RETURNS `null`. That is not a
 * placeholder. The four pages that go live and the app shell are all SERVER
 * components, and a server component cannot hold a websocket or call
 * `router.refresh()` — so each needs a client component in its tree whose only
 * job is to run the hook. Making the pages themselves client components to avoid
 * these three files would have cost the RSC data fetching that the whole
 * refresh-through-RLS design depends on.
 *
 * ⚠️ THE FILTER IS COMPUTED ON THE SERVER AND PASSED IN AS A PROP. It cannot be
 * computed here: `lib/auth/authorization.ts` is `server-only`, deliberately, and
 * "all role/department scoping goes through it" (CLAUDE.md) is exactly the rule
 * that would be broken by a client component deciding its own scope. A prop is
 * also the honest shape — the browser is being TOLD what it may watch, it is not
 * asking.
 *
 * ⚠️ AND IT IS NOT A SECURITY CONTROL. Somebody can edit the prop in the
 * client bundle and subscribe to another department's stream; RLS then refuses
 * every event it carries, because Postgres Changes authorizes per subscriber
 * against the same policies a page render goes through. The filter is a
 * blast-radius and efficiency control on top of that, never instead of it.
 */

/**
 * The live inbox badge, mounted in the app shell so it is on every page.
 *
 * ⚠️ `event: "INSERT"` RATHER THAN `"*"`, and the narrowing is deliberate in
 * two ways. It keeps the SERVER-side stream to the events that actually change
 * the badge — a notification row is written once and then only ever updated to
 * set `read_at` — and it is what lets the toast below be honest: an INSERT is
 * unambiguously "something new arrived", so the toast can say so WITHOUT
 * reading the payload to work out which kind of event it was.
 *
 * THE GAP THAT BUYS: marking a notification read in ANOTHER TAB will not push
 * this one's badge down. The tab that did it refreshes itself through the server
 * action, so the person who performed the action always sees the truth; a second
 * tab they left open is stale until they touch it. That was the pre-P8-03
 * behaviour of every number in this app, so nothing regresses.
 *
 * The channel is keyed on the user id, which is also the filter value — so the
 * topic is unique per subscriber and cannot collide with the task channel below.
 */
export function RealtimeNotifications({ userId }: { userId: string }) {
  useRealtimeRefresh({
    table: "vizserve_pms_notifications",
    filter: `user_id=eq.${userId}`,
    channelName: `p8-03:notifications:${userId}`,
    event: "INSERT",
    onPing: () => {
      /*
       * ⚠️ GENERIC TEXT, AND IT MUST STAY GENERIC. The notification's own title
       * is sitting in the payload and is exactly what must not be rendered: the
       * payload is never read (see `useRealtimeRefresh`), and a toast built from
       * it would be the one place in the app showing a row that never passed
       * through the RSC render. The unread badge and /inbox — both re-fetched by
       * the refresh this fires alongside — say what it actually was.
       *
       * One toast per burst, not per row: the hook's debounce collapses a
       * transaction that writes several notifications into a single ping, which
       * is why this can be a plain sentence and not a count.
       *
       * A plain `toast`, not `toast.success`/`toast.error`. Nothing has
       * succeeded or failed — and a coloured toast with no label would be state
       * conveyed by colour alone.
       */
      toast("You have a new notification");
    },
  });

  return null;
}

/**
 * Live task rows, scoped to the departments the viewer belongs to or leads.
 *
 * Mounted by /tasks, /tasks/board, /tasks/[id] and /requests. `filter` comes
 * from `realtimeDepartmentFilter(context)` on the server, and `null` there means
 * this person is mapped to no department at all — the hook then declines to
 * subscribe rather than opening an unfiltered stream.
 *
 * ⚠️ THE CHANNEL NAME CARRIES THE FILTER, not the page. Two topics with the same
 * name collide on one socket, and the same subscriber watching the same
 * departments from two routes is the same subscription — the routes never
 * co-exist, but keying on the filter rather than on the pathname means the topic
 * is a function of what is being watched, which is the property that has to hold.
 */
export function RealtimeTasks({ filter }: { filter: string | null }) {
  useRealtimeRefresh({
    table: "vizserve_pms_tasks",
    filter,
    channelName: `p8-03:tasks:${filter ?? "none"}`,
  });

  return null;
}
