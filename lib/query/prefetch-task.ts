import type { QueryClient } from "@tanstack/react-query";

import { browserClient } from "./browser-client";
import {
  fetchDirectory,
  fetchListFields,
  fetchSubtasks,
  fetchTaskAttachments,
  fetchTaskChecklist,
  fetchTaskComments,
  fetchTaskDetail,
  fetchTaskHistory,
  fetchTaskTimeTracked,
  fetchVisibleLists,
  type TaskDetail,
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
 * History and the list's custom fields depend on the task row (whether it came
 * from a request, which list it is in), so they follow it rather than racing it.
 * Collaborators and the request row are left to the page: both apply to few
 * tasks and cost one small read when they do.
 */
export function prefetchTask(queryClient: QueryClient, taskId: string): void {
  const client = browserClient();

  void queryClient
    .prefetchQuery({ queryKey: qk.task(taskId), queryFn: () => fetchTaskDetail(client, taskId) })
    .then(() => {
      const detail = queryClient.getQueryData<TaskDetail>(qk.task(taskId));
      if (!detail) return;

      void queryClient.prefetchQuery({
        queryKey: qk.taskPart(taskId, "history"),
        queryFn: () => fetchTaskHistory(client, taskId, { hasRequest: Boolean(detail.task.request_id) }),
      });

      const listId = detail.task.list_id;
      if (listId) {
        void queryClient.prefetchQuery({
          queryKey: qk.listFields(listId),
          queryFn: () => fetchListFields(client, listId),
        });
      }
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
