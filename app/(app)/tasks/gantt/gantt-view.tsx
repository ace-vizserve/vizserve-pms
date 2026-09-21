"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ListFilter } from "lucide-react";

import {
  GanttCreateMarkerTrigger,
  GanttFeatureItem,
  GanttFeatureList,
  GanttFeatureListGroup,
  GanttHeader,
  GanttProvider,
  GanttSidebar,
  GanttSidebarGroup,
  GanttSidebarItem,
  GanttTimeline,
  GanttToday,
  type GanttFeature,
  type Range,
} from "@/components/kibo-ui/gantt";
import { TASK_STATUS_ICONS } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import type { VizservePmsTaskStatus } from "@/lib/database.types";
import { parseDateOnly, toAppDateString } from "@/lib/dates";
import { TASK_STATUSES, TASK_STATUS_LABELS } from "@/lib/schemas/tasks";

import { updateTaskField } from "../actions";

/** The columns the page hands down. A narrower read than the list view's. */
export type GanttTask = {
  id: string;
  title: string;
  status: VizservePmsTaskStatus;
  start_date: string | null;
  due_date: string | null;
};

/**
 * The bar fill per stage — `--gantt-bar-*`, declared and measured in
 * app/globals.css.
 *
 * ⚠️ THIS MAP HOLDS TOKEN NAMES, NEVER HEXES. Kibo writes `GanttStatus.color`
 * straight into `backgroundColor`, so it has to be a real CSS colour rather
 * than a Tailwind class — and a `var()` is one. Going through the variables is
 * also what makes the bars follow the theme: every token here is redefined
 * under the dark selector, and a copied `#6b34c9` would not be.
 *
 * ⚠️ NOT THE `--stage-*` SOLIDS. Those are tuned to be READ AS TEXT on a pale
 * subtle fill, so they are dark and low-chroma; as bar fills they gave the
 * timeline the colour of a filing cabinet. `--gantt-bar-*` is the same eight
 * hues at full strength, and it exists for this view alone.
 *
 * ⚠️ Still the same eight stage FAMILIES as `TASK_STATUS_TONES` in
 * components/status-badge.tsx (P11-14) — a bar and its chip must not disagree
 * about which hue a stage is.
 */
const STAGE_BAR: Record<VizservePmsTaskStatus, { fill: string; ink: string }> = {
  OPEN: { fill: "var(--gantt-bar-open)", ink: "var(--gantt-bar-open-ink)" },
  ONGOING: { fill: "var(--gantt-bar-ongoing)", ink: "var(--gantt-bar-ongoing-ink)" },
  WAITING_FOR_INFO: { fill: "var(--gantt-bar-waiting)", ink: "var(--gantt-bar-waiting-ink)" },
  FOR_QA: { fill: "var(--gantt-bar-qa)", ink: "var(--gantt-bar-qa-ink)" },
  QA_IN_PROGRESS: { fill: "var(--gantt-bar-qa-deep)", ink: "var(--gantt-bar-qa-deep-ink)" },
  FOR_CLIENT_APPROVAL: { fill: "var(--gantt-bar-client)", ink: "var(--gantt-bar-client-ink)" },
  COMPLETED: { fill: "var(--gantt-bar-completed)", ink: "var(--gantt-bar-completed-ink)" },
  COMPLETED_NO_RESPONSE: { fill: "var(--gantt-bar-lapsed)", ink: "var(--gantt-bar-lapsed-ink)" },
};

const RANGES = [
  { value: "daily", label: "Day" },
  { value: "monthly", label: "Month" },
  { value: "quarterly", label: "Quarter" },
] as const;

/**
 * ⚠️ A BAR IS A START AND AN END, AND A TASK IS NOT REQUIRED TO HAVE BOTH.
 *
 * `start_date` and `due_date` are both nullable on the row and in
 * `taskPatchSchema`, and only `createTaskSchema` requires them — so every task
 * made before P7-06, and every one patched to clear a date since, can reach
 * this page with nothing to draw. There is no third column to fall back on:
 * `vizserve_pms_tasks` has no `end_date` (the terminal `status` is the only
 * "finished" signal, and a stage is not a date).
 *
 * Dropping those rows silently is the trap the board's finished-column cap fell
 * into — a view that shows fewer things than exist and does not say so. They
 * are counted and named on screen instead, with the list view one click away,
 * because the list can show a task that has no dates and this cannot.
 */
