"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Search, UserPlus, X } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

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
 * Grouped the way the reference groups it — who is already on the task, then
 * everybody who could be. Somebody already on it is shown TICKED rather than
 * filtered out of the list, because a name missing from a picker reads as "not
 * allowed" when the answer is "already there".
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
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const onTask = useMemo(
    () => new Set([pic?.id, ...others.map((person) => person.id)].filter(Boolean) as string[]),
    [pic, others],
  );

  const available = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return candidates
      .filter((person) => !onTask.has(person.id))
      .filter((person) => !needle || person.full_name.toLowerCase().includes(needle));
  }, [candidates, onTask, query]);

  const assigned = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = [
      ...(pic ? [{ ...pic, isPic: showPic }] : []),
      ...others.map((p) => ({ ...p, isPic: false })),
    ];
    return all.filter((person) => !needle || person.full_name.toLowerCase().includes(needle));
  }, [pic, others, query, showPic]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "That did not go through.");
        return;
      }
      toast.success(success);
      router.refresh();
    });
  }

  const trigger = (
    <span className="inline-flex items-center">
      {pic ? (
        <Monogram
          id={pic.id}
          name={pic.full_name}
          // No "person in charge" on an internal task — there isn't one, and a
          // tooltip is not the place to invent a rank.
          label={showPic ? `${pic.full_name} — person in charge` : pic.full_name}
        />
      ) : null}
      {others.slice(0, 2).map((person, index) => (
        <Monogram
          key={person.id}
          id={person.id}
          name={person.full_name}
          // Overlapped, with a surface ring so two tiles never read as one shape.
          className={cn("ring-2 ring-card", pic || index > 0 ? "-ml-1.5" : undefined)}
        />
      ))}
      {others.length > 2 ? (
        <span className="-ml-1.5 flex size-6 shrink-0 items-center justify-center rounded-full border bg-muted text-2xs font-semibold tabular-nums text-muted-foreground ring-2 ring-card">
          +{others.length - 2}
        </span>
      ) : null}
      {!pic && others.length === 0 ? (
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
      <PopoverTrigger
        disabled={pending}
        aria-label={
          pic || others.length
            ? `Assignees: ${[pic?.full_name, ...others.map((p) => p.full_name)].filter(Boolean).join(", ")}. Change them.`
            : "Unassigned. Add somebody."
        }
        className={cn(
          "rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {trigger}
      </PopoverTrigger>

      <PopoverContent align={align} className="w-64 p-0">
        <div className="border-b p-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              autoFocus
              value={query}
              placeholder="Search people"
              aria-label="Search people"
              onChange={(event) => setQuery(event.target.value)}
              className="h-8 pl-7 text-xs"
            />
          </div>
        </div>

        <div className="max-h-72 overflow-y-auto py-1">
          {assigned.length > 0 ? (
            <>
              <p className={GROUP}>Assignees</p>
              {assigned.map((person) => (
                <div key={person.id} className={cn(ROW, "cursor-default")}>
                  <Monogram id={person.id} name={person.full_name} />
                  <span className="min-w-0 flex-1 truncate font-medium">{person.full_name}</span>

                  {person.isPic ? (
                    // The word, not a tint. Removing the accountable name is a
                    // reassignment and does not belong in this control.
                    //
                    // P7-43: reached only on a CLIENT task. On an internal one
                    // `showPic` is false, this branch never runs, and the same
                    // person gets the remove button below like everybody else.
                    <span className="shrink-0 text-2xs text-muted-foreground">PIC</span>
                  ) : (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        run(
                          () => removeTaskAssignee(taskId, person.id),
                          `${person.full_name} is no longer on this task`,
                        )
                      }
                      aria-label={`Remove ${person.full_name} from this task`}
                      className="shrink-0 rounded-sm p-1 text-muted-foreground hover:bg-destructive-subtle hover:text-destructive disabled:opacity-50"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  )}
                </div>
              ))}
            </>
          ) : null}

          <p className={GROUP}>People</p>

          {candidates.length === 0 ? (
            <p className="px-3 py-1.5 text-2xs text-muted-foreground">
              Nobody else in this task&rsquo;s department.
            </p>
          ) : available.length === 0 ? (
            <p className="px-3 py-1.5 text-2xs text-muted-foreground">
              {query.trim() ? "Nobody by that name." : "Everybody is already on this task."}
            </p>
          ) : (
            available.map((person) => (
              <button
                key={person.id}
                type="button"
                disabled={pending}
                onClick={() =>
                  run(
                    () => addTaskAssignee(taskId, person.id),
                    `${person.full_name} added to this task`,
                  )
                }
                className={cn(ROW, "hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none")}
              >
                <Monogram id={person.id} name={person.full_name} />
                <span className="min-w-0 flex-1 truncate text-left">{person.full_name}</span>
                <Check className="size-3.5 shrink-0 opacity-0" aria-hidden />
              </button>
            ))
          )}
        </div>

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
