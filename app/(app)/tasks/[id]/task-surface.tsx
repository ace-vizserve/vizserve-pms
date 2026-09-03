"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Check } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { Chip } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { formatDate } from "@/lib/dates";
import {
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  type TaskCategory,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/schemas/tasks";
import { formatCellDuration } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";

import { overrideTaskStatus, reassignTask } from "../actions";
import { InlineDate, InlineEstimate, InlineList, InlinePriority } from "../inline";
import { ACTION_LINK } from "./grid";
import { useTaskGate } from "./task-gate";
import { useTaskAutosave } from "./use-task-autosave";

/**
 * P7-56 — THE TASK'S MAIN PANE. One surface, in the shape the team already
 * works in (D21: what carries over from ClickUp is the SHAPE of a feature).
 *
 * ------------------------------------------------------------------------
 * WHAT THIS REPLACES, AND WHY THREE EARLIER PASSES DID NOT LAND.
 *
 * The page was four stacked panels down the content column — Brief, From the
 * request, The work, Subtasks — plus a fifth for Output files, each with its
 * own border, shadow, title and its own idea of where an action button goes.
 * The work card alone carried a state machine, the deliverable, five boxed
 * property controls in a grid, and a footer of lead-only tools.
 *
 * Three passes tried to fix that by REGROUPING inside those panels: naming
 * sections, moving the priority chip, lifting properties into a header strip,
 * then into a rail. Each was tidier and none was right, because the problem was
 * never which panel a field sat in. It was that the page is one thing — a task
 * — drawn as five competing objects.
 *
 * So: one surface, in two named halves, and the reference's order inside them.
 *
 *   DETAILS      a two-column key/value block, every value its own editor.
 *   THE WORK     the brief · the resolution · the output · the subtasks · a
 *                quiet list of action links at the bottom, together.
 *
 * ------------------------------------------------------------------------
 * P7-57 — WHAT THE REVAMP CHANGED, AND WHAT IT DID NOT.
 *
 * Two named cards rather than one long one. The properties and the work are
 * both things you read, but you read them for different reasons — "who is on
 * this and when is it due" against "what was asked for and what was done" — and
 * an unbroken column of ten property rows running straight into a textarea gave
 * neither a heading to find it by.
 *
 * ⚠️ STATUS AND THE PROMOTED MOVE LEFT THIS FILE. They are the page's one
 * primary action and they now sit beside the title (`task-header.tsx`). What
 * that costs is that the P3-07 gate spans two components — the button up there,
 * the resolution down here — so `resolutionMissing` and the autosave flush both
 * travel through `useTaskGate`. The gate's REASON is still visible with the
 * button, which is what P3-07 actually asks for; see `task-gate.tsx`.
 */

const NONE = "__none__";

type Person = { id: string; full_name: string };

/**
 * One property: a fixed-width label with its value RIGHT NEXT TO IT.
 *
 * ⚠️ THE PAIR IS ONE FLEX ITEM, not two cells of a page-wide grid. An earlier
 * cut used `grid-cols-[6rem_1fr_6rem_1fr]` across the page, so each value
 * column took half the free width — "PIC" at the margin and the name 120px
 * away, with six hundred pixels of nothing before the next pair. The design
 * system already names this: columns drifting apart is a COLUMN WIDTH problem,
 * so the label is `w-24` and the value follows immediately. Free space falls
 * between whole pairs, where it reads as a gutter rather than a gap.
 */
function Prop({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3", className)}>
      <dt className="w-24 shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">{children}</dd>
    </div>
  );
}

/** A section heading on the pane. Quiet, but darker than the prose under it. */
function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-xs font-semibold text-foreground">{children}</h3>;
}

