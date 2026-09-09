/**
 * The QueryClient and its defaults.
 *
 * ⚠️ A FACTORY, NOT A MODULE SINGLETON. A client created at module scope is
 * shared by every request that touches the module on the server, which on a
 * multi-tenant render would hand one person's cache to another. One per browser
 * tab, created inside the provider. See `provider.tsx`.
 */
import { QueryClient } from "@tanstack/react-query";

import { isPermanent } from "./read";

/** Reference data — admin-managed, read by every picker, changes rarely. */
export const REF_STALE_TIME = 10 * 60_000;

export function makeQueryClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        /*
         * Per-user data. Long enough that moving between two lists and back does
         * not re-query, short enough that a stale number cannot survive a coffee.
         * Realtime is what actually keeps these fresh (see `realtime.ts`); this
         * is the floor for when it is degraded, which it silently can be.
         */
        staleTime: 30_000,

        /*
         * ⚠️ ON, AND IT IS NOT THE DEFAULT-BY-ACCIDENT KIND OF ON. An SPA is left
         * open overnight in a way a server-rendered page never was — this app
         * currently re-renders from the server on every navigation, so nothing
         * could ever be a day old. Coming back to yesterday's timesheet showing
         * as today's is the failure this prevents.
         */
        refetchOnWindowFocus: true,

        /*
         * `42xxx` is `permission denied for table …`, which per CLAUDE.md is
         * always a missing GRANT and never transient — the two-gate rule: a
         * failing POLICY returns zero rows, a missing GRANT returns this. Retrying
         * it three times triples the noise and fixes nothing.
         */
        retry: (failureCount, error) => !isPermanent(error) && failureCount < 2,
      },

      mutations: {
        /*
         * ⚠️ WRITES ARE NEVER RETRIED AUTOMATICALLY. Every mutation here goes
         * through a Server Action into a database function that writes history
         * and fires notifications. A retried transition is a second audit row and
         * a second email to a client. A person pressing the button again is a
         * decision; a library doing it is not.
         */
        retry: false,
      },
    },
  });

  /*
   * ⚠️ P12-20 — `REF_STALE_TIME` IS APPLIED HERE, ONCE, AND IT WAS APPLIED
   * NOWHERE AT ALL BEFORE THIS LINE.
   *
   * The constant has existed since Phase 0 and four files' comments say that
   * reference data "carries `REF_STALE_TIME`" — `fetchers/task.ts`,
   * `fetchers/requests.ts`, `keys.ts` and `realtime.ts` all assert it in
   * capitals, and `realtime.ts` maps a folder rename to `qk.ref("task-groups")`
   * specifically because a ten-minute stale time would otherwise hold a stale
   * name. NOT ONE `useQuery` PASSED IT. Every `qk.ref(...)` entry in Phases 3
   * and 4 was running on the 30-second default, so the staff directory was
   * being refetched on every window focus and on every navigation that landed
   * more than half a minute after the last one — which is precisely the cost
   * the plan calls "the cheapest win", sitting unclaimed behind a constant
   * everybody had already written the comments for.
   *
   * ⚠️ A KEY DEFAULT RATHER THAN AN OPTION AT EACH CALL SITE, deliberately, and
   * the reason is the same one `keys.ts` gives for the key hierarchy being the
   * invalidation API: `setQueryDefaults` matches BY PREFIX, so every present and
   * future `["ref", …]` entry inherits this whether or not the person adding it
   * remembers. Passing it per query would be nine call sites today and a tenth
   * that silently does not, indistinguishable on screen from one that does.
   *
   * ⚠️ IT CHANGES NOTHING ABOUT FRESHNESS GUARANTEES, ONLY ABOUT COST. A long
   * stale time is not a cache that ignores the truth — `invalidateQueries` cuts
   * straight through it, which is what `realtime.ts` does on a folder rename and
   * what `/forms` does on a publish. Staleness only decides whether a MOUNT
   * refetches; a table nobody has edited does not need re-reading because
   * somebody opened a second tab.
   */
  client.setQueryDefaults(["ref"], { staleTime: REF_STALE_TIME });

  return client;
}
