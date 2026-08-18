"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { quickAddTask } from "./actions";

/**
 * K3 — "+ Add Task" at the foot of the first status group and the first board
 * column. A title, Enter, done.
 *
 * IT ONLY EVER APPEARS IN THE FIRST GROUP, and that is a constraint rather than
 * a layout choice. `status` is not a writable column and both create functions
 * open every task at `INITIAL_TASK_STATUS`, so this control under the *Ongoing*
 * heading would be promising something the database refuses. The alternative —
 * create at OPEN then immediately transition — writes two history rows for one
 * button press, so the trail would claim somebody opened and started the task in
 * the same second. The callers enforce this by only rendering it there; the
 * server-side note is on `quickAddTask`.
 *
 * It stays open after a save. Adding tasks is something people do in runs of
 * five, and a control that closes itself after each one turns five tasks into
 * five round trips through a trigger.
 *
 * The dialog is still there for the case where somebody wants dates, a priority
 * and an assignee in one pass — this is the cheap path, not a replacement.
 */
export function QuickAddTask({
  departmentId = null,
  shape = "row",
}: {
  /**
   * Where the task lands, when the caller knows. Null files it as the caller's
   * own personal work.
   *
   * NOT TRUSTED FROM HERE: `vizserve_pms_create_task` re-reads the caller's
   * department from their own row and refuses any other, so passing a department
   * a member does not belong to is an error message rather than a hole.
   */
  departmentId?: string | null;
  shape?: "row" | "column";
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [pending, startTransition] = useTransition();

  function submit() {
    const next = title.trim();
    if (!next) return;

    // Cleared BEFORE the request, not after. Somebody typing the next task while
    // the last one saves is the whole point of the shape, and clearing on
    // success would eat what they typed in between.
    setTitle("");

    startTransition(async () => {
      const result = await quickAddTask({ title: next, department_id: departmentId });

      if (!result.ok) {
        // Put it back so the words are not lost with the error.
        setTitle(next);
        toast.error(result.error);
        return;
      }

      router.refresh();
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className={cn(
        "flex items-center gap-1.5",
        shape === "column" ? "shrink-0 px-2 pb-2" : "border-t px-2 py-1.5",
      )}
    >
      <Plus className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <Input
        value={title}
        disabled={pending}
        // No autoFocus. This sits at the foot of a list somebody has just
        // scrolled to read; stealing the caret on every render would fight them.
        placeholder="Add a task"
        aria-label="Add a task, then press Enter"
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setTitle("");
        }}
        className={cn(
          // Borderless until it is being used: at rest it should read as the
          // affordance the ghost button was, not as an empty form field on every
          // board column.
          "h-7 border-transparent bg-transparent px-1 text-xs shadow-none",
          "hover:border-border focus-visible:border-border",
        )}
      />
    </form>
  );
}
