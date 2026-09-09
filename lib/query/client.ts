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
  return new QueryClient({
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
}
