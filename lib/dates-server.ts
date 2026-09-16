import "server-only";

import { connection } from "next/server";

import { todayInAppZone } from "./dates";

/**
 * P12-20 — today's date, read at REQUEST TIME and said so.
 *
 * ⚠️ THE CLOCK IS NOT A DYNAMIC API, WHICH IS THE WHOLE PROBLEM. `cookies()` and
 * `headers()` announce themselves: Cache Components sees one, stops the
 * prerender there and renders the rest at request time. `new Date()` announces
 * nothing — so a component that reads it during a prerender would bake a
 * timestamp into a shell that is then served to everybody, and Next refuses
 * rather than letting that happen:
 *
 *     Route "/tasks": Next.js encountered the unstable value `Date.now()`
 *     while prerendering.
 *
 * What that error COSTS is the thing worth fixing. `cacheComponents` and
 * `partialPrefetching` were turned on in P11-05 so every route has a prerendered
 * shell that Partial Prefetching can fetch before the click — and a route whose
 * shell fails to prerender does not get one. The tasks tree has been paying full
 * server latency on every navigation for it.
 *
 * `await connection()` is the announcement the clock cannot make for itself: it
 * marks this render as request-time, after which reading the clock is legal.
 * It costs no round trip — every caller here has already awaited
 * `requireAuthContext()`, which reads cookies.
 *
 * ⚠️ CALL IT INSIDE THE SUSPENSE BOUNDARY, NOT ABOVE IT. Awaiting this at the
 * top of a page makes the whole page request-time and the shell disappears
 * again — which is the failure this exists to fix, arrived at from the other
 * direction. It belongs in the streaming child that draws the rows.
 *
 * ⚠️ AND CLIENT COMPONENTS CANNOT USE IT. `connection()` is server-only, so a
 * client table takes `today` as a prop from the server that rendered it —
 * `isTaskOverdue(task, today)`. That also makes the server pass and the browser
 * agree on the date, which a clock read in each would not at midnight.
 */
export async function requestToday(): Promise<string> {
  await connection();

  return todayInAppZone();
}
