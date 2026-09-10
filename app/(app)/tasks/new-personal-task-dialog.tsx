"use client";

import { useState, useTransition } from "react";
import { Plus } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import type { TaskPriority } from "@/lib/schemas/tasks";

import { createPersonalTask, createTask } from "./actions";
import { EstimateField } from "./estimate-field";
import { PriorityPicker } from "./priority-picker";
import { FieldError } from "@/components/ui/field-error";

/**
 * P7-01 / P7-14 — a member creates work.
 *
 * IT USED TO BE "for themselves only", and P7-14 changed that. A member may now
 * create work for a colleague in their OWN department, so this dialog has an
 * "Assign to" picker where before it had none.
 *
 * The picker does not weaken the rule it replaced. There is still no department
 * field: `vizserve_pms_create_task` resolves the caller's department from their
 * own row and refuses anything else, and the department id passed below is the
 * member's own, read on the server. What changed is who may hold the work, not
 * where the work may live.
 *
 * WHICH FUNCTION IT CALLS IS THE `is_personal` DECISION, and it is made once,
 * here, at creation:
 *
 *   assigned to me        → `createPersonalTask` → is_personal = true  → I close it
 *   assigned to somebody  → `createTask`         → is_personal = false → QA closes it
 *
 * ⚠️ THE PICKER TAKES SEVERAL PEOPLE (P7-13), AND THAT DOES NOT BLUR THE LINE
 * ABOVE — it decides it the same way, on ONE question: is anybody else on this.
 *
 *   just me                → personal, and it stays PRIVATE (P7-17)
 *   me and a colleague     → department work, me accountable, them beside me
 *   colleagues, not me     → department work, the first of them accountable
 *
 * Ticking yourself ALONGSIDE somebody else is therefore not a personal task
 * with a guest on it. `is_personal` is what keeps work out of the department's
 * sight, and work two people share is not work one of them can hide — so the
 * moment a second name appears, the task belongs to the department.
 *
 * `assignee_id` stays exactly one person either way, because the column is the
 * ACCOUNTABLE name and not a list. The rest become rows in
 * `vizserve_pms_task_assignees`, where every one of them is a full participant:
 * they can open it, edit it, log time against it and move it (P7-13a, P11-05).
 *
 * ⚠️ THE ADDS HAPPEN AFTER THE ROW EXISTS and are judged one at a time by
 * `vizserve_pms_add_task_assignee`, which P11-06 widened to any active member
 * of the task's own department — which is what makes "for Ace and Raiza, not
 * me" work at all from a member who is not on the task they just filed.
 *
 * That is not a derivation of `created_by = assignee_id` — which correction 1
 * ruled out, because a later reassignment would silently flip a task's category
 * and with it which moves are legal. It is a choice recorded in a column that
 * sits outside the UPDATE grant and can never change again.
 *
 * Still deliberately NOT `NewTaskDialog` with fields hidden. That dialog offers a
 * department, a QA reviewer and any department's people; this one offers exactly
 * what a member may choose. One dialog whose fields mean different things
 * depending on who opened it is how the rule underneath gets bent.
 */
