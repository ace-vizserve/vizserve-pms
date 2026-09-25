/**
 * "This tab just wrote something."
 *
 * ⚠️ WITHOUT THIS, EVERY WRITE FETCHES EVERYTHING TWICE. The writer's own
 * mutation invalidates the cache, and roughly 300ms later the
 * `postgres_changes` event that same write produced arrives and invalidates all
 * of it again. Ace's network tab for one status change showed the rail RPC three
 * times and every surface query twice.
 *
 * The person who pressed the button is the one person who does not need the
 * ping: they already have the answer, and `onSettled` has already asked for
 * fresh rows.
 *
 * ⚠️ MODULE SCOPE IS WHAT MAKES IT SAFE, and it is the whole design. A module
 * variable is per TAB, so this can only ever suppress an echo of a write made
 * HERE. Another person's change, and the same person's other tabs, still
 * repaint — which is the entirety of P8-03 and must not be weakened to save a
 * request.
 *
 * ⚠️ THE COST, STATED PLAINLY: a colleague's event that lands inside the same
 * window is dropped too. The payload is deliberately never read
 * (`use-realtime-refresh.ts` argues why at length), so there is no way to tell
 * whose event it is without reading it — and reading it would put un-shaped rows
 * in front of a reader, which is the thing that file exists to prevent. The
 * window is therefore kept SHORT and the loss is bounded: the next write, the
 * next navigation or the next `staleTime` expiry re-reads anyway.
 */

/**
 * Just long enough to cover a write's own echo.
 *
 * The realtime debounce is 300ms and Supabase's delivery is typically well
 * under a second. 1200ms clears the echo with margin; anything longer starts
 * eating other people's updates for no gain.
 */
const ECHO_WINDOW_MS = 1200;

let lastLocalWriteAt = 0;

/** Called at the start of every local mutation. */
export function markLocalWrite() {
  lastLocalWriteAt = Date.now();
}

/** True while a ping is probably this tab's own echo. */
export function isLocalEcho() {
  return Date.now() - lastLocalWriteAt < ECHO_WINDOW_MS;
}
