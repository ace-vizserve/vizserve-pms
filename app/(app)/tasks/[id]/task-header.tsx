"use client";

import { Link2 } from "lucide-react";

import { Chip } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { formatDate } from "@/lib/dates";
import { availableTransitions, type TaskCategory, type TaskStatus, type TaskViewer } from "@/lib/schemas/tasks";
import { cn } from "@/lib/utils";

import { TaskStatusSelect } from "../status-select";
import { EditableTitle } from "./editable-title";
import { TaskActions } from "./task-actions";
import { ClientTaskMenu } from "./client-task-menu";
import { useTaskGate } from "./task-gate";


/**
 * P7-57 / P7-60 — THE TITLE ROW, AND THE ONE CONTROL THAT MOVES THE TASK.
 *
 * ------------------------------------------------------------------------
 * WHY THERE IS EXACTLY ONE CONTROL HERE NOW.
 *
 * P7-57 moved the status out of the properties block and put a promoted move
 * ("Send for QA") beside it, plus a second outline button for the ending where
 * the ending was not already the promoted move. On CLIENT work that read as two
 * buttons; on INTERNAL work it read as three, because free movement (P7-13a)
 * synthesises an ONGOING → COMPLETED that the "Complete" button then picked up.
 *
 * Three controls, all the same size, all doing the same KIND of thing — move
 * this task — and the difference between them was a rule about transition
 * scopes that nobody reading the screen can see. People could not tell them
 * apart, which is the honest test a header row has to pass.
 *
 * ⚠️ AND NOTHING WAS LOST BY DELETING TWO OF THEM. Every move those buttons
 * offered was already in the dropdown, under its own wording, in a banded and
 * searchable list — "Send for QA" is the first row of Active on a client task.
 * The buttons were a second door to the same room, and the room was never hard
 * to find.
 * ------------------------------------------------------------------------
 *
 * ⚠️ THE P3-07 GATE STILL SHOWS ITS REASON, and it has two carriers now. The
 * menu row greys out with "needs a resolution" beside it, and the sentence below
 * this row names the field and says where it is. The rule is that the REASON is
 * visible, not that the two controls are adjacent — the resolution itself is
 * further down the surface, and `useTaskGate` is what lets a control up here
 * know whether it is filled in (see `task-gate.tsx`).
 */
export function TaskHeader({
  taskId,
  title,
  status,
  category,
  viewer,
  task,
  canEdit,
  dueDate,
  late,
  lifecycle,
}: {
  taskId: string;
  title: string;
  status: TaskStatus;
  /** Decides the kind chip and, through `availableTransitions`, the whole menu. */
  category: TaskCategory;
  viewer: TaskViewer;
  task: { request_id: string | null; is_personal: boolean };
  /** On the task, or leading it — the same test the surface uses. */
  canEdit: boolean;
  dueDate: string | null;
  late: boolean;
  /** P16-03 — client tasks only: what the lifecycle menu may offer. */
  lifecycle?: { archived: boolean; canSteer: boolean; canDelete: boolean };
}) {
  const gate = useTaskGate();

  const transitions = availableTransitions(status, viewer, task);

  const kind =
    category === "request"
      ? { tone: "info" as const, label: "Client work" }
      : category === "personal"
        ? { tone: "neutral" as const, label: "Your own task" }
        : { tone: "brand" as const, label: "Internal work" };

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/tasks/${taskId}`);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy the link. Copy it from the address bar instead.");
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      {/*
        THE KIND AND THE CONTROLS SIT ABOVE THE TITLE, the way ClickUp lays a
        task out: a long title wraps under them instead of pushing the one
        button that moves the task off the right edge. On a phone the controls
        drop to their own line (`ml-auto` inside a wrapping row).
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {/*
            ⚠️ THE KIND COMES FROM `category`, NEVER FROM WHETHER THE REQUEST
            ROW CAME BACK. The requests policy is not the tasks policy, so a
            PIC can hold a client task whose originating request they cannot
            open — and deciding the KIND from a null row calls that task
            internal, hides Gate 3, and contradicts the track above it.
          */}
          <Chip tone={kind.tone} label={kind.label} />

          {dueDate ? (
            <span className={cn("tabular-nums", late ? "font-medium text-destructive" : null)}>
              due {formatDate(dueDate)}
              {/* Never colour alone — the state is named, not just tinted. */}
              {late ? " · overdue" : null}
            </span>
          ) : null}
        </div>

        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" aria-label="Copy link" onClick={copyLink}>
            <Link2 />
            <span className="hidden sm:inline">Copy link</span>
          </Button>
          {category === "request" && lifecycle ? (
            <ClientTaskMenu
              taskId={taskId}
              title={title}
              status={status}
              archived={lifecycle.archived}
              canSteer={lifecycle.canSteer}
              canDelete={lifecycle.canDelete}
            />
          ) : null}
          {/*
            ⚠️ P7-61 — TWO SHAPES, AND THE SPLIT IS THE LENGTH OF THE LIST.

            CLIENT work is a fixed flow, so `availableTransitions` returns one or
            two moves and they are drawn as colour-coded BUTTONS: a dropdown over
            two rows is furniture, and it made "Pass QA" and "Send back to PIC"
            two identical grey lines in a menu. See `task-actions.tsx`.

            INTERNAL and PERSONAL work moves freely (P7-13a) — seven legal
            destinations at once — so it keeps the dropdown, which is exactly
            what P7-60 built it for. Drawing seven buttons is the wall the menu
            replaced.

            Both fall back to a plain chip with nothing legal to offer, which is
            why the sentence beside them is a real sentence rather than a
            tooltip: an inert control needs its reason in words (§4.2).
          */}
          {category === "request" ? (
            <TaskActions
              taskId={taskId}
              status={status}
              viewer={viewer}
              task={task}
              resolutionMissing={gate.resolutionMissing}
              // ⚠️ COMMITS THE RESOLUTION FIRST. Clicking blurs the textarea and
              // schedules a save, but that is a round trip racing the move —
              // see `task-gate.tsx`.
              beforeMove={gate.flush}
            />
          ) : (
            <>
              <TaskStatusSelect
                variant="control"
                // A right-hand control, so the list opens back under it rather
                // than hanging off the edge of the page.
                align="end"
                taskId={taskId}
                status={status}
                viewer={viewer}
                task={task}
                resolutionMissing={gate.resolutionMissing}
                beforeMove={gate.flush}
              />

              {transitions.length === 0 ? (
                <p className="text-xs text-muted-foreground">It is with somebody else.</p>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* Editable in place. The same `updateTaskField` the list row's rename
          calls — a second path to the same column would be a second set of
          rules to keep in step. */}
      <EditableTitle taskId={taskId} title={title} canEdit={canEdit} />

      {/*
        THE GATE'S SENTENCE IS NOT HERE ANY MORE (P7-60).

        It sat under this row and read "fill in the resolution, under The work" —
        a message whose main job was to send you somewhere else on the page. It
        was written that way because the button it explained was up here. With
        the promoted buttons gone the sentence has no reason to be, so it moved
        to the field it is about, where it needs no directions (`task-surface`).

        ⚠️ §4.2 IS STILL SATISFIED, and by two carriers rather than one: the menu
        row greys with "needs a resolution" beside it, and the warning sits on
        the empty box itself.
      */}
    </div>
  );
}
