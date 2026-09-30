"use client";

import type { ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpDown, ListFilter, User, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TASK_STATUS_OPTIONS } from "@/components/status-badge";
import { browserClient } from "@/lib/query/browser-client";
import { fetchDirectory } from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS } from "@/lib/schemas/tasks";
import { FIELD_KEY_PREFIX, fieldKey, type ListField } from "@/lib/schemas/list-fields";
import { DUE_FILTER_LABELS, PERSON_ROLE_LABELS, type DueFilter, type PersonRole } from "@/lib/task-extra-filters";

import { StackedField, TaskPersonDueFilters, TaskSearch } from "./extra-filters";
import { FieldFilter } from "./field-filters";

const ALL = "__all__";

/**
 * Filters in the URL, not in component state — the same reasoning as the
 * requests list: a bookmarkable, sendable view, and the server does the work.
 *
 * THE SCOPE TABS ARE NO LONGER HERE. All / Mine / Waiting on my QA moved to
 * `toolbar.tsx`, which renders on the board as well — the board has always read
 * `?view=`, and while the tabs lived inside this panel it had no way to set it.
 * What is left here is the pair of filters that genuinely only narrow a LIST:
 * status is a grouping on the board, and a list filter is a column it does not
 * draw.
 *
 * ONE TOOLBAR ROW, THE WAY CLICKUP DOES IT. This was a card of up to nine
 * labelled selects, always open, wrapping to three rows on a laptop. Search,
 * "Me" and sort stay in the bar; everything else is behind one Filter button
 * that counts what is applied, and each applied filter shows as a removable
 * chip underneath — so a narrowed list never reads as the whole list with the
 * popover closed.
 */
