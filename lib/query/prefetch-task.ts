import type { QueryClient } from "@tanstack/react-query";

import { browserClient } from "./browser-client";
import {
  fetchDirectory,
  fetchTaskFields,
  fetchTaskRequestByTask,
  fetchSubtasks,
  fetchTaskAttachments,
  fetchTaskChecklist,
  fetchTaskComments,
  fetchTaskDetail,
  fetchTaskHistory,
  fetchTaskTimeTracked,
  fetchVisibleLists,
} from "./fetchers/task";
import { qk } from "./keys";

/**
 * P12-06 — warm a task's cache entries before its page is opened.
 *
 * `prefetchQuery` does nothing for an entry that is still fresh, so hovering the
 * same row twice costs nothing, and a task already open in the tab is not read
 * again. The reads are exactly the ones `task-detail.tsx` makes, under the same
 * keys — the page then finds them in the cache and draws at once instead of
 * starting eleven reads after the click.
 *
 * The viewer's own seat (`joined`) and the collaborators are left to the page:
 * the first needs the viewer's id, the second is reference data that is almost
 * always warm already.
 */
export function prefetchTask(queryClient: QueryClient, taskId: string): void {
  const client = browserClient();

  // P12 Phase A — every read is keyed on the task id alone, so all of them go
  // out together; nothing waits on the task row.
  void queryClient.prefetchQuery({ queryKey: qk.task(taskId), queryFn: () => fetchTaskDetail(client, taskId) });
  void queryClient.prefetchQuery({
    queryKey: qk.taskPart(taskId, "history"),
    queryFn: () => fetchTaskHistory(client, taskId),
  });
  void queryClient.prefetchQuery({
    queryKey: qk.taskPart(taskId, "fields"),
    queryFn: () => fetchTaskFields(client, taskId),
  });
  void queryClient.prefetchQuery({
    queryKey: qk.taskPart(taskId, "request"),
    queryFn: () => fetchTaskRequestByTask(client, taskId),
  });
  void queryClient.prefetchQuery({
    queryKey: qk.taskPart(taskId, "comments"),
    queryFn: () => fetchTaskComments(client, taskId),
  });
  void queryClient.prefetchQuery({
    queryKey: qk.taskPart(taskId, "subtasks"),
    queryFn: () => fetchSubtasks(client, taskId),
  });
  void queryClient.prefetchQuery({
    queryKey: qk.taskPart(taskId, "attachments"),
    queryFn: () => fetchTaskAttachments(client, taskId),
  });
  void queryClient.prefetchQuery({
    queryKey: qk.taskPart(taskId, "checklist"),
    queryFn: () => fetchTaskChecklist(client, taskId),
  });
  void queryClient.prefetchQuery({
    queryKey: qk.taskPart(taskId, "time"),
    queryFn: () => fetchTaskTimeTracked(client, taskId),
  });
  // Shared reference entries: fresh for minutes, so usually already warm.
  void queryClient.prefetchQuery({ queryKey: qk.ref("users"), queryFn: () => fetchDirectory(client) });
  void queryClient.prefetchQuery({ queryKey: qk.listsVisible(), queryFn: () => fetchVisibleLists(client) });
}
