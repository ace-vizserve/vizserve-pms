"use client";

import { createContext, useContext, useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * P12 — a cached view refetches whenever the SERVER re-rendered the app shell.
 *
 * ⚠️ THE SAFETY NET FOR EVERY WRITE THAT DOES NOT REFRESH THE CACHE ITSELF.
 * Creating a task, copying, bulk-editing, managing a list's fields: those
 * actions end in `revalidatePath`, which re-renders the server tree — and a
 * re-render does not remount a client component, so a `useQuery` inside one
 * would keep the old rows.
 *
 * ⚠️ THE STAMP COMES FROM THE LAYOUT, NOT FROM EACH PAGE (Phase A). Pages no
 * longer render on the server per click, so they have no server render to
 * report. `app/(app)/layout.tsx` still renders on every `revalidatePath` and
 * `router.refresh()` (it runs the auth gate), so it stamps `Date.now()` into
 * this context and every view subscribes to the one value.
 *
 * ⚠️ `cancelRefetch: false`. The controls that DO refresh the cache
 * (`useTaskRefresh`) also call `router.refresh()`, so this fires right behind
 * their own invalidation. Cancelling that in-flight fetch would resolve the
 * control's awaited refresh early and let its optimistic value flash back.
 *
 * The first value is skipped: mount already fetches.
 */
const Stamp = createContext<number>(0);

export function ServerRenderStamp({ at, children }: { at: number; children: React.ReactNode }) {
  return <Stamp.Provider value={at}>{children}</Stamp.Provider>;
}

export function useRefetchOnServerRender(keys: readonly QueryKey[]) {
  const serverRenderedAt = useContext(Stamp);
  const client = useQueryClient();
  const seen = useRef(serverRenderedAt);
  const keysRef = useRef(keys);

  useEffect(() => {
    keysRef.current = keys;
  });

  useEffect(() => {
    if (seen.current === serverRenderedAt) return;
    seen.current = serverRenderedAt;
    for (const queryKey of keysRef.current) {
      void client.invalidateQueries({ queryKey }, { cancelRefetch: false });
    }
  }, [client, serverRenderedAt]);
}
