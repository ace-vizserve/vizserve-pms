"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  availableTransitions,
  isTerminal,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/schemas/tasks";

import { overrideTaskStatus, reassignTask, updateTaskDetails } from "../actions";
import { EstimateField } from "../estimate-field";
import { PriorityPicker } from "../priority-picker";
import { TaskStatusSelect } from "../status-select";

/**
 * P3-05 / P3-06 / P3-07 — the working half of the task page.
 *
 * The resolution editor sits immediately above the buttons on purpose. "Send for
 * QA" is refused by the database while the resolution is empty (P3-07), and a
 * button that fails for a reason living on another part of the screen is a
 * button people learn to distrust. Here the disabled state and the field that
 * causes it are in the same glance.
 *
 * Which moves appear is decided by `availableTransitions` — a mirror of the
 * database's transition table. Hiding one protects nobody; the server re-checks
 * every rule. It just stops people clicking things that cannot work.
 *
 * K3 — the moves are a DROPDOWN now, not a row of buttons, and `TaskStatusSelect`
 * owns the whole interaction. P7-13a made internal work reach every status
 * except `FOR_CLIENT_APPROVAL`, so this card was drawing seven primary buttons
 * side by side. The control lives here rather than on the header chip on
 * purpose: the resolution gate is the reason half of these moves refuse, and a
 * control that fails for a reason living on another part of the screen is one
 * people learn to distrust.
 */

type Person = { id: string; full_name: string; primary_department_id: string | null };
type List = { id: string; name: string };

const NONE = "__none__";

