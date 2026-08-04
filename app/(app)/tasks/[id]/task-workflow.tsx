"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Save } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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
  type TaskStatus,
  type Transition,
} from "@/lib/schemas/tasks";

import { overrideTaskStatus, reassignTask, transitionTask, updateTaskDetails } from "../actions";

/**
 * P3-05 / P3-06 / P3-07 — the working half of the task page.
 *
 * The resolution editor sits immediately above the buttons on purpose. "Send for
 * QA" is refused by the database while the resolution is empty (P3-07), and a
 * button that fails for a reason living on another part of the screen is a
 * button people learn to distrust. Here the disabled state and the field that
 * causes it are in the same glance.
 *
 * Which buttons appear is decided by `availableTransitions` — a mirror of the
 * database's transition table. Hiding one protects nobody; the server re-checks
 * every rule. It just stops people clicking things that cannot work.
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
  listId: initialListId,
  assigneeId,
  qaAssigneeId,
  lists,
  candidates,
  viewer,
}: {
  taskId: string;
  status: TaskStatus;
  title: string;
  description: string;
  resolution: string;
  outputLink: string;
  dueDate: string;
  listId: string | null;
  assigneeId: string | null;
  qaAssigneeId: string | null;
  lists: List[];
  candidates: Person[];
  viewer: { isPic: boolean; isQa: boolean; leadsDepartment: boolean; isAdmin: boolean };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [resolution, setResolution] = useState(initialResolution);
  const [outputLink, setOutputLink] = useState(initialOutputLink);
  const [dueDate, setDueDate] = useState(initialDueDate);
  const [listId, setListId] = useState(initialListId ?? NONE);

  const [prompt, setPrompt] = useState<Transition | null>(null);
  const [comment, setComment] = useState("");
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideStatus, setOverrideStatus] = useState<TaskStatus>(status);
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const transitions = availableTransitions(status, viewer);
  const canEdit = viewer.isPic || viewer.isQa || viewer.leadsDepartment;
  const resolutionMissing = resolution.trim().length === 0;

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That did not go through.");
        return;
      }
      toast.success(success);
      setPrompt(null);
      setComment("");
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
          list_id: listId === NONE ? null : listId,
        }),
      "Saved",
    );
  }

  function move(transition: Transition) {
    // A transition needing a comment opens the box first; the rest go straight
    // through. Prompting for a comment nobody has to give is friction that
    // teaches people to type "ok".
    if (transition.requires === "comment") {
      setPrompt(transition);
      return;
    }
    run(() => transitionTask(taskId, { to_status: transition.to }), transition.label);
  }

  function confirmWithComment() {
    if (!prompt) return;
    run(
      () => transitionTask(taskId, { to_status: prompt.to, comment }),
      prompt.label,
    );
  }

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5 shadow-ring">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold">The work</h2>
        {isTerminal(status) ? (
          <span className="text-xs text-muted-foreground">
            Finished — {TASK_STATUS_LABELS[status].toLowerCase()}.
          </span>
        ) : null}
      </div>

      {/* -------------------------------------------------------------- */}
      {/* The resolution. The thing this phase exists to capture.        */}
      {/* -------------------------------------------------------------- */}
      <div className="space-y-2">
        <Label htmlFor="resolution">Resolution</Label>
        <Textarea
          id="resolution"
          rows={4}
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

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
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

        <div className="space-y-2">
          <Label htmlFor="due">Due date</Label>
          <Input
            id="due"
            type="date"
            value={dueDate}
            disabled={!canEdit || pending}
            onChange={(event) => setDueDate(event.target.value)}
          />
        </div>
      </div>

      {lists.length > 0 ? (
        <div className="space-y-2">
          <Label htmlFor="list">List</Label>
          <Select value={listId} onValueChange={(v) => v !== null && (v)} disabled={!canEdit || pending}>
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
      {prompt ? (
        <div className="space-y-3 border-t pt-4">
          <div className="space-y-2">
            <Label htmlFor="comment">
              {prompt.to === "WAITING_FOR_INFO"
                ? "What are you waiting for?"
                : prompt.to === "ONGOING"
                  ? "What needs changing?"
                  : "Add a comment"}
            </Label>
            <Textarea
              id="comment"
              rows={3}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder={
                prompt.to === "ONGOING"
                  ? "e.g. The logo is the old one — please use the 2026 mark."
                  : "e.g. Waiting on the client to confirm which of the two headlines."
              }
            />
            <p className="text-xs text-muted-foreground">
              {prompt.to === "ONGOING"
                ? "The PIC is notified with this comment attached."
                : "Recorded on the task, and counted toward how long this spent waiting."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              onClick={confirmWithComment}
              loading={pending}
              disabled={comment.trim().length === 0}
            >
              {prompt.label}
            </Button>
            <Button variant="ghost" onClick={() => setPrompt(null)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : transitions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-4">
          {transitions.map((transition) => {
            const blocked = transition.requires === "resolution" && resolutionMissing;

            return (
              <Button
                key={`${transition.from}-${transition.to}`}
                variant={transition.to === "ONGOING" && status === "QA_IN_PROGRESS" ? "outline" : "default"}
                onClick={() => move(transition)}
                disabled={pending || blocked}
                title={blocked ? "Fill in the resolution first." : undefined}
              >
                {transition.label}
              </Button>
            );
          })}

          {transitions.some((t) => t.requires === "resolution") && resolutionMissing ? (
            <span className="text-xs text-muted-foreground">
              Fill in the resolution above to send this for QA.
            </span>
          ) : null}
        </div>
      ) : (
        <p className="border-t pt-4 text-xs text-muted-foreground">
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
        <div className="space-y-3 rounded-md border border-warning/40 bg-warning-subtle/40 p-4">
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
        <details className="border-t pt-4">
          <summary className="cursor-pointer text-xs text-muted-foreground">Reassign</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
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
    </section>
  );
}
