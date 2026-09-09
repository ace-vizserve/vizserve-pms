import { createClient } from "@/utils/supabase/client";

/**
 * ONE BROWSER SUPABASE CLIENT FOR THE WHOLE TAB, CREATED LAZILY.
 *
 * ⚠️ `createClient()` RETURNS A NEW `createBrowserClient` ON EVERY CALL. Calling
 * it in a component body churns a fresh client on every render, and a fresh
 * client means a fresh auth listener and a fresh socket — the trap
 * `hooks/use-realtime-refresh.ts` records at length, where it tore down and
 * rebuilt the realtime channel continuously so the page never received anything.
 * A `queryFn` closing over a per-render client has the milder version of the
 * same problem: the client is not part of the query key, so nothing breaks
 * visibly, and the tab quietly accumulates clients.
 *
 * ⚠️ LAZY, NOT MODULE-INITIALISED, and this is the half that actually crashes. A
 * `"use client"` component is still RENDERED ON THE SERVER for its initial HTML.
 * Building a browser client during that pass reaches for `document.cookie`,
 * which does not exist there. Everything that calls this does so from inside a
 * `queryFn` or an effect, both of which only ever run in the browser.
 *
 * ⚠️ `use-realtime-refresh.ts` HOLDS ITS OWN COPY OF THIS SINGLETON and is NOT
 * changed here. That hook is Phase 2's subject and its plumbing — channel-topic
 * sequencing, `setAuth` token rotation, degrade-once-then-go-quiet — is to be
 * kept verbatim while only its callback moves. Collapsing the two clients into
 * one is a Phase 2 tidy, not a Phase 1 edit; two clients in a tab is a small
 * waste, and editing that file early is how the degrade path gets broken.
 */
let shared: ReturnType<typeof createClient> | null = null;

export function browserClient() {
  shared ??= createClient();
  return shared;
}
