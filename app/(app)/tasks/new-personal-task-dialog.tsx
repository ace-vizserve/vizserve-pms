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

import { createPersonalTask } from "./actions";
import { PriorityPicker } from "./priority-picker";

/**
 * P7-01 — a member records work for themselves.
 *
 * DELIBERATELY NOT `NewTaskDialog` with fields hidden. There is no department
 * picker and no assignee picker because neither is the member's to choose:
 * `vizserve_pms_create_personal_task` resolves both from the signed-in user's
 * own row, so the question never reaches the client at all. A field that cannot
 * be sent is a rule that cannot be bent — and one dialog whose fields mean
 * different things depending on who opened it is how that rule gets bent.
 *
 * The two dialogs answer two different questions. The TL's asks "may I create
 * work for someone else"; this one asks "may I record work for myself".
 */
export function NewPersonalTaskDialog({
  lists,
  trigger = "toolbar",
}: {
  /** The member's own department's lists. Optional — a task needs no list. */
  lists: { id: string; name: string }[];
  trigger?: "toolbar" | "column" | "row";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [priority, setPriority] = useState<TaskPriority | null>(null);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setErrors({});

    startTransition(async () => {
      const result = await createPersonalTask({
        title: String(formData.get("title") ?? ""),
        description: String(formData.get("description") ?? ""),
        due_date: String(formData.get("due_date") ?? ""),
        list_id: String(formData.get("list_id") ?? "") || null,
        priority,
      });

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      toast.success("Added to your tasks.");
      setOpen(false);
      setPriority(null);
      setErrors({});
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
          <DialogDescription>
            Your own work — it goes straight to your task list, and you can close it yourself when
            it is done.
          </DialogDescription>
        </DialogHeader>

        <form action={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">What are you working on?</Label>
            <Input id="title" name="title" autoFocus />
            <FieldError messages={errors.title} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Notes</Label>
            <Textarea id="description" name="description" rows={3} />
            <FieldError messages={errors.description} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="due_date">Due</Label>
              <Input id="due_date" name="due_date" type="date" />
              <FieldError messages={errors.due_date} />
            </div>

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

function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {messages[0]}
    </p>
  );
}