export function TaskFilters({
  lists,
  groups,
  customFields = [],
  trailing,
}: {
  lists: { id: string; name: string; group_id: string | null }[];
  groups: { id: string; name: string }[];
  /** P7-73. The selected list's active custom fields; empty without a list. */
  customFields?: ListField[];
  /** Right-aligned in the same row — the column menu and field manager. */
  trailing?: ReactNode;
}) {
  const router = useRouter();
  const params = useSearchParams();

  // Base UI's Select emits `string | null` on clear, where Radix emitted "".
  // The falsy branch below already handles both.
  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === ALL) next.delete(key);
    else next.set(key, value);

    /*
     * P7-18 — FOLDER AND LIST CLEAR EACH OTHER.
     *
     * `?group=A&list=B` where B is not in A is a URL claiming two filters that
     * cannot both hold; the server applies both and returns nothing, which reads
     * as "no tasks" rather than as "these filters contradict". Picking either one
     * drops the other, so the panel can only ever express one narrowing.
     */
    if (key === "group") next.delete("list");
    if (key === "list") next.delete("group");

    /*
     * P7-73 — A CUSTOM FIELD FILTER OR SORT BELONGS TO ONE LIST. Changing the
     * list (or the folder, which clears it) leaves every `cf:` key naming a field
     * the new list does not have — ignored by the page, but still in a URL
     * somebody bookmarks. Dropped here so the URL says what is applied.
     */
    if (key === "group" || key === "list") {
      for (const name of [...next.keys()]) {
        if (name.startsWith(FIELD_KEY_PREFIX)) next.delete(name);
      }
      if (next.get("sort")?.startsWith(FIELD_KEY_PREFIX)) {
        next.delete("sort");
        next.delete("dir");
      }
    }

    router.push(`/tasks?${next.toString()}`);
  }

  /*
   * SORT AND DIRECTION MOVE TOGETHER, because the server now takes the
   * direction from `?dir=` and from nothing else.
   *
   * `priority` is a Postgres enum declared LOW → HIGH, so highest-first IS
   * `dir=desc` — and the page used to infer that from the column name, which is
   * exactly what let a header's arrow disagree with the rows it sat over.
   * Choosing Priority has to say it out loud now, or the list would open on the
   * least urgent work.
   *
   * `due` is the default and reads ascending, so it CLEARS both rather than
   * pinning them: a URL that says `?sort=due` claims a choice somebody did not
   * make, and it survives every later filter change.
   */
  function setSort(value: string | null) {
    const next = new URLSearchParams(params.toString());
    if (!value || value === "due") {
      next.delete("sort");
      next.delete("dir");
    } else {
      next.set("sort", value);
      if (value === "priority") next.set("dir", "desc");
      else next.delete("dir");
    }
    router.push(`/tasks?${next.toString()}`);
  }

  /*
   * J — the priority filter, and the sort that stops the column being decoration.
   *
   * Highest first, unlike `TASK_PRIORITIES` itself: that constant is declared
   * low→high because Postgres compares enums by declaration order and every sort
   * in the app depends on it, while a person reading a picker scans from the most
   * severe down.
   *
   * "No priority" is a real option rather than an omission — it is what most
   * tasks are, and "show me the unranked backlog" is a question worth asking.
   * It is `none`, not an empty string, because an empty string is how this Select
   * says "cleared".
   */
  const priorityItems: Record<string, string> = {
    [ALL]: "Any priority",
    ...Object.fromEntries(
      [...TASK_PRIORITIES].reverse().map((value) => [value, TASK_PRIORITY_LABELS[value]]),
    ),
  };

  const sortItems: Record<string, string> = {
    due: "Due date",
    priority: "Priority",
    // P7-82. What the drag handle writes.
    manual: "Manual (drag)",
    // P7-73. Without these the trigger would print `cf:<uuid>` after a header
    // click on a custom column — the raw-value trap in the note below.
    ...Object.fromEntries(customFields.map((field) => [fieldKey(field.id), field.name])),
  };

  // Base UI renders the RAW VALUE in <SelectValue> unless the root is handed an
  // items map. Without these the Status filter showed the literal "__all__"
  // sentinel on screen, and every other option showed its enum rather than its
  // label. inbox-filters.tsx and dtr-toolbar.tsx already did this; these two
  // were simply missed.
  const statusItems: Record<string, string> = {
    [ALL]: "All statuses",
    ...Object.fromEntries(TASK_STATUS_OPTIONS.map((option) => [option.value, option.label])),
  };
  const activeGroup = params.get("group");

  // Narrowed to the chosen folder, so the two pickers cannot be set to a pair
  // that returns nothing. With no folder chosen, every list is offered.
  const listsInScope = activeGroup
    ? lists.filter((list) => list.group_id === activeGroup)
    : lists;

  const listItems: Record<string, string> = {
    [ALL]: "All lists",
    ...Object.fromEntries(listsInScope.map((list) => [list.id, list.name])),
  };
  const groupItems: Record<string, string> = {
    [ALL]: "All folders",
    ...Object.fromEntries(groups.map((group) => [group.id, group.name])),
  };

  // ── what is applied ──────────────────────────────────────────────────────
  const people = useQuery({ queryKey: qk.ref("users"), queryFn: () => fetchDirectory(browserClient()) });
  const person = params.get("person");
  const personName =
    person === "me" ? "Me" : (people.data?.find((row) => row.id === person)?.full_name ?? "Someone");
  const role = params.get("role") as PersonRole | null;
  const activeFields = customFields.filter((field) => params.get(fieldKey(field.id)));

  /*
   * One chip per applied filter, each naming what it clears. The open list is
   * the PLACE, not a filter — it is in the breadcrumb — so it never gets one.
   */
  const chips: { key: string; label: string; clears: string[] }[] = [];
  const statusParam = params.get("status");
  if (statusParam) {
    chips.push({ key: "status", label: `Status: ${statusItems[statusParam] ?? statusParam}`, clears: ["status"] });
  }
  if (activeGroup) {
    chips.push({ key: "group", label: `Folder: ${groupItems[activeGroup] ?? "Unknown"}`, clears: ["group"] });
  }
  const priorityParam = params.get("priority");
  if (priorityParam) {
    chips.push({
      key: "priority",
      label: `Priority: ${priorityItems[priorityParam] ?? priorityParam}`,
      clears: ["priority"],
    });
  }
  if (person) {
    const as = role && role !== "any" ? ` (${PERSON_ROLE_LABELS[role] ?? role})` : "";
    chips.push({ key: "person", label: `Person: ${personName}${as}`, clears: ["person", "role"] });
  }
  const dueParam = params.get("due") as DueFilter | null;
  if (dueParam) chips.push({ key: "due", label: DUE_FILTER_LABELS[dueParam] ?? dueParam, clears: ["due"] });
  for (const field of activeFields) {
    chips.push({ key: fieldKey(field.id), label: `${field.name}: filtered`, clears: [fieldKey(field.id)] });
  }

  const hasFilters = chips.length > 0 || Boolean(params.get("q"));

  function clearKeys(keys: string[]) {
    const next = new URLSearchParams(params.toString());
    for (const key of keys) next.delete(key);
    router.push(`/tasks?${next.toString()}`);
  }

  // Clears the filters, not the place: the open list, scope, kind and sort stay.
  function clearAll() {
    clearKeys(["q", ...chips.flatMap((chip) => chip.clears)]);
  }

  const meOn = person === "me";

  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <TaskSearch bare className="w-full sm:w-64" />

        <Popover>
          <PopoverTrigger render={<Button variant={chips.length > 0 ? "secondary" : "outline"} size="sm" />}>
            <ListFilter />
            Filter
            {chips.length > 0 ? (
              <span className="rounded-sm bg-primary px-1.5 text-2xs font-medium text-primary-foreground tabular-nums">
                {chips.length}
                <span className="sr-only"> applied</span>
              </span>
            ) : null}
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="max-h-[min(36rem,var(--available-height))] w-[min(26rem,calc(100vw-2rem))] gap-0 overflow-y-auto p-0"
          >
            <div className="flex items-center justify-between border-b px-3 py-2">
              <span className="text-sm font-medium">Filters</span>
              {chips.length > 0 ? (
                <Button variant="link" size="xs" onClick={clearAll}>
                  Clear all
                </Button>
              ) : null}
            </div>

            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3">
              <StackedField id="status" label="Status">
                <Select
                  items={statusItems}
                  value={params.get("status") ?? ALL}
                  onValueChange={(value) => setParam("status", value)}
                >
                  <SelectTrigger id="status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All statuses</SelectItem>
                    {TASK_STATUS_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </StackedField>

              <StackedField id="priority" label="Priority">
                <Select
                  items={priorityItems}
                  value={params.get("priority") ?? ALL}
                  onValueChange={(value) => setParam("priority", value)}
                >
                  <SelectTrigger id="priority" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Any priority</SelectItem>
                    {[...TASK_PRIORITIES].reverse().map((value) => (
                      <SelectItem key={value} value={value}>
                        {TASK_PRIORITY_LABELS[value]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </StackedField>

              <TaskPersonDueFilters stacked />

              {groups.length > 0 ? (
                <StackedField id="group" label="Folder">
                  {/* `items` AND the children below. Base UI renders the raw value in
                      SelectValue without the map, which here would put the literal
                      "__all__" on screen. */}
                  <Select
                    items={groupItems}
                    value={activeGroup ?? ALL}
                    onValueChange={(value) => setParam("group", value)}
                  >
                    <SelectTrigger id="group" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All folders</SelectItem>
                      {groups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </StackedField>
              ) : null}

              {listsInScope.length > 0 ? (
                <StackedField id="list" label="List">
                  <Select
                    items={listItems}
                    value={params.get("list") ?? ALL}
                    onValueChange={(value) => setParam("list", value)}
                  >
                    <SelectTrigger id="list" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ALL}>All lists</SelectItem>
                      {listsInScope.map((list) => (
                        <SelectItem key={list.id} value={list.id}>
                          {list.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </StackedField>
              ) : null}
            </div>

            {/* P7-73 — the open list's custom fields, under their own heading
                rather than in a second popover. */}
            {customFields.length > 0 ? (
              <div className="space-y-3 border-t p-3">
                <span className="block text-xs font-medium text-muted-foreground">Custom fields</span>
                {customFields.map((field) => (
                  <FieldFilter
                    key={field.id}
                    field={field}
                    value={params.get(fieldKey(field.id))}
                    onChange={(next) => setParam(fieldKey(field.id), next)}
                  />
                ))}
              </div>
            ) : null}
          </PopoverContent>
        </Popover>

        {/* The filter people reach for all day, one click instead of three. */}
        <Button
          variant={meOn ? "secondary" : "outline"}
          size="sm"
          aria-pressed={meOn}
          onClick={() => {
            const next = new URLSearchParams(params.toString());
            if (meOn) {
              next.delete("person");
              next.delete("role");
            } else {
              next.set("person", "me");
            }
            router.push(`/tasks?${next.toString()}`);
          }}
        >
          <User />
          Me
        </Button>

        <Label htmlFor="sort" className="sr-only">
          Sort by
        </Label>
        <Select items={sortItems} value={params.get("sort") ?? "due"} onValueChange={setSort}>
          <SelectTrigger id="sort" size="sm" className="w-auto gap-1.5">
            <ArrowUpDown className="size-3.5 text-muted-foreground" aria-hidden />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="due">Due date</SelectItem>
            <SelectItem value="priority">Priority</SelectItem>
            {customFields.map((field) => (
              <SelectItem key={field.id} value={fieldKey(field.id)}>
                {field.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
      </div>

      {hasFilters ? (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Applied filters">
          {chips.map((chip) => (
            <li
              key={chip.key}
              className="inline-flex h-7 max-w-full items-center gap-1 rounded-sm border bg-card pr-0.5 pl-2 text-xs shadow-raised"
            >
              <span className="truncate">{chip.label}</span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${chip.label}`}
                onClick={() => clearKeys(chip.clears)}
              >
                <X />
              </Button>
            </li>
          ))}
          <li>
            <Button variant="link" size="xs" onClick={clearAll}>
              Clear all
            </Button>
          </li>
        </ul>
      ) : null}
    </div>
  );
}
