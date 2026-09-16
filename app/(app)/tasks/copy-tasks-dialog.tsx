"use client";

import { useEffect, useState, useTransition } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";

import { copyTasks, selectionTargets } from "./actions";
import { COPY_DEFAULTS, COPY_PARTS, type CopyPart } from "@/lib/schemas/tasks";

import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/**
 * P7-69 — copy the selection into another list.
 *
 * ⚠️ IT IS ALSO "DUPLICATE", AND THERE IS NO SECOND BUTTON. Duplicating is
 * copying into the list you are already in — the same dialog with the target
 * left alone. A separate action would be the same code behind a second word,
 * and a bar of near-synonyms is how people stop reading one.
 *
 * ⚠️ THE OPTIONS ARE AN OPINION, NOT A FORM TO FILL IN. The defaults say what
 * a copy is usually for — same procedure, next cycle — so the brief, the
 * priority, the estimate and the checklist come along, and the assignees, dates
 * and subtasks do not. Somebody copying a monthly audit wants the nineteen
 * steps and emphatically does not want last month's due date, which would
 * arrive already overdue.
 */
const PART_LABELS: Record<CopyPart, { label: string; hint: string }> = {
  description: { label: "Brief", hint: "The description of the work" },
  priority: { label: "Priority", hint: "" },
  estimate: { label: "Estimate", hint: "" },
  checklist: { label: "Checklist", hint: "Steps come across unticked" },
  assignees: { label: "Assignees", hint: "The PIC and anyone else on it" },
  dates: { label: "Start and due dates", hint: "Usually belong to the old cycle" },
  subtasks: { label: "Subtasks", hint: "Titles only, unassigned" },
};

export function CopyTasksDialog({
  open,
  onOpenChange,
  taskIds,
  onCopied,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taskIds: string[];
  onCopied: () => void;
}) {
  const [listId, setListId] = useState<string | null>(null);
  const [include, setInclude] = useState<CopyPart[]>(COPY_DEFAULTS);
  const [lists, setLists] = useState<{ id: string; name: string }[] | null>(null);
  const [spans, setSpans] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pending, start] = useTransition();

  /*
   * ⚠️ THE TARGETS ARE FETCHED WHEN THE DIALOG OPENS, not held by the page. The
   * lists live inside the page's Suspense boundary and this bar deliberately
   * sits outside it, so threading them down would drag the selection context
   * inside the boundary — which is the one thing its own comment says must not
   * happen.
   *
   * Re-fetched per opening rather than cached: a list created in another tab
   * between two copies should be there the second time.
   */
  useEffect(() => {
    if (!open) return;

    let live = true;
    setLists(null);

    void selectionTargets(taskIds).then((result) => {
      if (!live) return;

      if (!result.ok) {
        toast.error(result.error);
        onOpenChange(false);
        return;
      }

      setLists(result.data.lists);
      setSpans(result.data.spans);
    });

    return () => {
      live = false;
    };
  }, [open, taskIds, onOpenChange]);

  function toggle(part: CopyPart) {
    setInclude((current) =>
      current.includes(part) ? current.filter((one) => one !== part) : [...current, part],
    );
  }

  function submit() {
    start(async () => {
      const result = await copyTasks(taskIds, { listId, include });

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      const { copied, failed, firstError } = result.data;

      /*
       * Both halves, per outcome rather than per attempt — the same rule the
       * delete path follows. A run where five of seven landed is not "Copied".
       */
      if (copied > 0) toast.success(`${copied} ${copied === 1 ? "task" : "tasks"} copied`);
      if (failed > 0) toast.error(firstError ?? `${failed} could not be copied.`);

      onOpenChange(false);
      onCopied();
    });
  }

  const count = taskIds.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Copy {count} {count === 1 ? "task" : "tasks"}
          </DialogTitle>
          <DialogDescription>
            Each one becomes a new task, open and unstarted. The original is untouched.
          </DialogDescription>
        </DialogHeader>

        {spans ? (
          /*
           * Said up front rather than discovered after picking. A copy stays in
           * its own department — see the migration — so a selection crossing two
           * has no single set of targets.
           */
          <p className="rounded-md border border-warning-border bg-warning-subtle p-3 text-xs text-warning">
            These tasks are in different departments. A task can only be copied into a list in its
            own department, so pick tasks from one department at a time.
          </p>
        ) : (
          <>
            <div className="space-y-1.5">
              <Label>Into which list</Label>

              {lists === null ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  Finding the lists…
                </p>
              ) : (
                /*
                 * A combobox: the trigger shows the choice, the dropdown does
                 * the searching. `Select` already works inside this dialog, so
                 * the popover does too — the nesting that broke the image
                 * lightbox (P7-67) was a dialog inside a POPOVER, which is the
                 * other way round and the direction that unmounts.
                 *
                 * `CommandList` brings its own max height and scrolls, so a
                 * department with forty lists stays one trigger tall.
                 */
                <Popover open={picking} onOpenChange={setPicking}>
                  <PopoverTrigger
                    className={cn(
                      buttonVariants({ variant: "outline" }),
                      "w-full justify-between font-normal",
                      !listId && "text-muted-foreground",
                    )}>
                    {lists.find((list) => list.id === listId)?.name ?? "Choose a list"}
                    <ChevronsUpDown className="size-3.5 opacity-60" aria-hidden />
                  </PopoverTrigger>

                  <PopoverContent align="start" className="w-80 p-0">
                    <Command>
                      <CommandInput placeholder="Search lists" />
                      <CommandList className="max-h-56">
                        <CommandEmpty>No list matches that.</CommandEmpty>

                        {lists.map((list) => (
                          <CommandItem
                            key={list.id}
                            /* The NAME, not the id — `Command` filters on this
                               value, and filtering a uuid against what somebody
                               typed matches nothing. */
                            value={list.name}
                            onSelect={() => {
                              setListId(list.id);
                              setPicking(false);
                            }}>
                            <Check
                              aria-hidden
                              className={cn(
                                "size-3.5",
                                listId === list.id ? "opacity-100" : "opacity-0",
                              )}
                            />
                            {list.name}
                          </CommandItem>
                        ))}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
              )}

              {lists !== null && lists.length === 0 ? (
                <p className="text-2xs text-warning">
                  This department has no lists yet, so there is nowhere to copy to.
                </p>
              ) : (
                <p className="text-2xs text-muted-foreground">
                  Pick the list it is already in to duplicate it — the copy is named “(copy)” so
                  the two can be told apart.
                </p>
              )}
            </div>

            <fieldset className="space-y-2">
              <legend className="text-xs font-medium">What to bring across</legend>

              {COPY_PARTS.map((part) => (
                <label key={part} className="flex items-start gap-2 text-sm">
                  <Checkbox
                    checked={include.includes(part)}
                    onCheckedChange={() => toggle(part)}
                    className="mt-0.5"
                  />
                  <span>
                    {PART_LABELS[part].label}
                    {PART_LABELS[part].hint ? (
                      <span className="block text-2xs text-muted-foreground">
                        {PART_LABELS[part].hint}
                      </span>
                    ) : null}
                  </span>
                </label>
              ))}

              {/* Stated, because their absence is a decision rather than an
                  oversight — and somebody will look for them. */}
              <p className="text-2xs text-muted-foreground">
                Files and comments never come across: they belong to the task they were put on.
                Status always starts at Open.
              </p>
            </fieldset>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          {/* Disabled until there is somewhere to copy TO — and never the only
              explanation for it, which is what the placeholder above is for. */}
          <Button onClick={submit} loading={pending} disabled={spans || lists === null || !listId}>
            Copy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