export function TaskWorkflow({
  taskId,
  status,
  title,
  description,
  resolution: initialResolution,
  outputLink: initialOutputLink,
  dueDate: initialDueDate,
  startDate: initialStartDate,
  listId: initialListId,
  priority: initialPriority,
  estimateMinutes: initialEstimate,
  assigneeId,
  qaAssigneeId,
  lists,
  candidates,
  viewer,
  task,
}: {
  taskId: string;
  status: TaskStatus;
  title: string;
  description: string;
  resolution: string;
  outputLink: string;
  dueDate: string;
  startDate: string;
  listId: string | null;
  /**
   * P7-11 / P7-15. BOTH ARE REQUIRED PROPS, not optional with a null default,
   * and that is load-bearing: `taskDetailsSchema` defaults each to null, so a
   * Save that did not send them would silently clear a priority and an estimate
   * somebody set from a row.
   */
  priority: TaskPriority | null;
  estimateMinutes: number | null;
  assigneeId: string | null;
  qaAssigneeId: string | null;
  lists: List[];
  candidates: Person[];
  viewer: { isPic: boolean; isQa: boolean; leadsDepartment: boolean; isAdmin: boolean };
  /**
   * Where the task came from. Decides which endings are legal: a client request
   * finishes at Gate 3, internal work is closed by its QA reviewer, and a
   * personal task is closed by the person who made it.
   */
  task: { request_id: string | null; is_personal: boolean };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [resolution, setResolution] = useState(initialResolution);
  const [outputLink, setOutputLink] = useState(initialOutputLink);
  const [dueDate, setDueDate] = useState(initialDueDate);
  const [startDate, setStartDate] = useState(initialStartDate);
  const [listId, setListId] = useState(initialListId ?? NONE);
  const [priority, setPriority] = useState<TaskPriority | null>(initialPriority);
  const [estimate, setEstimate] = useState<number | null>(initialEstimate);

  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideStatus, setOverrideStatus] = useState<TaskStatus>(status);
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const transitions = availableTransitions(status, viewer, task);
  const canEdit = viewer.isPic || viewer.isQa || viewer.leadsDepartment;
  /**
   * The SAVED resolution, not the draft in the box.
   *
   * The database checks the stored column, so offering "Send for QA" because
   * somebody has typed into the textarea would offer a move the server then
   * refuses. `unsavedResolution` below is what closes the gap — it says to press
   * Save rather than leaving the move mysteriously unavailable.
   */
  const resolutionMissing = initialResolution.trim().length === 0;
  const unsavedResolution = resolution !== initialResolution;

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That did not go through.");
        return;
      }
      toast.success(success);
      setOverrideOpen(false);
      setOverrideReason("");
      router.refresh();
    });
  }

  function save() {
    run(
      () =>
        updateTaskDetails(taskId, {
          title,
          description,
          resolution,
          output_link: outputLink,
          due_date: dueDate,
          start_date: startDate,
          list_id: listId === NONE ? null : listId,
          priority,
          estimate_minutes: estimate,
        }),
      "Saved",
    );
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>The work</CardTitle>
        {isTerminal(status) ? (
          <CardAction>
            <span className="text-xs text-muted-foreground">
              Finished — {TASK_STATUS_LABELS[status].toLowerCase()}.
            </span>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent className="space-y-3">
        {/* -------------------------------------------------------------- */}
        {/* The resolution. The thing this phase exists to capture.        */}
        {/* -------------------------------------------------------------- */}
        <div className="space-y-1.5">
          <Label htmlFor="resolution">Resolution</Label>
          {/* Three rows, not four. Textarea carries `field-sizing-content`, so
              rows is a floor it grows past as you type — reserving a fourth
              empty line bought nothing and pushed the transition buttons, the
              reason most people open this page at all, further down. */}
          <Textarea
            id="resolution"
            rows={3}
            value={resolution}
            disabled={!canEdit || pending}
            onChange={(event) => setResolution(event.target.value)}
            placeholder="What did you actually do? For collateral, a link is fine. For a fix, say what was wrong and what you changed."
          />
          <p className="text-xs text-muted-foreground">
            Required before this can go for QA. The reviewer reads it, and it is what the client
            eventually sees.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="output_link">Output link</Label>
            <Input
              id="output_link"
              type="url"
              placeholder="https://drive.google.com/…"
              value={outputLink}
              disabled={!canEdit || pending}
              onChange={(event) => setOutputLink(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="start">Start date</Label>
            <Input
              id="start"
              type="date"
              value={startDate}
              disabled={!canEdit || pending}
              onChange={(event) => setStartDate(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="due">Due date</Label>
            <Input
              id="due"
              type="date"
              value={dueDate}
              disabled={!canEdit || pending}
              onChange={(event) => setDueDate(event.target.value)}
            />
          </div>

          <EstimateField
            value={estimate}
            onChange={setEstimate}
            disabled={!canEdit || pending}
            id="estimate_minutes"
          />
        </div>

        <PriorityPicker value={priority} onChange={setPriority} disabled={!canEdit || pending} />

        {lists.length > 0 ? (
          <div className="space-y-1.5">
            <Label htmlFor="list">List</Label>
            <Select value={listId} onValueChange={(v) => v !== null && setListId(v)} disabled={!canEdit || pending}>
              <SelectTrigger id="list" className="w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No list</SelectItem>
                {lists.map((list) => (
                  <SelectItem key={list.id} value={list.id}>
                    {list.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {canEdit ? (
          <Button variant="outline" size="sm" onClick={save} loading={pending}>
            <Save />
            Save
          </Button>
        ) : null}

        {/* -------------------------------------------------------------- */}
        {/* Transitions                                                     */}
        {/* -------------------------------------------------------------- */}
        {transitions.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3">
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Status</Label>
              <TaskStatusSelect
                taskId={taskId}
                status={status}
                viewer={viewer}
                task={task}
                resolutionMissing={resolutionMissing}
              />
            </div>

            {/* Two different sentences for two different situations, and the
                order matters: an unsaved draft is the more actionable of the
                two, because pressing Save is what unblocks the move. */}
            {unsavedResolution ? (
              <span className="text-xs text-muted-foreground">
                The resolution has unsaved changes — Save before moving this.
              </span>
            ) : transitions.some((t) => t.requires === "resolution") && resolutionMissing ? (
              <span className="text-xs text-muted-foreground">
                Fill in the resolution above to send this for QA.
              </span>
            ) : null}
          </div>
        ) : (
          <p className="border-t pt-3 text-xs text-muted-foreground">
            {isTerminal(status)
              ? "This task is finished."
              : "Nothing for you to do here right now — it is with somebody else."}
          </p>
        )}

        {/* -------------------------------------------------------------- */}
        {/* Q5 — the override. Quiet, and never the obvious thing to click. */}
        {/* -------------------------------------------------------------- */}
        {viewer.leadsDepartment && !overrideOpen ? (
          <button
            type="button"
            onClick={() => setOverrideOpen(true)}
            className="text-2xs text-muted-foreground underline-offset-4 hover:underline"
          >
            Force a different status
          </button>
        ) : null}

        {overrideOpen ? (
          <div className="space-y-2.5 rounded-md border border-warning/40 bg-warning-subtle/40 p-3">
            <p className="flex items-start gap-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              This skips the normal stages. It is recorded as forced, with your reason, and stays
              visible in the history for good.
            </p>

            <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
              <div className="space-y-1.5">
                <Label htmlFor="override_status">Move to</Label>
                <Select
                  value={overrideStatus}
                  onValueChange={(value) => setOverrideStatus(value as TaskStatus)}
                >
                  <SelectTrigger id="override_status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_STATUSES.filter((option) => option !== status).map((option) => (
                      <SelectItem key={option} value={option}>
                        {TASK_STATUS_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="override_reason">Why</Label>
                <Input
                  id="override_reason"
                  value={overrideReason}
                  onChange={(event) => setOverrideReason(event.target.value)}
                  placeholder="e.g. PIC left the company mid-task; reopening for reassignment."
                />
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() =>
                  run(
                    () =>
                      overrideTaskStatus(taskId, {
                        to_status: overrideStatus,
                        reason: overrideReason,
                      }),
                    "Status forced",
                  )
                }
                loading={pending}
                disabled={overrideReason.trim().length < 10}
              >
                Force it
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOverrideOpen(false)} disabled={pending}>
                Cancel
              </Button>
            </div>
          </div>
        ) : null}

        {/* -------------------------------------------------------------- */}
        {/* Reassignment — a lead decision, not self-service.               */}
        {/* -------------------------------------------------------------- */}
        {viewer.leadsDepartment ? (
          <details className="border-t pt-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">Reassign</summary>
            <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="new_pic">Person in charge</Label>
                <Select
                  defaultValue={assigneeId ?? NONE}
                  onValueChange={(value) =>
                    run(
                      () =>
                        reassignTask(taskId, {
                          assignee_id: value === NONE ? null : value,
                          qa_assignee_id: qaAssigneeId,
                        }),
                      "Reassigned",
                    )
                  }
                >
                  <SelectTrigger id="new_pic">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {candidates.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="new_qa">QA reviewer</Label>
                <Select
                  defaultValue={qaAssigneeId ?? NONE}
                  onValueChange={(value) =>
                    run(
                      () =>
                        reassignTask(taskId, {
                          assignee_id: assigneeId,
                          qa_assignee_id: value === NONE ? null : value,
                        }),
                      "QA reviewer changed",
                    )
                  }
                >
                  <SelectTrigger id="new_qa">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No QA reviewer</SelectItem>
                    {candidates.map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </details>
        ) : null}

        {error ? (
          <p
            role="alert"
            className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
