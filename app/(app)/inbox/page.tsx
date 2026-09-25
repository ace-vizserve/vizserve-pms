import type { Metadata } from "next";

import { requireAuthContext } from "@/lib/auth/authorization";

import { InboxView, type InboxSearchParams } from "./inbox-view";

export const metadata: Metadata = { title: "Inbox" };

/**
 * P0-10 / P12-17 — the inbox: the SERVER half, which is auth and the URL and
 * nothing else.
 *
 * ------------------------------------------------------------------------
 * ⚠️ THIS FILE USED TO BE THE WHOLE PAGE — two queries, the sort allowlist, the
 * paging arithmetic, the search escaping, the paginator's `hrefFor`, both empty
 * states and an inline `"use server"` closure for "Mark all read". P12-17 moved
 * the reads into the TanStack cache (`inbox-view.tsx`,
 * `lib/query/fetchers/inbox.ts`), the narrowing with them, and the closure into
 * `actions.ts` — and left behind exactly one thing that must not move:
 *
 *   `requireAuthContext()` — the temporary-password wall, the `app_access` gate
 *   and the deactivation check. Authentication does not go through the cache, in
 *   any phase. It also runs in `app/(app)/layout.tsx` above this; calling it
 *   here is what makes this route's own gate explicit rather than inherited.
 *
 * ⚠️ THERE IS NO `viewer` PROP AND THERE MUST NOT BE ONE. Nothing on this screen
 * is a role or department decision: `notifications select own` is
 * `user_id = auth.uid()`, so every query is scoped by the policy and none of
 * them carries a filter. `/tasks` computes a viewer because its controls turn on
 * a role; there is nothing here for one to decide.
 *
 * ⚠️ AND IT ISSUES NO QUERY AT ALL NOW, WHICH IS THE POINT. Every navigation
 * into the inbox — and every read receipt, which used to `revalidatePath` both
 * this route AND the layout — cost two server reads plus a full shell render.
 * It costs the session lookup `requireAuthContext()` already does for the layout
 * and nothing else, and the rows come from the cache if they are there.
 * ------------------------------------------------------------------------
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<InboxSearchParams>;
}) {
  await requireAuthContext();
  const params = await searchParams;

  return <InboxView params={params} />;
}
