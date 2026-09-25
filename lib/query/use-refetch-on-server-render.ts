"use client";

import { useEffect, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * P12-07 — a cached view refetches whenever the SERVER re-rendered its page.
 *
 * ⚠️ THE SAFETY NET FOR EVERY WRITE THAT DOES NOT REFRESH THE CACHE ITSELF.
 * Creating a task, copying, bulk-editing, dragging a card, managing a list's
 * fields: those actions end in `revalidatePath`, which re-renders the server
 * page — and a re-render does not remount a client component, so a `useQuery`
 * inside one would keep the old rows. `serverRenderedAt` changes on every
 * server render, so this turns that signal into one invalidation. Staging's
 * sidebar used the same shape (`useRefetchOnServerRender`).
 *
 * ⚠️ `cancelRefetch: false`. The controls that DO refresh the cache
 * (`useTaskRefresh`) also call `router.refresh()`, so this fires right behind
 * their own invalidation. Cancelling that in-flight fetch would resolve the
 * control's awaited refresh early and let its optimistic value flash back; not
 * cancelling it means this simply joins the fetch already running.
 *
 * The first value is skipped: mount already fetches.
 */
export function useRefetchOnServerRender(serverRenderedAt: number, keys: readonly QueryKey[]) {
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
