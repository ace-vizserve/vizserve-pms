"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useOptimistic, useState, useTransition } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Search, UserPlus, X } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { invalidateTaskWrite } from "@/lib/query/invalidate";

import { addTaskAssignee, removeTaskAssignee } from "./actions";

/**
 * P7-13 / K1 — several people on one task.
 *
 * `assignee_id` is the ACCOUNTABLE name and this does not edit it. It is the one
 * person the task is filed under, what the board sorts by, and what "assigned to
 * you" means in a notification. `vizserve_pms_task_assignees` underneath is who
 * is WORKING on it, and every one of them is a full participant: the SELECT and
 * UPDATE policies, `may_log_time` and the transition ownership guard all run
 * through `vizserve_pms_is_on_task`.
 *
 * The model shipped on 18 Aug — the join table, the helper, and the four policy
 * sites threaded through it — AND NOTHING EVER CALLED IT. Every screen still
 * showed one PIC, so a second assignee could not be added except through the API.
 * This is the screen it was missing.
 *
 * THE PIC IS SHOWN BUT NOT REMOVABLE HERE. Taking the accountable name off a task
 * is a reassignment: a different act, with its own control and its own department
 * rule (P7-14). It is also the one change that can leave a task with `assignee_id`
 * null and nobody on the join table, which is the state the UPDATE policy cannot
 * recover from — every clause of it is false, so nobody can put it right.
 */

export type Person = { id: string; full_name: string };

/**
 * A monogram, not a photo, and THE NAME IS A TOOLTIP ON IT.
 *
 * There are no avatars in this system and inventing a placeholder face for a
 * colleague is worse than two letters — but two letters are ambiguous the moment
 * two people share them, which is what the tooltip is for. It is the real
 * primitive rather than a native `title`: `title` waits about a second, renders
 * in the OS style, and never appears at all for a keyboard user. This one shows
 * on hover AND on focus, which is the half `title` cannot do.
 *
 * `TooltipProvider` wraps the whole authenticated area in `app/(app)/layout.tsx`,
 * so there is nothing to add per call site.
 *
 * The tint is derived from the user id so a person is the same colour
 * everywhere, and it is NEVER the only carrier: initials in the tile, the full
 * name in the tooltip AND in `sr-only` text, and the picker spells every name
 * out in full.
 */
export function Monogram({
  name,
  id,
  label,
  className,
}: {
  name: string;
  id: string;
  /** Overrides the tooltip text — "Amier Bautista — person in charge". */
  label?: string;
  className?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs font-semibold grade-chip shadow-raised",
              TINTS[tintFor(id)],
              className,
            )}
          />
        }
      >
        {initials(name)}
        {/* Read out instead of the initials, which are meaningless spoken. */}
        <span className="sr-only">{label ?? name}</span>
      </TooltipTrigger>
      <TooltipContent>{label ?? name}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The assignee cell: a stack of monograms that opens a searchable picker.
 *
 * Somebody already on the task is shown TICKED rather than filtered out of the
 * list, because a name missing from a picker reads as "not allowed" when the
 * answer is "already there".
 *
 * ⚠️ P11-12 — THE LIST DOES NOT MOVE AND NOTHING IS DISABLED WHILE IT SAVES.
 *
 * Two halves of one bug. Every row and the trigger itself carried
 * `disabled={pending}`, so one click froze the whole picker for a round trip —
 * and the row you had just pressed was the focused element, so disabling it
 * dropped focus to `<body>` and took the popover down with it. Meanwhile the
 * person you had added was filtered out of "People" and re-rendered in a group
 * above, which pulled every remaining row up by its own height. Adding three
 * people meant three round trips, three reopenings, and three chances to hit
 * the wrong name on the way back.
 *
 * So membership of the list comes from `candidates` — the department, which a
 * click does not change — and being on the task is a tick on a row that stays
 * where it is. Nothing mounts, unmounts or moves on a click: focus never leaves
 * the button, the popover cannot close underneath the pointer, and the clicks
 * queue instead of taking turns.
 */
