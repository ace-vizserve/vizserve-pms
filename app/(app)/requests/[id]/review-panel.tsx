"use client";

import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { toast } from "@/components/ui/toast";


import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
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
import { addBusinessDays, formatDate, todayInAppZone } from "@/lib/dates";
import { richTextLength } from "@/lib/rich-text";
import { CharacterCount } from "@/components/ui/character-count";
import { DECISION_REASON_MAX, DECISION_REASON_MIN } from "@/lib/schemas/approvals";
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

const NO_QA = "__none__";

export function ReviewPanel({
  requestId,
  requestTitle,
  requestDescription,
  targetDate,
  urgentDays,
  normalDays,
  candidates,
  capacity,
  currentUserId,
  currentUserName,
  listName,
}: {
  requestId: string;
  requestTitle: string;
  requestDescription: string;
  /** P16-04 — the client's IDEAL finish date. Shown, never scheduled on. */
  targetDate: string | null;
  /** P16-05 — the form's working days to the SLA date, by urgency. */
  urgentDays: number;
  normalDays: number;
  /*
   * P8-10 — the requester's details are NO LONGER PASSED DOWN.
   *
   * They existed only to build a client email in the browser. That send now
   * happens on the server, through `sendEmail()` and whichever transport is
   * selected, so the approval contract goes back to being about the approval.
   */
  /** Department members who can be PIC. */
  candidates: Person[];
  capacity: CapacityRow[];
  currentUserId: string;
  currentUserName: string;
  /** P16-02 — the form's own list; approval always files there. */
  listName: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [assigneeId, setAssigneeId] = useState<string>("");
  // P2-05 — defaults to the approving TL, overridable to any member of the
  // department (Amier 41:30). Defaulting to nobody would leave most tasks with
  // no second pair of eyes, which is the failure this gate exists to prevent.
  const [qaAssigneeId, setQaAssigneeId] = useState<string>(currentUserId);
  /*
   * P16-05 — the urgency, and the SLA date it gives. The date is a PREVIEW:
   * `vizserve_pms_approve_request` computes the real one with the holiday table.
   */
  const [urgency, setUrgency] = useState<"URGENT" | "NON_URGENT" | "">("");
  const slaDate = urgency ? addBusinessDays(todayInAppZone(), urgency === "URGENT" ? urgentDays : normalDays) : null;

  /*
   * value → label maps for the three Selects below.
   *
   * ⚠️ Base UI's SelectValue renders the RAW VALUE unless the Select root is
   * given `items`. The `<SelectItem>` children fill the POPUP; this fills the
   * TRIGGER. Without it the closed control on the Gate 1 screen showed a bare
   * UUID where the person's name belongs.
   *
   * The PIC map carries no capacity suffix on purpose — "Ana Cruz · 4 open"
   * helps while choosing and is noise once chosen.
   */
  const assigneeItems = Object.fromEntries(
    candidates.map((person) => [person.id, person.full_name]),
  );
  const qaItems = {
    [currentUserId]: `${currentUserName} (you)`,
    [NO_QA]: "No QA reviewer",
    ...Object.fromEntries(
      candidates
        .filter((person) => person.id !== currentUserId)
        .map((person) => [person.id, person.full_name]),
    ),
  };
  const [title, setTitle] = useState(requestTitle);
  const [description, setDescription] = useState(requestDescription);

  const [mode, setMode] = useState<"approve" | "returned" | "rejected">("approve");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const capacityFor = (userId: string) => capacity.find((row) => row.user_id === userId);
  const selected = assigneeId ? capacityFor(assigneeId) : undefined;


  /*
   * P11-05 — the panel says which way it went, on the click.
   *
   * ⚠️ IT NAMES THE DECISION, NOT THE OUTCOME. Approving here does not simply
   * flip a status: `vizserve_pms_approve_request` creates a task, mails the PIC
   * and mails the client, and the sentence in the toast below reports all three.
   * Predicting any of that would be inventing facts about work that has not
   * happened. What is certain is which button was pressed.
   *
   * The whole review form is replaced by it, because the alternative is a live
   * Approve button sitting under a request that has already been approved.
   */
  const [taken, setTaken] = useOptimistic<"approved" | "returned" | "rejected" | null>(null);

  function run(payload: Record<string, unknown>) {
    setFormError(null);

    startTransition(async () => {
      setTaken(payload.decision as "approved" | "returned" | "rejected");

      const result = await decideOnRequest(requestId, payload);

      if (!result.ok) {
        // React puts the form back, carrying the reason.
        setFormError(result.error);
        return;
      }


      /* ⚠️ Holds the transition open until the fresh data lands — without it
         `useOptimistic` reverts the moment the action resolves. See
         `tasks/inline.tsx` for the full account. */
      router.refresh();
      toast.success(
        result.data.status === "APPROVED"
          ? "Approved — the task is created, and the PIC and the client have been told."
          : result.data.status === "RETURNED"
            ? "Returned. The requester has been emailed the reason."
            : "Rejected. The requester has been emailed the reason.",
      );
    });
  }

  function approve() {
    run({
      decision: "approved",
      assignee_id: assigneeId || undefined,
      qa_assignee_id: qaAssigneeId === NO_QA ? null : qaAssigneeId,
      urgency: urgency || undefined,
      // Only send an edit if it is one. Null means unchanged.
      title: title.trim() !== requestTitle ? title.trim() : null,
      description: description.trim() !== requestDescription ? description.trim() : null,
    });
  }

  function decideNegative() {
    run({ decision: mode, reason });
  }

  if (taken) {
    /* ⚠️ THE WHOLE FORM GOES, not just the buttons. The alternative is a live
       Approve sitting under a request that has already been approved, which is
       an invitation to press it twice. */
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your decision</CardTitle>
          <CardDescription className="text-xs" aria-live="polite">
            {taken === "approved"
              ? "Approving — creating the task and emailing the PIC and the client."
              : taken === "returned"
                ? "Returning — emailing the requester your reason."
                : "Rejecting — emailing the requester your reason."}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Your decision</CardTitle>
        <CardDescription className="text-xs">
          Check the load before you commit someone to a date.
        </CardDescription>
      </CardHeader>

      <CardContent className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        {/* ---------------------------------------------------------------- */}
        {/* The decision                                                      */}
        {/* ---------------------------------------------------------------- */}
        <div className="space-y-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="assignee">Person in charge</Label>
              {/* ⚠️ `setAssigneeId(v)`, not `(v)`. All three Selects in this file
                  shipped with a handler that evaluated the new value and threw it
                  away, so the Gate 1 review screen could not change its PIC, its
                  QA reviewer or its list at all. The PIC had a second route in
                  (clicking a row in the capacity table below); the other two had
                  none. Committed in f4abc5c and unnoticed since. */}
              <Select
                items={assigneeItems}
                value={assigneeId}
                onValueChange={(v) => v !== null && setAssigneeId(v)}
              >
                <SelectTrigger id="assignee" className="w-full">
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
              <Select
                items={qaItems}
                value={qaAssigneeId}
                onValueChange={(v) => v !== null && setQaAssigneeId(v)}
              >
                <SelectTrigger id="qa" className="w-full">
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
            <Label>Urgency</Label>
            <Segmented<"URGENT" | "NON_URGENT">
              value={urgency || undefined}
              onValueChange={(value) => setUrgency(value)}
              aria-label="Urgency">
              <SegmentedItem className="px-3 py-1" value="URGENT">
                Urgent · {urgentDays}d
              </SegmentedItem>
              <SegmentedItem className="px-3 py-1" value="NON_URGENT">
                Non-urgent · {normalDays}d
              </SegmentedItem>
            </Segmented>
            <p className="text-xs text-muted-foreground">
              {slaDate ? (
                <>
                  Due <span className="font-medium text-foreground">{formatDate(slaDate)}</span> — {urgency === "URGENT" ? urgentDays : normalDays} working days from today. Set by the urgency; it cannot be typed.
                </>
              ) : (
                "Sets the due date in working days. The team is measured against it."
              )}
              {targetDate ? <> The client would ideally like it by {formatDate(targetDate)}.</> : null}
            </p>
          </div>

          <p className="text-xs text-muted-foreground">
            {listName ? (
              <>
                Files into <span className="font-medium text-foreground">{listName}</span>, this form&rsquo;s list.
              </>
            ) : (
              "This form has no list yet — publish it once so its list is created."
            )}
          </p>

          <Collapsible className="rounded-md border px-3 py-2">
            <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              Correct a typo in the title or description
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0 transition-transform group-aria-expanded:rotate-90"
              />
            </CollapsibleTrigger>
            <CollapsibleContent className="mt-3 space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="edit_title">Title</Label>
                <Input
                  id="edit_title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                {/* No `htmlFor` — the editor's input is a contenteditable,
                    which is not a labelable element. */}
                <Label>Description</Label>
                <RichTextEditor
                  value={description}
                  onChange={setDescription}
                  ariaLabel="Description"
                  minHeight="min-h-24"
                />
              </div>
              {/* Every edit is written to the audit log with before and after. */}
              <p className="text-xs text-muted-foreground">
                Edits are recorded with the original text alongside them.
              </p>
            </CollapsibleContent>
          </Collapsible>

          {/* ⚠️ THE FORMS ARE EMPTY AND OUT OF THE FLOW. Their submit buttons
              reference them by `form="id"`, which is what lets a form action be
              used without wrapping a button that sits in a flex row beside
              others — wrapping would change the row. */}
          <form id="gate1-approve" action={approve} className="hidden" />
          <form id="gate1-negative" action={decideNegative} className="hidden" />

          {mode === "approve" ? (
            <div className="flex flex-wrap items-center gap-2 border-t pt-4">
              {/* Form actions, so React owns the transition and the decision
                   still submits before this route's JS has loaded. */}
              <Button type="submit" form="gate1-approve" loading={pending} disabled={!assigneeId || !urgency}>
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
                <Label>
                  {mode === "returned"
                    ? "What do you need from them?"
                    : "Why can this not be taken on?"}
                </Label>
                <RichTextEditor
                  value={reason}
                  onChange={setReason}
                  ariaLabel={
                    mode === "returned"
                      ? "What do you need from them?"
                      : "Why can this not be taken on?"
                  }
                  minHeight="min-h-24"
                  placeholder={
                    mode === "returned"
                      ? "e.g. The brief mentions three sizes but only lists two. Which is the third?"
                      : "e.g. This needs video production, which is outside what this team does."
                  }
                />
                <CharacterCount
                  value={reason}
                  min={DECISION_REASON_MIN}
                  max={DECISION_REASON_MAX}
                  rich
                />
                <p className="text-xs text-muted-foreground">
                  {/* ⚠️ Still true, and the reason this field flattens rather
                      than sending markup: the email escapes every value it
                      interpolates, so a `<strong>` would arrive as five visible
                      characters. Formatting is for the staff reading it here;
                      the requester gets clean text. */}
                  This is emailed to the requester word for word, without the formatting. They have
                  no other channel.
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
                  type="submit"
                  form="gate1-negative"
                  loading={pending}
                  // ⚠️ `richTextLength`, NOT `.length`. This is a RichTextEditor,
                  // so `reason` is markup: `<p><strong>no</strong></p>` is 26
                  // characters of it and 2 of prose. Counting raw let a
                  // two-letter refusal through to a client with no other
                  // channel, and the schema counted the same tags until 7 Sep.
                  disabled={richTextLength(reason) < DECISION_REASON_MIN}
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


          {selected && selected.overdue_count > 0 ? (
            <p className="mt-2 rounded-sm bg-destructive/10 px-2.5 py-2 text-2xs text-destructive">
              {selected.overdue_count} of their tickets are already overdue.
            </p>
          ) : null}

        </aside>
      </CardContent>
    </Card>
  );
}
