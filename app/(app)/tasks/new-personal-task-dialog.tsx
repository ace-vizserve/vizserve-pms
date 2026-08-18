"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { TaskPriority } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { createPersonalTask, createTask } from "./actions";
import { EstimateField } from "./estimate-field";
import { PriorityPicker } from "./priority-picker";

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
  colleagues,
  departmentId,
  trigger = "toolbar",
}: {
  /** The member's own department's lists. Optional — a task needs no list. */
  lists: { id: string; name: string }[];
  /**
   * Active people in the member's own department, THEMSELVES EXCLUDED — "me" is
   * the default rather than an entry in the list, because picking yourself and
   * leaving it alone must not produce two different kinds of task.
   */
  colleagues: { id: string; full_name: string }[];
  /** The member's own department, read on the server. Never chosen here. */
  departmentId: string | null;
  trigger?: "toolbar" | "column" | "row";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [estimate, setEstimate] = useState<number | null>(null);
  const [assignee, setAssignee] = useState<string>(MINE);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, startTransition] = useTransition();

  /** Offering the picker at all needs both a department and somebody in it. */
  const canAssign = colleagues.length > 0 && departmentId !== null;
  const forSomebodyElse = canAssign && assignee !== MINE;

  function reset() {
    setPriority(null);
    setEstimate(null);
    setAssignee(MINE);
    setErrors({});
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

    startTransition(async () => {
      const result = forSomebodyElse
        ? await createTask({
            ...common,
            // The member's OWN department. It travels as a parameter because the
            // SQL function takes one, and the function is what refuses any
            // department that is neither theirs nor one they lead.
            department_id: departmentId,
            assignee_id: assignee,
            // A member does not appoint reviewers. Internal work moves freely
            // (P7-13a), so a task with no QA reviewer is not a task that is
            // stuck — it is the ordinary shape of internal work.
            qa_assignee_id: null,
          })
        : await createPersonalTask(common);

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      toast.success(
        forSomebodyElse
          ? `Assigned to ${colleagues.find((person) => person.id === assignee)?.full_name ?? "them"}.`
          : "Added to your tasks.",
      );
      setOpen(false);
      reset();
      router.refresh();
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
          ) : (
            <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground" />
          )
        }
      >
        <Plus className="size-4" />
        {trigger === "toolbar" ? "New task" : "Add a task"}
      </DialogTrigger>

      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New task</DialogTitle>
          {/* The description follows the picker, because the two endings are
              genuinely different and this is the only place that says so. */}
          <DialogDescription>
            {forSomebodyElse
              ? "Work for a colleague in your department. They can move it through any stage themselves."
              : "Your own work — it goes straight to your task list, and you can close it yourself when it is done."}
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
              <select
                id="assignee"
                value={assignee}
                disabled={pending}
                onChange={(event) => setAssignee(event.target.value)}
                className={cn(
                  "h-9 w-full rounded-sm border bg-transparent px-3 text-sm shadow-raised",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                )}
              >
                <option value={MINE}>Myself</option>
                {colleagues.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.full_name}
                  </option>
                ))}
              </select>
              <p className="text-2xs text-muted-foreground">
                Only your own department. Work belongs to the department doing it, or somebody ends
                up holding a task their own Team Leader cannot see.
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="description">Notes</Label>
            <Textarea id="description" name="description" rows={3} />
            <FieldError messages={errors.description} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="start_date">Start</Label>
              <Input id="start_date" name="start_date" type="date" />
              <FieldError messages={errors.start_date} />
            </div>

            <div className="space-y-2">
              <Label htmlFor="due_date">Due</Label>
              <Input id="due_date" name="due_date" type="date" />
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
                <select
                  id="list_id"
                  name="list_id"
                  defaultValue=""
                  className={cn(
                    "h-9 w-full rounded-sm border bg-transparent px-3 text-sm shadow-raised",
                    "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  )}
                >
                  <option value="">No list</option>
                  {lists.map((list) => (
                    <option key={list.id} value={list.id}>
                      {list.name}
                    </option>
                  ))}
                </select>
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
 */
const MINE = "__mine__";

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {messages[0]}
    </p>
  );
}