export function TaskSurface({
  taskId,
  status,
  category,
  resolution: initialResolution,
  startDate,
  dueDate,
  estimateMinutes,
  trackedMinutes,
  priority,
  listId,
  lists,
  assigneeId,
  qaAssigneeId,
  picName,
  qaName,
  candidates,
  canReassign,
  resolutionGates,
  late,
  request,
  viewer,
  brief,
  requestPanel,
  outputs,
  subtasks,
  actions,
}: {
  taskId: string;
  /**
   * Only the OVERRIDE needs this now — it seeds the "move to" list and drops the
   * current status out of it. The status a reader sees, and every legal move,
   * live in the header (P7-57).
   */
  status: TaskStatus;
  /**
   * Which of the three lifecycles this is on. It decides WHICH PROPERTIES EXIST
   * — a client task has a requester, a reference and a date the client asked
   * for; internal work has none of them; personal work has no QA reviewer,
   * because it is closed by the person who made it (P7-01).
   *
   * ⚠️ ALWAYS FROM `taskCategory`, NEVER FROM WHETHER `request` CAME BACK. The
   * requests policy is not the tasks policy, so a PIC can hold a client task
   * whose originating request row they cannot read — and a page that decides
   * the KIND of work from a null row calls that task internal, hides Gate 3,
   * and contradicts the lifecycle rail beside it.
   */
  category: TaskCategory;
  resolution: string;
  startDate: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  /**
   * P7-15. Minutes logged by EVERYONE, from `vizserve_pms_task_time_tracked` —
   * never a sum of `timesheet_entries`, whose policy is owner-or-their-lead and
   * would show each viewer a different total for the same task.
   */
  trackedMinutes: number;
  priority: TaskPriority | null;
  listId: string | null;
  lists: { id: string; name: string }[];
  assigneeId: string | null;
  qaAssigneeId: string | null;
  picName: string | null;
  qaName: string | null;
  /** The department's own people — the same set the server will accept. */
  candidates: Person[];
  /** Reassignment is a lead decision, not self-service. */
  canReassign: boolean;
  /**
   * P7-60 — a move this task can legally make right now needs the resolution
   * filled in. It decides whether the empty box gets a WARNING or just a hint.
   *
   * Computed by the page from `availableTransitions` rather than here: the
   * surface no longer holds any status-driven transition state — that all went
   * to the header with the status control — and re-deriving it would mean
   * handing this component `viewer` and `task` back for one boolean.
   */
  resolutionGates: boolean;
  late: boolean;
  /**
   * P7-59 — TWO SOURCES BEHIND ONE PROP, and the nullable members are the seam.
   *
   * The whole object is null only on work with no client. On a client task it is
   * always present, because `reference_no` and `target_date` come from
   * `vizserve_pms_task_request_brief`, which reaches everyone holding a seat.
   *
   * `id` and `requester_name` come from the request ROW, which RLS gives to the
   * department's LEADS alone — so they are null for a member PIC, and that is
   * deliberate rather than a failure: the client is never told who at VizServe
   * holds their task, and the anonymity runs both ways. Null here means "you may
   * not see who asked", never "nobody asked".
   */
  request: {
    /** Null where the caller may not open `/requests/[id]` — so no dead link. */
    id: string | null;
    reference_no: string;
    /** Identity. Null for everyone but a department lead. */
    requester_name: string | null;
    requester_org: string | null;
    target_date: string | null;
  } | null;
  viewer: {
    isAssignee: boolean;
    isQa: boolean;
    leadsDepartment: boolean;
    isAdmin: boolean;
    /**
     * P8-01c — holds the Admin tick on THIS task's department.
     *
     * ⚠️ A FIELD OF ITS OWN AND NOT A WIDENING OF `leadsDepartment`, which would
     * have been one character and four powers. That flag also gates `canEdit`
     * (rename, every field, uploads, subtasks) and `canReassign` — none of which
     * Amier confirmed for the tick. Only the force-status link below reads this.
     */
    administersDepartment: boolean;
  };
  /*
   * SLOTS, all rendered by the page and passed in finished.
   *
   * The alternative was threading attachments, form fields, subtask rows and
   * their permission tests through here, which would make this component a
   * part-owner of four lists it does not otherwise touch. It owns the SURFACE
   * and the fields whose state the status gate depends on; everything else
   * stays with the component that already knows about it.
   */
  brief?: React.ReactNode;
  requestPanel?: React.ReactNode;
  outputs?: React.ReactNode;
  subtasks?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const router = useRouter();
  /**
   * P7-55. `moving`, not `pending`, and it covers ONLY the status moves and the
   * override — transitions that must disable each other, because two in flight
   * at once is a race the state machine should never see.
   *
   * ⚠️ IT MUST NOT DISABLE A FIELD. The old shared `pending` did, and under
   * autosave that is the one change that makes this page feel broken: disabling
   * a focused textarea mid-save blurs it and drops the caret to position 0.
   */
  const [moving, startTransition] = useTransition();
  const autosave = useTaskAutosave(taskId);
  const gate = useTaskGate();

  const [resolution, setResolution] = useState(initialResolution);

  /*
   * THE HEADER'S BUTTON HAS TO BE ABLE TO COMMIT THIS TEXTAREA.
   *
   * A mouse click on "Send for QA" blurs the box and flushes it; the keyboard
   * path does not, and that produces the worst failure on this page — a
   * resolution typed and the move refused because the column is still empty,
   * with the text plainly on screen. Registered once; cleared on unmount so a
   * stale closure cannot outlive the component that owns the autosave.
   */
  useEffect(() => {
    gate.registerFlush(() => autosave.flush());
    return () => gate.registerFlush(null);
  }, [gate, autosave]);

  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideStatus, setOverrideStatus] = useState<TaskStatus>(status);
  const [overrideReason, setOverrideReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [reassignOpen, setReassignOpen] = useState(false);
  const [reassigning, startReassign] = useTransition();
  const [pic, setPic] = useState(assigneeId ?? NONE);
  const [qa, setQa] = useState(qaAssigneeId ?? NONE);
  const [reassignError, setReassignError] = useState<string | null>(null);

  /*
   * ⚠️ Base UI's SelectValue renders the RAW VALUE unless the Select root is
   * given `items`. The `<SelectItem>` children fill the POPUP; this fills the
   * TRIGGER — without it these show a bare UUID, the literal "__none__", or the
   * raw enum "FOR_QA" where "Waiting for QA" belongs.
   */
  const statusItems = Object.fromEntries(
    TASK_STATUSES.map((option) => [option, TASK_STATUS_LABELS[option]]),
  );
  const peopleItems = Object.fromEntries(candidates.map((person) => [person.id, person.full_name]));
  const picItems = { [NONE]: "Unassigned", ...peopleItems };
  const qaItems = { [NONE]: "No QA reviewer", ...peopleItems };

  const canEdit = viewer.isAssignee || viewer.isQa || viewer.leadsDepartment;

  /**
   * Q5's override, widened by P8-01c.
   *
   * Kept apart from `canEdit` above deliberately: forcing a status is data
   * hygiene on the department's board, and editing the task is work on it. The
   * tick confers the first and not the second.
   */
  const canForce = viewer.leadsDepartment || viewer.administersDepartment;
  const savingResolution = autosave.stateOf("resolution") === "saving";
  const overEstimate = estimateMinutes !== null && trackedMinutes > estimateMinutes;
  const reassignUnchanged = pic === (assigneeId ?? NONE) && qa === (qaAssigneeId ?? NONE);

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

  function openReassign() {
    // Seeded on open, so a change made in another tab is not overwritten by a
    // stale draft sitting in this component.
    setPic(assigneeId ?? NONE);
    setQa(qaAssigneeId ?? NONE);
    setReassignError(null);
    setReassignOpen(true);
  }

  function saveReassign() {
    setReassignError(null);
    startReassign(async () => {
      const result = await reassignTask(taskId, {
        assignee_id: pic === NONE ? null : pic,
        qa_assignee_id: qa === NONE ? null : qa,
      });
      if (!result.ok) {
        setReassignError(result.error ?? "That did not go through.");
        return;
      }
      toast.success("Reassigned");
      setReassignOpen(false);
      router.refresh();
    });
  }

  /* ------------------------------------------------------------------ */
  /* P7-55 — the field writer. Free text SCHEDULES (debounced, flushed on */
  /* blur); every discrete control COMMITS on its own single event. The   */
  /* resolution is the only free-text field left on this surface — the    */
  /* output link moved into `TaskOutputs` and saves from a dialog (P7-57).*/
  /* ------------------------------------------------------------------ */

  function writeResolution(next: string) {
    setResolution(next);
    autosave.schedule("resolution", next, {
      // Nothing else renders the resolution, and the one thing that depends on
      // it — the gate — is held in `savedResolution` below.
      refresh: false,
      // No `onRefused`. Restoring the old text would delete what somebody is
      // still typing in order to report a failure the toast already reports.
    });
    // Optimistic for the gate only, and it travels to the header's button
    // through the context. A refusal toasts and the next real read corrects it —
    // better than the move staying blocked after a save that worked.
    gate.setSavedResolution(next);
  }

  /* ------------------------------------------------------------------ */
  /* The property values.                                                */
  /* ------------------------------------------------------------------ */

  const person = (name: string | null, empty: string) =>
    canReassign ? (
      <button
        type="button"
        onClick={openReassign}
        aria-label={`${name ?? empty}. Reassign this task.`}
        className={cn(
          "-mx-1 min-w-0 truncate rounded-sm px-1 py-0.5 text-left",
          "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
          name ? undefined : "text-muted-foreground",
        )}>
        {name ?? empty}
      </button>
    ) : (
      <span className={cn("min-w-0 truncate", name ? undefined : "text-muted-foreground")}>
        {name ?? empty}
      </span>
    );

  const dates = (
    <>
      {canEdit ? (
        <InlineDate taskId={taskId} field="start_date" value={startDate} label="Start" />
      ) : (
        <span className="text-muted-foreground">{startDate ? formatDate(startDate) : "—"}</span>
      )}
      <ArrowRight className="size-3.5 shrink-0 text-foreground-faint" aria-hidden />
      {canEdit ? (
        <InlineDate taskId={taskId} field="due_date" value={dueDate} label="Due" emphasis={late} />
      ) : (
        <span className={cn(late ? "font-medium text-destructive" : "text-muted-foreground")}>
          {dueDate ? formatDate(dueDate) : "—"}
        </span>
      )}
      {/* Never colour alone — the state is named, not just tinted. */}
      {late ? <span className="shrink-0 text-2xs text-destructive">overdue</span> : null}
    </>
  );

  const estimate = (
    <>
      {canEdit ? (
        <InlineEstimate taskId={taskId} minutes={estimateMinutes} />
      ) : (
        <span className="text-muted-foreground">
          {estimateMinutes === null ? "—" : formatCellDuration(estimateMinutes)}
        </span>
      )}
      {/* HIDDEN WHEN NOTHING IS LOGGED, never a permanent "0h of 6h" — a figure
          that reads zero on most tasks is one people stop reading. */}
      {trackedMinutes > 0 ? (
        <span
          className={cn(
            "text-2xs tabular-nums",
            overEstimate ? "font-medium text-warning" : "text-muted-foreground",
          )}>
          {formatCellDuration(trackedMinutes)} logged
          {overEstimate
            ? ` · over +${formatCellDuration(trackedMinutes - estimateMinutes!)}`
            : null}
        </span>
      ) : null}
    </>
  );

  return (
    <>
      {/* ============================================================== */}
      {/* DETAILS — who is on it, what it belongs to, when it is due.     */}
      {/* Every value is its own editor; nothing here is prose.           */}
      {/* ============================================================== */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>Details</CardTitle>
          {/* The surface's one save mark, in the fixed `CardAction` slot so it
              cannot shift the layout the way an inline status would. It reports
              every autosaved field on the page, not only the ones in this card —
              there is one autosave, and one place it speaks. */}
          {canEdit ? (
            <CardAction>
              <span
                aria-live="polite"
                className="flex items-center gap-1 text-2xs text-muted-foreground">
                {autosave.busy ? (
                  "Saving…"
                ) : autosave.justSaved ? (
                  <>
                    <Check className="size-3 text-success" aria-hidden />
                    Saved
                  </>
                ) : null}
              </span>
            </CardAction>
          ) : null}
        </CardHeader>

        <CardContent>
          <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
            {/* KIND FIRST, because it decides which of the rows below exist at
                all — and because it is the fact that tells a reader whether a
                client is waiting at the end of this. `category`, never the
                fetched request row; see the prop's own note. */}
            <Prop label="Kind">
              <Chip
                tone={
                  category === "request" ? "info" : category === "personal" ? "neutral" : "brand"
                }
                label={
                  category === "request"
                    ? "Client work"
                    : category === "personal"
                      ? "Your own task"
                      : "Internal work"
                }
              />
            </Prop>

            {/* ---------------------------------------------------------- */}
            {/* THE CLIENT, and only on client work. `category`, never the   */}
            {/* fetched row — see the prop's own note.                       */}
            {/*                                                              */}
            {/* P7-59 — THE REFERENCE AND THE CLIENT'S DATE ARE ALWAYS HERE.  */}
            {/* They come from the brief, which reaches everyone on the task. */}
            {/* WHO ASKED does not: `vizserve_pms_requests` is readable by the */}
            {/* department's LEADS, deliberately, because the client is never  */}
            {/* told who at VizServe holds their task and the anonymity is     */}
            {/* meant to run both ways.                                       */}
            {/*                                                              */}
            {/* ⚠️ SO THE ABSENT NAME IS NAMED, NOT DASHED. A dash says "this  */}
            {/* client has no name", which is impossible — `requester_name` is */}
            {/* required on the public form. And it is NOT "Confidential" and  */}
            {/* not a padlock: there is no confidentiality flag on a request   */}
            {/* and nothing sets one. It is a scope, identical on every client */}
            {/* task, so the row says whose it is to see and moves on.        */}
            {/* ---------------------------------------------------------- */}
            {category === "request" && request ? (
              <>
                <Prop label="Request">
                  {request.id ? (
                    <Link
                      href={`/requests/${request.id}`}
                      className="min-w-0 truncate tabular-nums underline-offset-2 hover:underline">
                      {request.reference_no}
                    </Link>
                  ) : (
                    // NOT A LINK. `/requests/[id]` is behind the same policy, so
                    // linking there would be offering a door that 404s.
                    <span className="min-w-0 truncate tabular-nums">{request.reference_no}</span>
                  )}
                </Prop>

                <Prop label="Client">
                  {request.requester_name ? (
                    <span className="min-w-0 truncate">
                      {request.requester_name}
                      {request.requester_org ? (
                        <span className="text-muted-foreground"> · {request.requester_org}</span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="min-w-0 text-muted-foreground">With the team leader</span>
                  )}
                </Prop>
              </>
            ) : null}

            <Prop label="PIC">{person(picName, "Unassigned")}</Prop>

            {/* NO QA ROW ON PERSONAL WORK. It is closed by the person who made
                it (P7-01) — naming a reviewer with no part in it is worse than
                saying nothing. */}
            {category === "personal" ? null : <Prop label="QA">{person(qaName, "Not set")}</Prop>}

            <Prop label="Dates">{dates}</Prop>

            {/* ⚠️ NOT THE DUE DATE, and that is why it sits beside it. The
                client named a date on the form; the team set its own. They are
                routinely different, and Gate 3 is judged against the client's.
                The old layout kept this behind a collapsed card and the due date
                in the page header, so the two numbers that most needed comparing
                were never on screen together. */}
            {/* P7-59 — AND IT REACHES EVERYONE ON THE TASK. It comes from the
                brief rather than the request row, so a member PIC now schedules
                against the date the client actually asked for instead of only
                the team's own due date beside it. "No date given" means what it
                says again — the client left the field blank — rather than
                doubling as "you are not allowed to know". */}
            {category === "request" && request ? (
              <Prop label="Client wants">
                {request.target_date ? (
                  <span className="tabular-nums">{formatDate(request.target_date)}</span>
                ) : (
                  <span className="text-muted-foreground">No date given</span>
                )}
              </Prop>
            ) : null}

            <Prop label="Priority">
              {canEdit ? (
                <InlinePriority taskId={taskId} value={priority} />
              ) : priority ? (
                <span>{TASK_PRIORITY_LABELS[priority]}</span>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </Prop>

            <Prop label="Estimate">{estimate}</Prop>

            {lists.length > 0 ? (
              <Prop label="List">
                {canEdit ? (
                  <InlineList taskId={taskId} value={listId} lists={lists} />
                ) : (
                  <span className="min-w-0 truncate">
                    {lists.find((list) => list.id === listId)?.name ?? (
                      <span className="text-muted-foreground">No list</span>
                    )}
                  </span>
                )}
              </Prop>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      {/* ============================================================== */}
      {/* THE WORK — what was asked for, what you did, and where it is.   */}
      {/* ============================================================== */}
      <Card size="sm">
        <CardHeader>
          <CardTitle>The work</CardTitle>
        </CardHeader>

        <CardContent className="space-y-5">
          {/* ============================================================== */}
          {/* THE BRIEF — what was asked for. Passed in by the page.          */}
          {/* ============================================================== */}
          {brief}
          {requestPanel}

          {/* ============================================================== */}
          {/* RESOLUTION — what you did.                                      */}
          {/* ============================================================== */}
          <section className="space-y-2">
            <Heading>Resolution</Heading>
            <RichTextEditor
              ariaLabel="Resolution"
              value={resolution}
              disabled={!canEdit}
              onChange={writeResolution}
              onBlur={() => void autosave.flush("resolution")}
              minHeight="min-h-24"
              placeholder="What did you actually do? For collateral, a link is fine. For a fix, say what was wrong and what you changed."
            />
            {/*
              THREE STATES UNDER ONE BOX, and the order is what makes it read.

              SAVING is information, not a blocker — no warning tone and no icon.
              It clears itself in under a second, and picking the move commits
              this field first anyway, so dressing it as a problem would be a
              warning that appears while you type and then leaves on its own.

              THE GATE is a warning, and it is HERE rather than in the page
              header (P7-60). It used to sit under the promoted "Send for QA" and
              read "fill in the resolution, under The work" — a sentence whose
              main job was to point somewhere else on the page. Now that the move
              lives in the status menu there is no button for it to stand beside,
              and the honest place for "this is empty and it is stopping you" is
              the empty box.

              §4.2 — `disabled` is never the only explanation. The menu row greys
              out with "needs a resolution" next to it; this is the same fact,
              where the work actually happens.
            */}
            {savingResolution ? (
              <p className="text-2xs text-muted-foreground">Saving the resolution…</p>
            ) : resolutionGates && gate.resolutionMissing ? (
              <p className="flex items-start gap-1.5 text-xs text-warning">
                {/* The icon is the second, non-colour carrier (§5.5). */}
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Fill this in to send the task for QA.
              </p>
            ) : (
              <p className="text-2xs text-muted-foreground">
                Required before QA. The reviewer reads it, and the client eventually sees it.
              </p>
            )}
          </section>

          {/* ============================================================== */}
          {/* OUTPUT — where it is. THE LINK AND THE FILES ARE ONE LIST.      */}
          {/*                                                                 */}
          {/* They were the same question asked twice — a URL field here, a   */}
          {/* file list under it — and neither said so, which asked the reader */}
          {/* to classify their own deliverable before they could record it.  */}
          {/* P7-57 made them one section behind one "Add output" menu, and it */}
          {/* lives inside `TaskOutputs` because that component already owned  */}
          {/* the upload and now owns the link too. They are not              */}
          {/* interchangeable — a pasted Drive link rots, and the Gate 3       */}
          {/* approval page cannot render one the client has no permission to  */}
          {/* open — so both survive, in one list, with one line saying which  */}
          {/* to prefer.                                                      */}
          {/* ============================================================== */}
          {outputs}

          {/* ============================================================== */}
          {/* SUBTASKS — the pieces. Passed in by the page.                   */}
          {/* ============================================================== */}
          {subtasks}

          {/* ============================================================== */}
          {/* THE ACTIONS, in one list, in one treatment. See ACTION_LINK.    */}
          {/* ============================================================== */}
          {/* P8-01c — `canForce`, not `leadsDepartment`. A department admin may
              unstick their own department's board (`vizserve_pms_force_task_status`
              now says so) and may do NOTHING ELSE this flag used to imply. */}
          {actions || canForce ? (
            <div className="flex flex-col items-start gap-2 border-t pt-3">
              {actions}
              {canForce && !overrideOpen ? (
                <button type="button" onClick={() => setOverrideOpen(true)} className={ACTION_LINK}>
                  <AlertTriangle className="size-3.5" aria-hidden />
                  Force a different status
                </button>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}

          {/* Q5 — the override, opened from the action list directly above it.
              The panel sits WITH ITS TRIGGER rather than at the top of the page
              beside a status that no longer lives on this card, so pressing the
              link does not scroll a panel into view somewhere else. */}
          {overrideOpen ? (
            <div className="space-y-2.5 rounded-md border border-warning/40 bg-warning-subtle/40 p-3">
              <p className="flex items-start gap-2 text-xs text-warning">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                This skips the normal stages. It is recorded as forced, with your reason, and stays
                visible in the history for good.
              </p>

              <div className="grid gap-3 sm:grid-cols-[14rem_1fr]">
                <div className="space-y-2">
                  <Label htmlFor="override_status">Move to</Label>
                  <Select
                    items={statusItems}
                    value={overrideStatus}
                    onValueChange={(value) => setOverrideStatus(value as TaskStatus)}>
                    <SelectTrigger id="override_status" className="w-full">
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

                <div className="space-y-2">
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
                  loading={moving}
                  disabled={overrideReason.trim().length < 10}
                  title={
                    overrideReason.trim().length < 10
                      ? "Give a reason of at least ten characters."
                      : undefined
                  }>
                  Force it
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setOverrideOpen(false)}
                  disabled={moving}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>

        {/*
        ONE DIALOG, opened by either name in the properties. AN EXPLICIT SAVE,
        not two Selects that write on change: the collapsed disclosure this
        replaced fired `reassignTask` from each `onValueChange` with no
        confirmation step, which was the easiest accidental mis-click on a page
        that autosaves everything else.
      */}
        <Dialog open={reassignOpen} onOpenChange={setReassignOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Reassign this task</DialogTitle>
              <DialogDescription>
                Both go in one change. Only people in this task&apos;s department can be given it.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="new_pic">Person in charge</Label>
                <Select
                  items={picItems}
                  value={pic}
                  disabled={reassigning}
                  onValueChange={(value) => value !== null && setPic(value)}>
                  <SelectTrigger id="new_pic" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>Unassigned</SelectItem>
                    {candidates.map((each) => (
                      <SelectItem key={each.id} value={each.id}>
                        {each.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="new_qa">QA reviewer</Label>
                <Select
                  items={qaItems}
                  value={qa}
                  disabled={reassigning}
                  onValueChange={(value) => value !== null && setQa(value)}>
                  <SelectTrigger id="new_qa" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>No QA reviewer</SelectItem>
                    {candidates.map((each) => (
                      <SelectItem key={each.id} value={each.id}>
                        {each.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {reassignError ? (
                <p role="alert" className="text-xs text-destructive">
                  {reassignError}
                </p>
              ) : null}

              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  disabled={reassigning}
                  onClick={() => setReassignOpen(false)}>
                  Cancel
                </Button>
                {/* `disabled` is never the only explanation (§4.2) — the two
                  Selects above already show that nothing has changed. */}
                <Button
                  loading={reassigning}
                  disabled={reassignUnchanged}
                  title={reassignUnchanged ? "Nothing has been changed yet." : undefined}
                  onClick={saveReassign}>
                  Save
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </Card>
    </>
  );
}
