import type { Metadata } from "next";
import { Suspense } from "react";

import Loading from "./loading";
import { TaskDetailRoute } from "./task-detail-route";

export const metadata: Metadata = { title: "Task" };

/**
 * P12 Phase A — NO SERVER WORK, so opening a task switches at once.
 *
 * This page used to read the task row and the viewer's seat on the server
 * before a pixel moved — a round trip on every click. The seat is now decided
 * in the browser from the layout's auth context with the same rules, and the
 * task's reads start in one wave there (usually warm from a hover on the list).
 * RLS still decides which task anybody can read: a task you cannot see comes
 * back as nothing, and the page says so.
 */
export default function TaskDetailPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TaskDetailRoute />
    </Suspense>
  );
}
