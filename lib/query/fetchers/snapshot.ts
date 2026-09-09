import type { PostgrestError } from "@supabase/supabase-js";

import { read, ReadError } from "@/lib/query/read";
import { sidebarSnapshotSchema, type SidebarSnapshot } from "@/lib/schemas/sidebar";

/**
 * P12-01 — the rail's only read.
 *
 * NINE QUERIES BECAME ONE. `app/(app)/sidebar-panel.tsx` used to issue eight
 * PostgREST requests plus a conditional ninth from a server component, two of
 * which downloaded one row per open task and one row per pending request purely
 * in order to count them in a `Map`. `vizserve_pms_sidebar_snapshot()` does the
 * counting where the rows are and returns one object.
 *
 * ⚠️ THE FUNCTION IS `SECURITY INVOKER`, so this call is scoped by exactly the
 * policies the nine queries were scoped by. Nothing here restates a scope, and
 * nothing here may start to: see the migration's header.
 */

/**
 * The narrowest client this fetcher needs.
 *
 * ⚠️ A STRUCTURAL TYPE, NOT `SupabaseClient`, AND THAT IS WHAT MAKES IT
 * TESTABLE. A fetcher that reaches for a module-level client can only be
 * exercised by mocking the module, which this repo has no framework for and does
 * not want one. Taking the client as an argument means a unit test hands it a
 * four-line object literal — `tests/unit/query-read.test.ts` does exactly that —
 * and the real `SupabaseClient<Database>` satisfies it structurally.
 *
 * `data: unknown` rather than `Json`: what comes back is validated below, and a
 * type that claimed to know its shape before the parse would be the cast this
 * whole file exists to avoid.
 */
export type SnapshotClient = {
  rpc: (fn: "vizserve_pms_sidebar_snapshot") => PromiseLike<{
    data: unknown;
    error: PostgrestError | null;
  }>;
};

export async function fetchSidebarSnapshot(client: SnapshotClient): Promise<SidebarSnapshot> {
  // `read`, not `?? {}`. A failed RPC throws with PostgREST's code intact, which
  // is what lets `makeQueryClient`'s retry policy tell a socket hiccup from a
  // missing GRANT — and what stops the rail rendering an empty tree in silence.
  let payload: unknown;

  try {
    payload = await read<unknown>(client.rpc("vizserve_pms_sidebar_snapshot"));
  } catch (error) {
    /*
     * ⚠️ THE RAIL SAYS "COULDN'T LOAD" AND, WITHOUT THIS, SAYS IT NOWHERE ELSE.
     *
     * `read()` throws with the PostgREST code intact and `useQuery` puts it in
     * `query.error`, which nothing renders and nothing logs — so the one screen
     * that reports its failure honestly still gave a person debugging it
     * nothing to go on. Reported once here, at the boundary, rather than in
     * `read()`: this is the app's most-rendered query and a generic log there
     * would be noise on every screen.
     *
     * `error` and not `warn`: unlike the realtime degrade, there is no version
     * of this that is working as intended.
     */
    const detail =
      error instanceof ReadError
        ? `${error.message} (code ${error.code ?? "none"})`
        : String(error);
    console.error(`[sidebar] snapshot read failed — ${detail}`);
    throw error;
  }

  const parsed = sidebarSnapshotSchema.safeParse(payload);

  if (!parsed.success) {
    /*
     * ⚠️ A SHAPE MISMATCH IS A DEPLOY-ORDER FAULT, NOT A BUG IN THE DATA.
     * Migrations are pasted by hand AFTER the code ships (CLAUDE.md), so the
     * live window where this build expects a function the database has not been
     * given yet is routine. Saying so in the message is the difference between
     * ten minutes and an afternoon.
     *
     * NO POSTGREST CODE IS INVENTED FOR IT. `isPermanent()` keys on the `42xxx`
     * family because those are genuinely "permission denied for table …", and
     * borrowing one of those codes to buy a skipped retry would make the retry
     * policy lie about what happened. So this retries twice like any other
     * transient failure, wastes two round trips, and then lands in `isError`
     * where it belongs.
     */
    throw new ReadError(
      "The sidebar came back in a shape this build does not recognise. " +
        "If vizserve_pms_sidebar_snapshot() has not been applied yet, that is why.",
      undefined,
      parsed.error.message,
    );
  }

  return parsed.data;
}
