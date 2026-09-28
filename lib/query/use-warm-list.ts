"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/lib/auth/client-auth";

import { prefetchTaskListView } from "./prefetch-task";

/**
 * P12 — warm a list's data on intent (hover or focus on a sidebar list link).
 * `base` is where the link goes; the gantt reads its own data on the server, so
 * there is nothing of it in the cache to warm.
 */
export function useWarmList() {
  const queryClient = useQueryClient();
  const { userId } = useAuth();

  return useCallback(
    (listId: string, base: string) => {
      if (base === "/tasks") prefetchTaskListView(queryClient, listId, userId, "list");
      else if (base === "/tasks/board") prefetchTaskListView(queryClient, listId, userId, "board");
    },
    [queryClient, userId],
  );
}
