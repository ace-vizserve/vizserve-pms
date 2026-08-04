"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";
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
import { formatDate, isOverdue } from "@/lib/dates";
import type { CapacityRow } from "@/lib/schemas/approvals";

import { decideOnRequest } from "./actions";

/**
 * P2-01 / P2-02 / P2-04 / P2-05 — the Team Leader review screen.
 *
 * Two design consequences follow from Amier at 37:00–38:40, and both are easy to
 * lose to a tidier layout:
 *
 *   1. THE LOAD IS VISIBLE AT DECISION TIME. If the TL has to open another tab
 *      to check whether the assignee is drowning, they will not do it, and the
 *      gate does nothing. Hence the capacity panel sits beside the decision, not
 *      behind a link.
 *   2. NEGOTIATION IS THE PRIMARY PATH, rejection the exception —
 *      *"Dapat di tayo nagre-reject, eh, di ba?"* So "approve with an adjusted
 *      date" is the prominent action and Reject is a quiet, deliberate one.
 */

type Person = { id: string; full_name: string; role: string };
type List = { id: string; name: string };

const NO_QA = "__none__";
const NO_LIST = "__none__";

export function ReviewPanel({
  requestId,
  requestTitle,
  requestDescription,
  targetDate,
  candidates,
  capacity,
  currentUserId,
  currentUserName,
  lists,
  defaultListId,
}: {
  requestId: string;
  requestTitle: string;
  requestDescription: string;
  targetDate: string | null;
  /** Department members who can be PIC. */
  candidates: Person[];
  capacity: CapacityRow[];
  currentUserId: string;
  currentUserName: string;
  /** P2-06. Empty when the department has not organised itself into lists. */
  lists: List[];
  defaultListId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [assigneeId, setAssigneeId] = useState<string>("");
  // P2-05 — defaults to the approving TL, overridable to any member of the
  // department (Amier 41:30). Defaulting to nobody would leave most tasks with
  // no second pair of eyes, which is the failure this gate exists to prevent.
  const [qaAssigneeId, setQaAssigneeId] = useState<string>(currentUserId);
  const [approvedDate, setApprovedDate] = useState<string>(targetDate ?? "");
  // P2-06 — seeded from the form's default, overridable here.
  const [listId, setListId] = useState<string>(defaultListId ?? NO_LIST);
  const [title, setTitle] = useState(requestTitle);
  const [description, setDescription] = useState(requestDescription);

  const [mode, setMode] = useState<"approve" | "returned" | "rejected">("approve");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const capacityFor = (userId: string) => capacity.find((row) => row.user_id === userId);
  const selected = assigneeId ? capacityFor(assigneeId) : undefined;

  const dateMoved = Boolean(targetDate) && approvedDate !== targetDate;

  function run(payload: Record<string, unknown>) {
    setFormError(null);
    startTransition(async () => {
      const result = await decideOnRequest(requestId, payload);

      if (!result.ok) {
        setFormError(result.error);
        return;
      }

      toast.success(
        result.data.status === "APPROVED"
          ? "Approved — the task is created and the PIC has been told."
          : result.data.status === "RETURNED"
            ? "Returned. The requester has been emailed the reason."
            : "Rejected. The requester has been emailed the reason.",
      );
      router.refresh();
    });
  }

  function approve() {
    run({
      decision: "approved",
      assignee_id: assigneeId || undefined,
      qa_assignee_id: qaAssigneeId === NO_QA ? null : qaAssigneeId,
      approved_target_date: approvedDate || null,
      list_id: listId === NO_LIST ? null : listId,
      // Only send an edit if it is one. Null means unchanged.
      title: title.trim() !== requestTitle ? title.trim() : null,
      description: description.trim() !== requestDescription ? description.trim() : null,
    });
  }

  function decideNegative() {
    run({ decision: mode, reason });
  }

  return (
    <section className="rounded-lg border bg-card shadow-ring">
      <div className="border-b px-5 py-3">
        <h2 className="text-sm font-semibold">Your decision</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Check the load before you commit someone to a date.
        </p>
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-[1fr_20rem]">
        {/* ---------------------------------------------------------------- */}
        {/* The decision                                                      */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="assignee">Person in charge</Label>
              <Select value={assigneeId} onValueChange={(v) => v !== null && (v)}>
                <SelectTrigger id="assignee">
                  <SelectValue placeholder="Choose who does the work" />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((person) => {
                    const load = capacityFor(person.id);
                    return (
                      <SelectItem key={person.id} value={person.id}>
                        {person.full_name}
                        {load ? ` · ${load.open_count} open` : null}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="qa">QA reviewer</Label>
              <Select value={qaAssigneeId} onValueChange={(v) => v !== null && (v)}>
                <SelectTrigger id="qa">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={currentUserId}>{currentUserName} (you)</SelectItem>
                  {candidates
                    .filter((person) => person.id !== currentUserId)
                    .map((person) => (
                      <SelectItem key={person.id} value={person.id}>
                        {person.full_name}
                      </SelectItem>
                    ))}
                  <SelectItem value={NO_QA}>No QA reviewer</SelectItem>
                </SelectContent>
              </Select>
              {qaAssigneeId !== NO_QA && qaAssigneeId === assigneeId ? (
                <p className="text-xs text-warning">
                  Same person as the PIC — they would be reviewing their own work.
                </p>
              ) : null}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="approved_date">Delivery date you are committing to</Label>
            <Input
              id="approved_date"
              type="date"
              className="w-auto"
              value={approvedDate}
              onChange={(event) => setApprovedDate(event.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {targetDate ? (
                dateMoved ? (
                  <span className="text-info">
                    Negotiated. The client asked for {formatDate(targetDate)}; both dates are kept.
                  </span>
                ) : (
                  <>The client asked for {formatDate(targetDate)}.</>
                )
              ) : (
                "The client gave no date."
              )}
            </p>
          </div>

          {lists.length > 0 ? (
            <div className="space-y-2">
              <Label htmlFor="list">List</Label>
              <Select value={listId} onValueChange={(v) => v !== null && (v)}>
                <SelectTrigger id="list" className="w-64">
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
              <p className="text-xs text-muted-foreground">
                {defaultListId
                  ? "Pre-filled from the form's default."
                  : "This form has no default list."}
              </p>
            </div>
          ) : null}

          <details className="rounded-md border px-3 py-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              Correct a typo in the title or description
            </summary>
            <div className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit_title">Title</Label>
                <Input
                  id="edit_title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="edit_description">Description</Label>
                <Textarea
                  id="edit_description"
                  rows={4}
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
              {/* Every edit is written to the audit log with before and after. */}
              <p className="text-xs text-muted-foreground">
                Edits are recorded with the original text alongside them.
              </p>
            </div>
          </details>

          {mode === "approve" ? (
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              <Button onClick={approve} loading={pending} disabled={!assigneeId}>
                Approve and create the task
              </Button>
              <Button variant="outline" onClick={() => setMode("returned")} disabled={pending}>
                Return for more info
              </Button>
              {/* Quiet, and last. Rejection is the exception. */}
              <Button
                variant="ghost"
                className="ml-auto text-muted-foreground"
                onClick={() => setMode("rejected")}
                disabled={pending}
              >
                Reject
              </Button>
            </div>
          ) : (
            <div className="space-y-3 border-t pt-4">
              <div className="space-y-2">
                <Label htmlFor="reason">
                  {mode === "returned"
                    ? "What do you need from them?"
                    : "Why can this not be taken on?"}
                </Label>
                <Textarea
                  id="reason"
                  rows={4}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder={
                    mode === "returned"
                      ? "e.g. The brief mentions three sizes but only lists two. Which is the third?"
                      : "e.g. This needs video production, which is outside what this team does."
                  }
                />
                <p className="text-xs text-muted-foreground">
                  This is emailed to the requester word for word. They have no other channel.
                </p>
              </div>

              {mode === "rejected" ? (
                <p className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  Rejecting is final — this request cannot be reopened. If the work could go ahead
                  with changes, return it instead.
                </p>
              ) : null}

              <div className="flex items-center gap-2">
                <Button
                  variant={mode === "rejected" ? "destructive" : "default"}
                  onClick={decideNegative}
                  loading={pending}
                  disabled={reason.trim().length < 10}
                >
                  {mode === "returned" ? "Return to requester" : "Reject this request"}
                </Button>
                <Button variant="ghost" onClick={() => setMode("approve")} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {formError ? (
            <p
              role="alert"
              className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
            >
              {formError}
            </p>
          ) : null}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* P2-02 — the capacity panel. This is the feature.                  */}
        {/* ---------------------------------------------------------------- */}
        <aside className="rounded-lg border bg-muted/30 p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Who has room
          </h3>

          {capacity.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Nobody is assigned to this department yet.
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {capacity.map((row) => {
                const isSelected = row.user_id === assigneeId;
                return (
                  <li key={row.user_id}>
                    <button
                      type="button"
                      onClick={() => setAssigneeId(row.user_id)}
                      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                        isSelected
                          ? "border-primary bg-background"
                          : "border-transparent bg-background/60 hover:border-border"
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">{row.full_name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {row.open_count} open
                        </span>
                      </div>

                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs">
                        {/* The number that actually answers the question. */}
                        {targetDate ? (
                          <span
                            className={
                              row.due_before > 0 ? "font-medium text-warning" : "text-muted-foreground"
                            }
                          >
                            {row.due_before} due before {formatDate(targetDate)}
                          </span>
                        ) : null}
                        {row.overdue_count > 0 ? (
                          <span className="font-medium text-destructive">
                            {row.overdue_count} already overdue
                          </span>
                        ) : null}
                      </div>

                      {row.next_due_dates.length > 0 ? (
                        <div className="mt-1 text-2xs text-muted-foreground">
                          Next: {row.next_due_dates.map((date) => formatDate(date)).join(" · ")}
                        </div>
                      ) : (
                        <div className="mt-1 text-2xs text-muted-foreground">Nothing scheduled</div>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {selected && targetDate && selected.due_before > 0 ? (
            <p className="mt-3 rounded-sm bg-warning-subtle px-2.5 py-2 text-2xs text-warning">
              {selected.full_name.split(" ")[0]} already has {selected.due_before} due on or before{" "}
              {formatDate(approvedDate || targetDate)}. Worth negotiating the date rather than
              stacking it.
            </p>
          ) : null}

          {selected && selected.overdue_count > 0 ? (
            <p className="mt-2 rounded-sm bg-destructive/10 px-2.5 py-2 text-2xs text-destructive">
              {selected.overdue_count} of their tickets are already overdue.
            </p>
          ) : null}

          {targetDate && isOverdue(targetDate) ? (
            <p className="mt-3 text-2xs text-destructive">
              The requested date has already passed. Agree a new one before approving.
            </p>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
