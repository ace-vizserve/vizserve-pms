"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";

import { qk } from "./keys";

/**
 * P12-06 — what a task control does after a successful write, on EVERY task
 * surface.
 *
 * ⚠️ TWO KINDS OF PAGE SHARE THESE CONTROLS. `/tasks/[id]` reads from the query
 * cache; `/tasks`, the board and the gantt are still server-rendered. So one
 * refresh has to reach both: `router.refresh()` re-runs the server pages, and
 * invalidating `["task"]` refetches whatever task detail is on screen.
 *
 * ⚠️ AWAIT IT INSIDE THE TRANSITION. The controls paint with `useOptimistic`,
 * which reverts the moment its transition ends. Awaiting the refetch keeps the
 * transition open until the cache holds the saved value, so the optimistic value
 * hands over to the real one instead of flashing back to the old one first —
 * the snap-back staging hit (ded2244) when a refresh was not held open.
 *
 * The rail's counts are fired, not awaited: nobody is looking at them mid-click.
 */
export function useTaskRefresh() {
  const router = useRouter();
  const queryClient = useQueryClient();

  return useCallback(async () => {
    router.refresh();
    void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["task"] }),
      queryClient.invalidateQueries({ queryKey: ["lists", "fields"] }),
    ]);
  }, [router, queryClient]);
}
