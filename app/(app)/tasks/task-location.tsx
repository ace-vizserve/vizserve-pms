"use client";

import { useQuery } from "@tanstack/react-query";

import { BreadcrumbTrail, type BreadcrumbTrailItem } from "@/components/app-shell/dynamic-breadcrumb";
import { browserClient } from "@/lib/query/browser-client";
import { fetchActiveDepartments, fetchTaskGroups, fetchVisibleLists } from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";

/**
 * WHERE A LIST OR A TASK SITS — Department › Folder › List (› Task), in the
 * shell's breadcrumb.
 *
 * Neither URL says it: `/tasks?list=<id>` reads "Tasks" and `/tasks/<uuid>`
 * read "Tasks › <title>", so the only way to know which list you were in was
 * the back link. Every read here is reference data already cached by the page
 * underneath, so this adds no request on a warm visit.
 *
 * The list crumb is a switcher across the lists of the same department and
 * kind (a personal list only offers personal lists), so moving sideways does
 * not mean going back to the index.
 */
export function TaskLocation({ listId, title }: { listId: string | null; title?: string }) {
  const lists = useQuery({ queryKey: qk.listsVisible(), queryFn: () => fetchVisibleLists(browserClient()) });
  const groups = useQuery({ queryKey: qk.ref("task-groups"), queryFn: () => fetchTaskGroups(browserClient()) });
  const departments = useQuery({
    queryKey: qk.ref("departments"),
    queryFn: () => fetchActiveDepartments(browserClient()),
  });

  const list = listId ? lists.data?.find((row) => row.id === listId) : undefined;
  const items: BreadcrumbTrailItem[] = [];

  if (list) {
    if (list.owner_id !== null) {
      // Personal lists live in the sidebar's own section, not in the index.
      items.push({ label: "Personal lists" });
    } else {
      const department = departments.data?.find((row) => row.id === list.department_id);
      if (department) items.push({ label: department.name, href: "/tasks/lists" });
      const group = list.group_id ? groups.data?.find((row) => row.id === list.group_id) : undefined;
      if (group) items.push({ label: group.name });
    }

    const siblings = (lists.data ?? []).filter((row) =>
      list.owner_id !== null
        ? row.owner_id === list.owner_id
        : row.owner_id === null && row.department_id === list.department_id,
    );

    items.push({
      label: list.name,
      href: `/tasks?list=${list.id}`,
      // Only as the last crumb: on a task page the list is a way BACK, and a
      // menu there would hide the one click people expect from it.
      menu: title
        ? undefined
        : siblings.map((row) => ({ label: row.name, href: `/tasks?list=${row.id}`, current: row.id === list.id })),
    });
  }

  // No list (a cross-list view, a task filed nowhere) or not loaded yet: the
  // path-derived crumbs are as good as it gets.
  if (!list) return null;

  if (title) items.push({ label: title });

  return <BreadcrumbTrail items={items} />;
}