function toFeature(task: GanttTask): GanttFeature | null {
  const startAt = task.start_date ? parseDateOnly(task.start_date) : null;
  const endAt = task.due_date ? parseDateOnly(task.due_date) : null;
  if (!startAt || !endAt) return null;

  /*
   * A due date before the start date would render as a bar of negative width —
   * the row vanishes and the data looks lost rather than wrong. Nothing stops
   * the pair being entered that way, so the bar is drawn as the single start
   * day and the list view remains the place the contradiction is legible.
   */
  return {
    id: task.id,
    name: task.title,
    startAt,
    endAt: endAt < startAt ? startAt : endAt,
    status: {
      id: task.status,
      name: TASK_STATUS_LABELS[task.status],
      color: STAGE_BAR[task.status].fill,
      // The bar's edge AND its label. Both are the stage's own solid, measured
      // at 4.5:1 or better on the fill beside it — see the note in globals.css.
      ink: STAGE_BAR[task.status].ink,
    },
  };
}

/*
 * ⚠️ NO CLIENT-SIDE "MAY THIS PERSON DRAG" PREDICATE, DELIBERATELY.
 *
 * The obvious move is to grey the bars out for people who may not reschedule,
 * and the obvious helper — `canAccessDepartment` — answers a DIFFERENT
 * question: it is true for a TEAM LEADER of a department, and P11-03 gave
 * editing to any active MEMBER of the task's department. Wiring it up here
 * would lock the timeline against most of the people entitled to use it, and
 * writing a second, parallel membership rule in the client is the scattered
 * `if (role === ...)` that CLAUDE.md rules out.
 *
 * So the gate stays where it is enforceable: RLS and the server action. A drag
 * the policy refuses comes back as an error that is shown and then re-read,
 * rather than as a bar that silently snaps back.
 */
