"use client";

import { useParams } from "next/navigation";

import { TaskDetail } from "./task-detail";

/** Reads `[id]` from the URL in the browser — resolved synchronously on a client navigation. */
export function TaskDetailRoute() {
  const { id } = useParams<{ id: string }>();
  // `key` so moving from one task to another starts clean rather than carrying state across.
  return <TaskDetail key={id} taskId={id} />;
}