export function AssigneePicker({
  taskId,
  pic,
  others,
  candidates,
  canEdit = true,
  showPic = true,
  align = "start",
}: {
  taskId: string;
  /** The accountable name. Null is a real state on an unassigned task. */
  pic: Person | null;
  /** Everyone on the join table, PIC excluded by the caller. */
  others: Person[];
  /** Who may be added — this task's own department, resolved server-side. */
  candidates: Person[];
  canEdit?: boolean;
  /**
   * P7-43 — whether this task HAS a person in charge.
   *
   * True on a CLIENT task, where somebody has to be answerable to the person who
   * filed the request. FALSE ON AN INTERNAL TASK, where the work belongs to the
   * team and everyone on it is an equal assignee.
   *
   * `pic` is still passed either way, because `assignee_id` is still set and
   * still means something to notifications, board ordering and both tasks
   * policies. What this decides is whether the SCREEN draws a rank the data no
   * longer claims: with it false, that person is listed and removable like
   * anyone else, and `vizserve_pms_remove_task_assignee` promotes the next
   * assignee into the column on the way out.
   */
  showPic?: boolean;
  align?: "start" | "center" | "end";
}) {
  const router = useRouter();
  /*
   * P12-06 — THE CACHE, AS WELL AS THE REFRESH. NOT INSTEAD OF IT.
   *
   * This control is shared: the detail header renders it, every list row renders
   * it and every board card renders it. `/tasks/[id]` reads `qk.task(id)` from
   * the cache now, so a write has to invalidate; `/tasks` and `/tasks/board`
   * still read their rows in an RSC, so the `router.refresh()` below stays until
   * Phase 3c. The precedent is `hooks/use-realtime-refresh.ts` (P12-02), which
   * invalidates AND refreshes for exactly this reason. Full account, including
   * what `ded2244` cost, in `lib/query/invalidate.ts`.
   */
  const queryClient = useQueryClient();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  /*
   * P11-05 — THE TICK MOVES ON THE CLICK.
   *
   * Adding somebody used to leave the picker unchanged for a round trip: the row
   * you had just pressed sat there unmarked, so the natural reading was that the
   * click had missed and the natural response was to press it again.
   *
   * WHO is on the task is optimistic; WHERE the row sits is not. The set is
   * carried as ids rather than people so that the person in charge belongs to it
   * on an internal task (P7-43), where they are removable like anybody else and
   * the tick has to clear on the click too.
   */
  const serverOnTask = useMemo(
    () => [...(pic ? [pic.id] : []), ...others.map((person) => person.id)],
    [pic, others],
  );

  const [onTaskIds, applyChange] = useOptimistic(
    serverOnTask,
    (state: string[], change: { person: Person; add: boolean }) =>
      change.add
        ? state.includes(change.person.id)
          ? state
          : [...state, change.person.id]
        : state.filter((id) => id !== change.person.id),
  );

  const onTask = useMemo(() => new Set(onTaskIds), [onTaskIds]);

  /** Every person this control can name, so an optimistic id resolves to a face. */
  const byId = useMemo(() => {
    const map = new Map<string, Person>();
    for (const person of [...(pic ? [pic] : []), ...others, ...candidates]) {
      map.set(person.id, person);
    }
    return map;
  }, [pic, others, candidates]);

  /*
   * THE LIST, and it is built from `candidates` — never from who is on the task.
   * That is the whole point: a click flips a tick and moves nothing, so the name
   * under the pointer is still the name under the pointer.
   *
   * `others` only contributes somebody the department list does not already
   * carry — an assignee who has since moved department, who still has to be
   * visible and removable rather than stranded on the row with no way off it.
   */
  const people = useMemo(() => {
    const seen = new Set<string>();
    const rows: Person[] = [];
    for (const person of [...candidates, ...(pic ? [pic] : []), ...others]) {
      // The person in charge of a CLIENT task is drawn above, not in the list:
      // they are not removable here, so a tick that cannot be cleared would be
      // a control that does nothing.
      if (showPic && person.id === pic?.id) continue;
      if (seen.has(person.id)) continue;
      seen.add(person.id);
      rows.push(person);
    }
    return rows;
  }, [candidates, others, pic, showPic]);

  /*
   * The search box takes focus on open, and THE PAGE DOES NOT MOVE.
   *
   * `autoFocus` is the wrong tool here: React calls `.focus()` for it with no
   * options, and a plain focus scrolls the element into view. The popup lives in
   * a portal on `<body>` and is placed a frame later, so "into view" is measured
   * against a box that is not where you can see it — the document scrolled and
   * the row you had just clicked went with it.
   *
   * A `useCallback` ref rather than an inline one: an inline callback ref is
   * torn down and re-run on EVERY render, so it would drag focus back off a row
   * you had tabbed to each time the list re-rendered. This one runs on mount.
   */
  const focusSearch = useCallback((node: HTMLInputElement | null) => {
    node?.focus({ preventScroll: true });
  }, []);

  const matches = useCallback(
    (person: Person) => {
      const needle = query.trim().toLowerCase();
      return !needle || person.full_name.toLowerCase().includes(needle);
    },
    [query],
  );

  const visible = useMemo(() => people.filter(matches), [people, matches]);

  /** The monogram stack, PIC first — optimistic, so a click shows immediately. */
  const stack = useMemo(
    () =>
      onTaskIds
        .filter((id) => id !== pic?.id)
        .map((id) => byId.get(id))
        .filter((person): person is Person => Boolean(person)),
    [onTaskIds, pic, byId],
  );

  const picOnTask = pic ? onTask.has(pic.id) : false;

  /*
   * ⚠️ THIS RETURNS BEFORE THE ROUND TRIP AND IS MEANT TO BE CALLED AGAIN.
   *
   * `startTransition` with an async body returns immediately, so a second click
   * starts a second transition rather than queueing behind the first, and React
   * holds BOTH optimistic changes until each one's own payload lands. That is
   * how three people go on to a task in three clicks instead of three waits —
   * and it only works because nothing in the picker is disabled while `pending`
   * is true.
   */
  function run(
    action: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
    change?: { person: Person; add: boolean },
  ) {
    startTransition(async () => {
      // Inside the transition, before the await: this is the paint. React drops
      // it if the action is refused, so there is no rollback to write.
      if (change) applyChange(change);

      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "That did not go through.");
        return;
      }
      /*
       * ⚠️ NOT A DUPLICATE ROUND TRIP — KEEPS THE TRANSITION PENDING UNTIL THE
       * FRESH DATA IS APPLIED. Without it `useOptimistic` reverts the instant the
       * action resolves and the value snaps back until the payload lands. Removed
       * once and restored (`a64b06c` → `ded2244`); P12-02 re-checked it against
       * Next 16's action queue and kept it. Full account in `tasks/inline.tsx`.
       */
      router.refresh();
      /*
       * ⚠️ AWAITED, INSIDE THE TRANSITION. `qk.task(id)` prefix-matches
       * `["task", id, "assignees"]`, so one call covers the seat and the row —
       * and the row matters, because `vizserve_pms_remove_task_assignee`
       * promotes the next assignee into `assignee_id` on the way out.
       *
       * ⚠️ AND THIS FUNCTION IS MEANT TO BE CALLED AGAIN BEFORE IT RETURNS. See
       * the note above: three clicks start three transitions, and each awaits
       * its own invalidation rather than queueing behind the last.
       */
      await invalidateTaskWrite(queryClient, taskId);
      toast.success(success);
    });
  }

  const trigger = (
    <span className="inline-flex items-center">
      {pic && picOnTask ? (
        <Monogram
          id={pic.id}
          name={pic.full_name}
          // No "person in charge" on an internal task — there isn't one, and a
          // tooltip is not the place to invent a rank.
          label={showPic ? `${pic.full_name} — person in charge` : pic.full_name}
        />
      ) : null}
      {stack.slice(0, 2).map((person, index) => (
        <Monogram
          key={person.id}
          id={person.id}
          name={person.full_name}
          // Overlapped, with a surface ring so two tiles never read as one shape.
          className={cn("ring-2 ring-card", picOnTask || index > 0 ? "-ml-1.5" : undefined)}
        />
      ))}
      {stack.length > 2 ? (
        <span className="-ml-1.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-2xs font-semibold tabular-nums text-muted-foreground ring-2 ring-card">
          +{stack.length - 2}
        </span>
      ) : null}
      {!picOnTask && stack.length === 0 ? (
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-full border border-dashed text-muted-foreground",
            canEdit && "hover:border-primary hover:text-foreground",
          )}
        >
          <UserPlus className="size-3" aria-hidden />
          <span className="sr-only">Unassigned</span>
        </span>
      ) : null}
    </span>
  );

  if (!canEdit) return trigger;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      {/* ⚠️ NOT `disabled={pending}`. Disabling the trigger of an OPEN popover
          pulls focus out of the popup, and Base UI closes on the way out — the
          picker vanished mid-click and the page jumped back to the restored
          focus. `aria-busy` says the same thing without taking the control
          away. */}
      <PopoverTrigger
        aria-busy={pending}
        aria-label={
          picOnTask || stack.length
            ? `Assignees: ${[picOnTask ? pic?.full_name : null, ...stack.map((p) => p.full_name)].filter(Boolean).join(", ")}. Change them.`
            : "Unassigned. Add somebody."
        }
        className="rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {trigger}
      </PopoverTrigger>

      {/* ⚠️ `initialFocus={false}` — WE FOCUS THE SEARCH BOX, BASE UI MUST NOT.
          Its default resolves to the first tabbable element in the popup, which
          IS this search box, and it focuses it WITHOUT `preventScroll`: that
          flag is only set when the thing being focused is the popup itself
          (`FloatingFocusManager`). The popup is portaled to `<body>`, so the
          browser scrolls the document to wherever it thinks that box is and the
          row you clicked leaves the screen. Returning focus on close already
          passes `preventScroll: true`, which is why only opening jumped. */}
      <PopoverContent align={align} className="w-64 p-0" initialFocus={false}>
        <div className="border-b p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              ref={focusSearch}
              value={query}
              placeholder="Search people"
              aria-label="Search people"
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>

        {/* ⚠️ ONE FORM AROUND THE WHOLE LIST. Every row is a submit button
            carrying its own `formAction`, so add and remove are real form
            actions with React owning the transition — without a form per row
            inside a scrolling list. */}
        <form className="max-h-72 overflow-y-auto py-1" aria-busy={pending}>
          {/* The accountable name on a CLIENT task, above the list and out of
              it. The word, not a tint: taking it off is a reassignment, a
              different act with its own control and its own department rule
              (P7-14). On an INTERNAL task `showPic` is false, this is skipped,
              and that person is a row in the list like everybody else (P7-43). */}
          {showPic && pic && matches(pic) ? (
            <>
              <p className={GROUP}>Person in charge</p>
              <div className={cn(ROW, "cursor-default")}>
                <Monogram id={pic.id} name={pic.full_name} />
                <span className="min-w-0 flex-1 truncate font-medium">{pic.full_name}</span>
                <span className="shrink-0 text-2xs text-muted-foreground">PIC</span>
              </div>
            </>
          ) : null}

          <p className={GROUP}>People</p>

          {people.length === 0 ? (
            <p className="px-3 py-1.5 text-2xs text-muted-foreground">
              Nobody else in this task&rsquo;s department.
            </p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-1.5 text-2xs text-muted-foreground">Nobody by that name.</p>
          ) : (
            visible.map((person) => {
              const on = onTask.has(person.id);
              return (
                /* One row, two directions. It is the SAME button whether the
                   person is on the task or not, so a click never unmounts the
                   element it landed on. */
                <button
                  key={person.id}
                  type="submit"
                  aria-pressed={on}
                  formAction={() =>
                    on
                      ? run(
                          () => removeTaskAssignee(taskId, person.id),
                          `${person.full_name} is no longer on this task`,
                          { person, add: false },
                        )
                      : run(
                          () => addTaskAssignee(taskId, person.id),
                          `${person.full_name} added to this task`,
                          { person, add: true },
                        )
                  }
                  className={cn(
                    ROW,
                    "group hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none",
                  )}
                >
                  <Monogram id={person.id} name={person.full_name} />
                  <span className={cn("min-w-0 flex-1 truncate text-left", on && "font-medium")}>
                    {person.full_name}
                  </span>
                  {/* A tick, not a tint — and it becomes the × that removes
                      them on hover or focus, so the way off the task is where
                      the way on to it was. Both are shapes; neither is the only
                      carrier, because `aria-pressed` states it outright. */}
                  <span className="relative size-3.5 shrink-0">
                    <Check
                      className={cn(
                        "absolute inset-0 size-3.5 text-primary",
                        on ? "group-hover:opacity-0 group-focus-visible:opacity-0" : "opacity-0",
                      )}
                      aria-hidden
                    />
                    {on ? (
                      <X
                        className="absolute inset-0 size-3.5 text-destructive opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                        aria-hidden
                      />
                    ) : null}
                  </span>
                </button>
              );
            })
          )}
        </form>

        <p className="border-t px-3 py-2 text-2xs text-muted-foreground">
          {/* Said plainly, because "anyone can move it" is a real change in who
              may direct whose work and people should not discover it. */}
          Everyone here can see the task, edit it, log time against it and move it.
        </p>
      </PopoverContent>
    </Popover>
  );
}

const GROUP = "px-3 py-1 text-2xs font-semibold tracking-wide text-muted-foreground uppercase";
const ROW = "flex w-full items-center gap-2 px-3 py-1.5 text-xs";

/** `Amier Bautista` → `AB`. Two letters, because three is a monogram. */
export function initials(name: string): string {
  return (
    name
      .split(/[\s@.]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

/**
 * A stable tint per person, from their id.
 *
 * Not the chart palette: these are identity marks on a 24px circle, not series
 * colours, and reusing the categorical ramp would make a person look like a
 * data series. Every one carries its initials and its name, so the hue is the
 * third carrier rather than the first.
 */
const TINTS = [
  "border-accent-border bg-accent text-accent-foreground",
  "border-info-border bg-info-subtle text-info",
  "border-success-border bg-success-subtle text-success",
  "border-warning-border bg-warning-subtle text-warning",
  "border-destructive-border bg-destructive-subtle text-destructive",
] as const;

function tintFor(id: string): number {
  // Sum of char codes — stable, cheap, and it does not matter that it is not
  // uniform: two colleagues sharing a tint still differ by their initials.
  let total = 0;
  for (let index = 0; index < id.length; index += 1) total += id.charCodeAt(index);
  return total % TINTS.length;
}