export function NewPersonalTaskDialog({
  lists,
  defaultListId = null,
  colleagues,
  departmentId,
  selfId,
  trigger = "toolbar",
}: {
  /** The member's own department's lists. Optional — a task needs no list. */
  lists: { id: string; name: string }[];
  /**
   * The list the reader is already filtered to, from `?list=`. Pre-selected so
   * a task created while looking at a list lands IN that list — see the note in
   * `new-task-button.tsx` for the bug this fixes.
   */
  defaultListId?: string | null;
  /**
   * Active people in the member's own department, THEMSELVES EXCLUDED — "me" is
   * the default rather than an entry in the list, because picking yourself and
   * leaving it alone must not produce two different kinds of task.
   */
  colleagues: { id: string; full_name: string }[];
  /** The member's own department, read on the server. Never chosen here. */
  departmentId: string | null;
  /**
   * The reader's OWN user id, read on the server beside the department.
   *
   * Needed only since the picker took several people: "me and Ace" is a
   * department task with `assignee_id` set to me, and `createTask` wants a real
   * uuid there — the `MINE` sentinel below is a UI value and never leaves this
   * file. It is not a permission of any kind; `vizserve_pms_create_task` still
   * refuses an assignee outside the caller's own department, whoever is named.
   */
  selfId: string;
  /**
   * The SHAPE, never the permission — the same rule `new-task-button.tsx`
   * states. `quick` is the home page's action grid, where this sits beside five
   * outline links and has to look like the sixth rather than the only primary
   * button on the page.
   */
  trigger?: "toolbar" | "column" | "row" | "quick";
}) {
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  /*
   * ⚠️ NEVER EMPTY. `[MINE]` is the default and `onValueChange` puts it back
   * the moment the last tick comes off — a task with nobody on it is not a
   * state either create function will accept, so it is not a state the form is
   * allowed to reach. Unticking your way to nothing means "mine again", which
   * is the only reading that leaves the dialog submittable.
   */
  const [assignees, setAssignees] = useState<string[]>([MINE]);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  /*
   * Controlled, with an explicit hidden input, because this dialog submits
   * through a native `<form action={submit}>` and reads FormData. Base UI's
   * Select would emit its own hidden input from a `name`; one field emitted
   * twice is one `FormData.get()` silently taking whichever came first.
   */
  /*
   * ⚠️ ONLY IF IT IS ACTUALLY ONE OF THE OPTIONS. `?list=` is a URL somebody
   * can type, and a member's own department may not contain it —
   * `vizserve_pms_create_personal_task` RAISES on a list belonging to another
   * department, so pre-selecting one blindly would turn a mistyped URL into a
   * dialog that cannot be submitted at all. Falling back to "No list" keeps a
   * bad parameter to a missing convenience rather than a broken form.
   */
  const [listId, setListId] = useState(
    defaultListId && lists.some((list) => list.id === defaultListId) ? defaultListId : NO_LIST,
  );
  /*
   * P7-56 — the notes are a rich-text editor now, which has no form value of
   * its own, so it joins the controlled-state-plus-hidden-input arrangement
   * the paragraph above describes.
   */
  const [description, setDescription] = useState("");
  // Optional on this dialog, so both start empty and stay clearable.
  const [startDate, setStartDate] = useState<string | null>(null);
  const [dueDate, setDueDate] = useState<string | null>(null);

  // Annotated, not inferred: a computed key narrows the literal to `__mine__`
  // alone, so looking a colleague's id up in it is an error rather than a miss.
  const assigneeItems: Record<string, string> = {
    [MINE]: "Myself",
    ...Object.fromEntries(colleagues.map((person) => [person.id, person.full_name])),
  };

  /**
   * "Ace Guevarra", "Ace Guevarra and Raiza Mondina", "you and 3 others".
   *
   * Spelled out rather than counted while it fits, because "3 people" in a
   * confirmation is not something anybody can check. Past two names it is the
   * count, since a toast that wraps to three lines is read by nobody.
   */
  function nameList(ids: string[], withMe: boolean) {
    const names = ids.map((id) => assigneeItems[id] ?? "somebody");
    const all = withMe ? ["you", ...names] : names;

    if (all.length === 1) return all[0]!;
    if (all.length === 2) return `${all[0]} and ${all[1]}`;
    return `${all[0]} and ${all.length - 1} others`;
  }
  const listItems = {
    [NO_LIST]: "No list",
    ...Object.fromEntries(lists.map((list) => [list.id, list.name])),
  };
  const [pending, startTransition] = useTransition();

  /** Offering the picker at all needs both a department and somebody in it. */
  const canAssign = colleagues.length > 0 && departmentId !== null;
  /** Everybody ticked who is not the reader, in the order the list offers them. */
  const chosenColleagues = canAssign ? assignees.filter((id) => id !== MINE) : [];
  const includesMe = !canAssign || assignees.includes(MINE);
  /*
   * The whole branch, in one line: is there a second name on this.
   *
   * NOT `assignees.length > 1` — a task ticked "me and nobody" is still mine,
   * and a task ticked "Ace" alone is still the department's.
   */
  const forSomebodyElse = chosenColleagues.length > 0;

  function reset() {
    setPriority(null);
    setEstimate(null);
    setAssignees([MINE]);
    setErrors({});
    /* ⚠️ Closing this dialog does NOT unmount the form — unlike
       `new-task-dialog`, which renders `{open ? <TaskForm/> : null}`. An
       uncontrolled textarea was cleared by the browser on submit; controlled
       state is not, so without this the next task opens holding the last
       one's notes. */
    setDescription("");
  }

  function submit(formData: FormData) {
    setErrors({});

    const common = {
      title: String(formData.get("title") ?? ""),
      description: String(formData.get("description") ?? ""),
      due_date: String(formData.get("due_date") ?? ""),
      start_date: String(formData.get("start_date") ?? ""),
      list_id: String(formData.get("list_id") ?? "") || null,
      priority,
      estimate_minutes: estimate,
    };

    // P11-05. Closed on the click; reopened below if the server refuses. The
    // row itself arrives with the action's revalidation — this dialog is
    // rendered from the toolbar, outside the status groups, so there is no
    // optimistic list here to add it to.
    setOpen(false);

    /*
     * WHO HOLDS IT, and it is a position in a list rather than a rank anybody
     * chose. `assignee_id` is one column and the picker hands up several names,
     * so somebody has to be first: the reader if they ticked themselves —
     * filing work you are part of makes you the answerable one — otherwise the
     * first colleague ticked.
     *
     * P7-43 is why this is a smaller decision than it reads: an INTERNAL task
     * draws no person in charge at all. Everybody on it is shown as an equal
     * assignee, so the column here is what notifications and board ordering
     * use, not a hierarchy the screen puts on anyone.
     */
    const [accountable, ...alongside] = includesMe
      ? [selfId, ...chosenColleagues]
      : chosenColleagues;

    startTransition(async () => {
      const result = forSomebodyElse
        ? await createTask({
            ...common,
            // The member's OWN department. It travels as a parameter because the
            // SQL function takes one, and the function is what refuses any
            // department that is neither theirs nor one they lead.
            department_id: departmentId,
            assignee_id: accountable,
            /*
             * Added one at a time AFTER the row exists — `create_task` takes a
             * single assignee and widening an applied function's signature is a
             * drop and a regrant (trap 3). If one of them is refused the task
             * still exists and `createTask` says so by name, which is the honest
             * shape rather than discarding what somebody just typed.
             */
            extra_assignee_ids: alongside,
            // A member does not appoint reviewers. Internal work moves freely
            // (P7-13a), so a task with no QA reviewer is not a task that is
            // stuck — it is the ordinary shape of internal work.
            qa_assignee_id: null,
          })
        : await createPersonalTask(common);

      if (!result.ok) {
        // Back, with the fields as they were and the messages under them.
        setErrors(result.fieldErrors ?? {});
        setOpen(true);
        toast.error(result.error);
        return;
      }

      toast.success(
        forSomebodyElse ? `Assigned to ${nameList(chosenColleagues, includesMe)}.` : "Added to your tasks.",
      );
      reset();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setErrors({});
      }}
    >
      <DialogTrigger
        render={
          trigger === "toolbar" ? (
            <Button />
          ) : trigger === "quick" ? (
            /* Matched to the five links beside it, class for class — they are
               `buttonVariants({ variant: "outline", size: "sm" })` plus
               `h-auto min-h-9 justify-start`. A grid where one cell is a
               primary button reads as one recommended action and five
               afterthoughts. */
            <Button variant="outline" size="sm" className="h-auto min-h-9 w-full justify-start" />
          ) : (
            <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" />
          )
        }
      >
        <Plus className="size-4" />
        {trigger === "toolbar" || trigger === "quick" ? "New task" : "Add a task"}
      </DialogTrigger>

      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          {/* The description follows the picker, because the two endings are
              genuinely different and this is the only place that says so. */}
          <DialogDescription>
            {!forSomebodyElse
              ? "Your own work — it goes straight to your task list, and you can close it yourself when it is done."
              : chosenColleagues.length === 1 && !includesMe
                ? "Work for a colleague in your department. They can move it through any stage themselves."
                : "Shared work in your department. Everyone on it can open it, log time against it and move it through any stage."}
          </DialogDescription>
        </DialogHeader>

        <form action={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">
              {forSomebodyElse ? "What needs doing?" : "What are you working on?"}
            </Label>
            <Input id="title" name="title" autoFocus />
            <FieldError messages={errors.title} />
          </div>

          {canAssign ? (
            <div className="space-y-2">
              <Label htmlFor="assignee">Assign to</Label>
              {/* `multiple`: the popup STAYS OPEN and each row toggles, which
                  is what puts three people on a task in three clicks rather
                  than one create plus two visits to the task page.

                  Still no hidden input. The picked ids are read from state in
                  `submit` and never travel through FormData — just as well,
                  since a `multiple` Select would emit one input per value. */}
              <Select
                multiple
                items={assigneeItems}
                value={assignees}
                disabled={pending}
                onValueChange={(value) => setAssignees(value.length === 0 ? [MINE] : value)}
              >
                <SelectTrigger id="assignee" className="w-full">
                  {/* The trigger says WHO, not "3 selected" — a count is a
                      number you have to reopen the menu to check. */}
                  <SelectValue>
                    {(value) => {
                      const picked = value as string[];
                      const ids = picked.filter((id) => id !== MINE);
                      return ids.length === 0 ? "Myself" : nameList(ids, picked.includes(MINE));
                    }}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={MINE}>Myself</SelectItem>
                  {colleagues.map((person) => (
                    <SelectItem key={person.id} value={person.id}>
                      {person.full_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-2xs text-muted-foreground">
                {forSomebodyElse
                  ? "Everyone on it can open it, edit it, log time against it and move it. "
                  : "Pick as many people as are on it. "}
                Only your own department — work belongs to the department doing it, or somebody ends
                up holding a task their own Team Leader cannot see.
              </p>
              <FieldError messages={errors.assignee_id ?? errors.extra_assignee_ids} />
            </div>
          ) : null}

          <div className="space-y-2">
            {/* No `htmlFor` — the editor's input is a contenteditable, which
                is not a labelable element. It carries the same words as its
                `aria-label`. */}
            <Label>Notes</Label>
            <input type="hidden" name="description" value={description} />
            <RichTextEditor
              ariaLabel="Notes"
              value={description}
              onChange={setDescription}
              invalid={Boolean(errors.description?.length)}
              minHeight="min-h-24"
            />
            <FieldError messages={errors.description} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="start_date">Start</Label>
              <DatePicker
                id="start_date"
                name="start_date"
                value={startDate}
                onChange={setStartDate}
                invalid={Boolean(errors.start_date?.length)}
              />
              <FieldError messages={errors.start_date} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="due_date">Due</Label>
              <DatePicker
                id="due_date"
                name="due_date"
                value={dueDate}
                onChange={setDueDate}
                min={startDate ?? undefined}
                invalid={Boolean(errors.due_date?.length)}
              />
              <FieldError messages={errors.due_date} />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <EstimateField value={estimate} onChange={setEstimate} disabled={pending} />

            {/* Only when there is somewhere to file it. A lone "None" option is
                a control that does nothing. */}
            {lists.length > 0 ? (
              <div className="space-y-2">
                <Label htmlFor="list_id">List</Label>
                <input
                  type="hidden"
                  name="list_id"
                  value={listId === NO_LIST ? "" : listId}
                />
                <Select
                  items={listItems}
                  value={listId}
                  onValueChange={(value) => value !== null && setListId(value)}
                >
                  <SelectTrigger id="list_id" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_LIST}>No list</SelectItem>
                    {lists.map((list) => (
                      <SelectItem key={list.id} value={list.id}>
                        {list.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError messages={errors.list_id} />
              </div>
            ) : null}
          </div>

          <PriorityPicker value={priority} onChange={setPriority} disabled={pending} />

          {errors.form?.length ? <FieldError messages={errors.form} /> : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={pending}>
              Add task
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The sentinel for "assigned to me".
 *
 * Not the member's own user id, deliberately: the two branches call two
 * different functions and produce two different `is_personal` values, so "me"
 * has to be distinguishable from "a person who happens to be me".
 *
 * Still true now the picker takes several people — MORE true, since "me" is a
 * row that can be ticked alongside others. `selfId` is what the sentinel
 * resolves to at submit time, and only when somebody else is ticked too; ticked
 * alone it never becomes an id at all, because `create_personal_task` reads the
 * caller off their own row and takes no assignee.
 */
const MINE = "__mine__";

/*
 * "No list", as a Select value.
 *
 * The form still submits the EMPTY STRING the server has always read — the
 * hidden input below maps this sentinel back — because a Select cannot carry
 * "" as a value (Base UI reads it as "nothing chosen") and the action's contract
 * is not this component's to change.
 */
const NO_LIST = "__none__";