export function TaskGanttView({
  tasks,
  listId,
}: {
  tasks: GanttTask[];
  listId: string | null;
}) {
  const router = useRouter();
  const [range, setRange] = useState<Range>("monthly");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  /*
   * THE STAGE FILTER, AND IT IS THIS VIEW'S ALONE — component state, not a URL
   * parameter, which is a deliberate break from `filters.tsx`.
   *
   * The house rule is "filters in the URL, for a bookmarkable view, and the
   * server does the work", and both halves fail here. The server has already
   * sent every task the policy allows and the grouping happens in this
   * component, so a round trip would buy nothing but a flash. More importantly
   * `VIEWS` in toolbar.tsx gives the LIST view `carries: null` — it carries
   * every parameter — so a `?status=` written here would follow somebody onto
   * a list that reads `status` as a single value, not a set. Two views, one
   * parameter name, two grammars: the URL would claim a filter the next screen
   * applies differently. Keeping it local is what makes "for the Gantt only"
   * true rather than merely intended.
   */
  const [hidden, setHidden] = useState<ReadonlySet<VizservePmsTaskStatus>>(() => new Set());

  const toggleStage = useCallback((status: VizservePmsTaskStatus) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const { grouped, undated, hiddenCount } = useMemo(() => {
    const undatedTasks: GanttTask[] = [];
    const byStatus = new Map<VizservePmsTaskStatus, GanttFeature[]>();
    let filteredOut = 0;

    for (const task of tasks) {
      if (hidden.has(task.status)) {
        filteredOut++;
        continue;
      }
      const feature = toFeature(task);
      if (!feature) {
        undatedTasks.push(task);
        continue;
      }
      const bucket = byStatus.get(task.status);
      if (bucket) bucket.push(feature);
      else byStatus.set(task.status, [feature]);
    }

    /*
     * Grouped by stage, in the enum's own order — the order the board's columns
     * and the status dropdown already use, so the three agree about what comes
     * after what.
     *
     * It also settles the colour question. Kibo draws a status as a bare dot in
     * the sidebar, and "state is never conveyed by colour alone" (CLAUDE.md)
     * would make that dot a bug on its own. Under a group heading that spells
     * the stage out, the dot is decoration on a label rather than the label.
     */
    return {
      grouped: TASK_STATUSES.map((status) => ({
        status,
        features: byStatus.get(status) ?? [],
      })).filter((group) => group.features.length > 0),
      undated: undatedTasks,
      hiddenCount: filteredOut,
    };
  }, [tasks, hidden]);

  /*
   * THE BOUNDARY. date-fns lives inside components/kibo-ui/** and stops there
   * (the eslint fence in eslint.config.mjs is what keeps that true), so the
   * `Date` the drag hands back is converted with lib/dates.ts and nothing else.
   *
   * `toAppDateString` formats in Asia/Manila, which is the answer to the
   * off-by-one `parseDateOnly`'s midday-UTC trick exists for: the bar was
   * positioned from a midday instant, and the day it lands on has to be read
   * back in the app's zone rather than the browser's.
   */
  const handleMove = useCallback(
    (id: string, startAt: Date, endAt: Date | null) => {
      const patch = {
        start_date: toAppDateString(startAt),
        due_date: toAppDateString(endAt ?? startAt),
      };

      startTransition(async () => {
        const result = await updateTaskField(id, patch);
        if (!result.ok) {
          setError(result.error ?? "That change could not be saved.");
          /* The bar has already moved in Kibo's own state, so the only honest
             way back is to re-read the row rather than leave the screen
             claiming a date the database refused. */
          router.refresh();
          return;
        }
        setError(null);
        router.refresh();
      });
    },
    [router],
  );

  const listQuery = listId ? `?list=${listId}` : "";
  const shownStages = TASK_STATUSES.length - hidden.size;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        {/* The real primitive, not a row of buttons: `Segmented` is a Base UI
            RadioGroup, so it brings arrow-key roving focus and announces itself
            as a radio group. Exactly one scale is always chosen, which is what
            a radio group means. */}
        <Segmented
          aria-label="Timeline scale"
          onValueChange={(value) => setRange((value ?? "monthly") as Range)}
          value={range}>
          {RANGES.map((option) => (
            <SegmentedItem className="h-7 px-2.5" key={option.value} value={option.value}>
              {option.label}
            </SegmentedItem>
          ))}
        </Segmented>

        {/* Stage filter. A checkbox menu rather than eight chips: eight chips is
            a second toolbar, and the set is stable enough to live behind one
            control that always states how much it is hiding. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" variant="outline">
                <ListFilter />
                {hidden.size === 0 ? "All stages" : `${shownStages} of ${TASK_STATUSES.length} stages`}
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="w-60">
            {/* ⚠️ THE GROUP IS REQUIRED, NOT DECORATION. `DropdownMenuLabel` is
                Base UI's `Menu.GroupLabel`, which reads a context only
                `Menu.Group` provides — rendering it bare throws
                "MenuGroupContext is missing" and takes the menu down with it. */}
            <DropdownMenuGroup>
              <DropdownMenuLabel>Stages on the timeline</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {TASK_STATUSES.map((status) => {
                const Icon = TASK_STATUS_ICONS[status];
                return (
                  <DropdownMenuCheckboxItem
                    checked={!hidden.has(status)}
                    key={status}
                    onCheckedChange={() => toggleStage(status)}>
                    {/* The glyph, not a colour swatch. A coloured square in a
                        menu would be state carried by colour alone; the stage's
                        own lucide icon is the one its chip already uses. */}
                    <Icon aria-hidden className="size-4 text-muted-foreground" />
                    {TASK_STATUS_LABELS[status]}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuGroup>
            {hidden.size > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => setHidden(new Set())}>Show every stage</DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>

        <p aria-live="polite" className="min-w-0 text-xs text-muted-foreground">
          Drag a bar to reschedule, or drag its edge to change the span.
          {pending ? " Saving…" : ""}
        </p>
      </div>

      {error ? (
        <p
          className="shrink-0 rounded-md border border-destructive-border bg-destructive-subtle px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      {/*
        The tasks this view cannot draw, named rather than dropped. The count is
        the whole point — "3 tasks are not shown" is a fact somebody can act on,
        and an empty stretch of timeline is not.
      */}
      {undated.length > 0 ? (
        <p className="shrink-0 text-xs text-muted-foreground">
          {undated.length} {undated.length === 1 ? "task has" : "tasks have"} no start or due date and
          cannot be placed on a timeline.{" "}
          <Link className="underline underline-offset-2" href={`/tasks${listQuery}`}>
            Open the list view
          </Link>{" "}
          to give {undated.length === 1 ? "it" : "them"} dates.
        </p>
      ) : null}

      {grouped.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border p-8 text-center">
          {/* The copy says WHY it is empty and what to do next, and the three
              reasons are genuinely different problems. */}
          <p className="text-sm text-muted-foreground">
            {hiddenCount > 0
              ? `No stages left to draw — the stage filter is hiding ${hiddenCount} ${hiddenCount === 1 ? "task" : "tasks"}.`
              : tasks.length === 0
                ? "No tasks here yet."
                : "Nothing to place on the timeline — no task here has both a start and a due date."}
          </p>
          {hiddenCount > 0 ? (
            <Button onClick={() => setHidden(new Set())} size="sm" variant="outline">
              Show every stage
            </Button>
          ) : null}
        </div>
      ) : (
        /*
         * ⚠️ THE WRAPPER IS LOAD-BEARING — it is what keeps the horizontal
         * scrollbar on screen.
         *
         * Kibo's root is `h-full w-full overflow-auto`, and `height: 100%`
         * against a flex item whose height is only resolved BY the flex pass
         * falls back to auto: the box grows to fit every row, the page itself
         * scrolls, and the horizontal scrollbar goes wherever the bottom of the
         * content is — which on a long list means scrolling all the way down
         * before you can scroll sideways.
         *
         * A `relative` parent plus `absolute inset-0` gives the scroll box a
         * height that does not depend on its content, so it is always exactly
         * the visible area and its scrollbar is always at the bottom of the
         * screen. `flex-1 min-h-0` on the parent is what sizes that area.
         */
        <div className="relative min-h-0 flex-1">
          <GanttProvider className="absolute inset-0 rounded-lg border border-border" range={range} zoom={100}>
            <GanttSidebar>
              {grouped.map((group) => (
                <GanttSidebarGroup key={group.status} name={TASK_STATUS_LABELS[group.status]}>
                  {group.features.map((feature) => (
                    <GanttSidebarItem
                      feature={feature}
                      key={feature.id}
                      onSelectItem={(id) => router.push(`/tasks/${id}`)}
                    />
                  ))}
                </GanttSidebarGroup>
              ))}
            </GanttSidebar>

            <GanttTimeline>
              <GanttHeader />
              <GanttFeatureList>
                {grouped.map((group) => (
                  <GanttFeatureListGroup key={group.status}>
                    {group.features.map((feature) => (
                      <GanttFeatureItem key={feature.id} {...feature} onMove={handleMove}>
                        {/* The bar's own label, in the one ink every bar carries.
                            `--gantt-bar-ink` is white in light and near-black in
                            dark, and every fill was measured to clear 4.5:1
                            against it — see the note in globals.css. `truncate`
                            rather than wrap: a bar is as wide as its dates and
                            must not grow its row. */}
                        <Link
                          className="flex-1 truncate text-xs font-[550]"
                          href={`/tasks/${feature.id}`}
                          onClick={(event) => event.stopPropagation()}
                          // Inherit the ink the BAR set, so the label can never
                          // name a colour its own fill was not measured against.
                          style={{ color: "inherit" }}
                        >
                          {feature.name}
                        </Link>
                      </GanttFeatureItem>
                    ))}
                  </GanttFeatureListGroup>
                ))}
              </GanttFeatureList>
              {/* Today's line, and the marker trigger that lets somebody drop a
                  reference point on the axis. Markers are view-local by design —
                  nothing here writes one to the database. */}
              <GanttToday />
              <GanttCreateMarkerTrigger onCreateMarker={() => undefined} />
            </GanttTimeline>
          </GanttProvider>
        </div>
      )}
    </div>
  );
}
