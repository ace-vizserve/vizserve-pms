"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, Plus } from "lucide-react";
import { toast } from "@/components/ui/toast";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { QueryError } from "@/components/query-error";
import { CardSkeleton } from "@/components/skeletons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { formatDate, isOverdue } from "@/lib/dates";
import { richTextLength } from "@/lib/rich-text";
import { CharacterCount } from "@/components/ui/character-count";
import { browserClient } from "@/lib/query/browser-client";
import { fetchReviewContext } from "@/lib/query/fetchers/requests";
import { qk } from "@/lib/query/keys";
import { fromAction } from "@/lib/query/mutate";
import { DECISION_REASON_MAX, DECISION_REASON_MIN } from "@/lib/schemas/approvals";
import type { CapacityRow } from "@/lib/schemas/approvals";
import type { ReviewCandidate, ReviewList } from "@/lib/schemas/requests";

import { saveList } from "../../tasks/actions";
import { decideOnRequest } from "./actions";
import { focusWithoutScroll } from "@/lib/focus";

/**
 * P2-01 / P2-02 / P2-04 / P2-05 / P12-18 — the Team Leader review screen.
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
 *
 * ------------------------------------------------------------------------
 * ⚠️ P12-18 — THIS IS THE GATE 1 DECISION SURFACE AND IT IS CLIENT-VISIBLE.
 *
 * What changed is where four props came from, and nothing else about the
 * decision. The candidates, the capacity scan, the department's lists and the
 * reserved folder used to be fetched in the page's third wave and handed down;
 * they are `qk.requestPart(id, "review")` now, and this component reads them.
 * Every rule the panel enforces is unchanged and every one of them is re-checked
 * by `vizserve_pms_approve_request` — the list is mandatory, a deactivated
 * colleague cannot be PIC, the reason has a floor. Nothing here is authority.
 *
 * ⚠️ THE FOUR READS ARE STILL GATED. `vizserve_pms_department_capacity` is a
 * scan over the department's open tasks and the RSC deliberately refused to pay
 * for it on a request decided last week; `request-detail.tsx` renders this
 * component only while `status = PENDING_REVIEW`, so the query mounts only then.
 *
 * ⚠️ AND A FAILED READ MUST NOT DRAW AN EMPTY PANEL. An empty PIC picker beside
 * an empty capacity list reads as "nobody is in this department" on the screen
 * where that decides who gets the work — a lead would then approve to whoever
 * they could type, or not approve at all. `QueryError` in place of the whole
 * panel is the only honest answer, which is why `fetchReviewContext` throws
 * rather than returning empties.
 * ------------------------------------------------------------------------
 */

const NO_QA = "__none__";

/** The Server Actions, as promises TanStack can drive `onError` off. */
const decide = fromAction(decideOnRequest);
const createList = fromAction(saveList);

/**
 * ⚠️ THE OUTER COMPONENT IS THE QUERY AND NOTHING ELSE, and the split is not
 * cosmetic. Every field in the form below is seeded from something this query
 * returns — the PIC, the list, the folder — and `useState` initialisers run
 * once. A single component would seed them all from `undefined` on the first
 * render and never re-seed, so the form's default list would silently be "none"
 * on every visit. Keying the inner component on the department makes the seeding
 * a MOUNT, which is the same trick `list-manager.tsx` uses for its dialogs and
 * the reason they are unmounted while closed.
 */
export function ReviewPanel({
  requestId,
  requestTitle,
  requestDescription,
  targetDate,
  currentUserId,
  currentUserName,
  defaultListId,
  departmentId,
}: {
  requestId: string;
  requestTitle: string;
  requestDescription: string;
  targetDate: string | null;
  /*
   * P8-10 — the requester's details are NOT PASSED DOWN.
   *
   * They existed only to build a client email in the browser. That send now
   * happens on the server, through `sendEmail()` and whichever transport is
   * selected, so the approval contract goes back to being about the approval.
   */
  currentUserId: string;
  currentUserName: string;
  defaultListId: string | null;
  /** P7-23. The FORM's department — which a list created from here belongs to. */
  departmentId: string;
}) {
  /*
   * The candidates, the capacity scan, the department's lists and the reserved
   * folder. One key, one wave — see `fetchReviewContext`.
   *
   * ⚠️ `targetDate` IS PART OF THE CAPACITY QUERY BUT NOT OF THE KEY, and that
   * is deliberate. `vizserve_pms_department_capacity` takes it to compute
   * `due_before`, and it is a property of THIS REQUEST — which the key already
   * carries as `requestId`. Adding it would be adding a value that cannot vary
   * within the key.
   */
  const contextQuery = useQuery({
    queryKey: qk.requestPart(requestId, "review"),
    queryFn: () => fetchReviewContext(browserClient(), departmentId, targetDate),
  });

  /*
   * ⚠️ A FAILED READ REPLACES THE WHOLE PANEL. An empty PIC picker beside an
   * empty capacity list reads as "nobody is in this department" on the screen
   * where that decides who gets the work. See the file header.
   */
  if (contextQuery.isError) {
    return <QueryError what="who has room" message={contextQuery.error.message} />;
  }

  if (contextQuery.isPending) return <CardSkeleton lines={6} />;

  return (
    <ReviewForm
      /* Remounted if the department ever changes, so every seeded field below
         is seeded again rather than kept from another team's data. */
      key={departmentId}
      requestId={requestId}
      requestTitle={requestTitle}
      requestDescription={requestDescription}
      targetDate={targetDate}
      currentUserId={currentUserId}
      currentUserName={currentUserName}
      defaultListId={defaultListId}
      departmentId={departmentId}
      candidates={contextQuery.data.candidates}
      capacity={contextQuery.data.capacity}
      lists={contextQuery.data.lists}
      clientFolderId={contextQuery.data.clientFolderId}
    />
  );
}

function ReviewForm({
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
  departmentId,
  clientFolderId,
}: {
  requestId: string;
  requestTitle: string;
  requestDescription: string;
  targetDate: string | null;
  /** Department members who can be PIC. */
  candidates: ReviewCandidate[];
  capacity: CapacityRow[];
  currentUserId: string;
  currentUserName: string;
  /** P2-06. Empty when the department has not organised itself into lists. */
  lists: ReviewList[];
  defaultListId: string | null;
  /** P7-23. Which department a list created from here belongs to. */
  departmentId: string;
  /**
   * P7-25. The department's Client Requests folder.
   *
   * A list created during the approval belongs with the client work, not loose
   * under the department — which is where it landed before this, because
   * `saveList` was called with no `group_id` at all.
   *
   * Null only if the department somehow has no reserved folder; the list is
   * still created, just folderless, rather than the creation failing.
   */
  clientFolderId: string | null;
}) {
  const queryClient = useQueryClient();


  const [assigneeId, setAssigneeId] = useState<string>("");
  // P2-05 — defaults to the approving TL, overridable to any member of the
  // department (Amier 41:30). Defaulting to nobody would leave most tasks with
  // no second pair of eyes, which is the failure this gate exists to prevent.
  const [qaAssigneeId, setQaAssigneeId] = useState<string>(currentUserId);
  const [approvedDate, setApprovedDate] = useState<string>(targetDate ?? "");
  /*
   * P2-06 — seeded from the form's default, overridable here.
   *
   * P7-23: the empty string is "nothing chosen yet", NOT a "no list" option.
   * The Select shows its placeholder on it and `approve()` refuses it, which is
   * the same shape as the PIC field above and the same rule the database now
   * enforces.
   */
  const [listId, setListId] = useState<string>(defaultListId ?? "");
  // Lists created from here are added locally rather than waiting on a refresh,
  // so the one somebody just made is selected and selectable immediately.
  const [extraLists, setExtraLists] = useState<ReviewList[]>([]);
  const [creatingList, setCreatingList] = useState(false);
  const [newListName, setNewListName] = useState("");

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
  /*
   * The department's lists plus anything created here this session.
   *
   * ⚠️ DEDUPED BY ID, AND THAT IS NEW IN P12-18. `lists` was a prop that never
   * changed, so a list created here could only ever be in `extraLists`. It is a
   * QUERY now, and `addListMutation.onSettled` invalidates it — so the moment
   * that refetch lands the new list is in BOTH arrays, and a plain concat would
   * render two `<SelectItem>`s with the same React key and the same value.
   */
  const options = [...lists, ...extraLists].filter(
    (list, index, all) => all.findIndex((other) => other.id === list.id) === index,
  );
  const listItems = Object.fromEntries(options.map((list) => [list.id, list.name]));
  const [title, setTitle] = useState(requestTitle);
  const [description, setDescription] = useState(requestDescription);

  const [mode, setMode] = useState<"approve" | "returned" | "rejected">("approve");
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const capacityFor = (userId: string) => capacity.find((row) => row.user_id === userId);
  const selected = assigneeId ? capacityFor(assigneeId) : undefined;

  const dateMoved = Boolean(targetDate) && approvedDate !== targetDate;

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
  /*
   * ------------------------------------------------------------------------
   * P11-05 / P12-18 — THE PANEL SAYS WHICH WAY IT WENT, ON THE CLICK.
   *
   * ⚠️ IT NAMES THE DECISION, NOT THE OUTCOME. Approving here does not simply
   * flip a status: `vizserve_pms_approve_request` creates a task, mails the PIC
   * and mails the client, and the sentence in the toast reports all three.
   * Predicting any of that would be inventing facts about work that has not
   * happened. What is certain is which button was pressed.
   *
   * ⚠️ SO THIS IS THE ONE WRITE IN PHASE 4 THAT PATCHES NO CACHE ENTRY, and the
   * absence is the design rather than an omission. There is nothing honest to
   * write into `qk.request(id)`: the new status depends on which branch of the
   * function ran, the agreed date may have been renegotiated inside it, and the
   * task id does not exist until it returns. `useMutation`'s own `isPending`
   * carries the whole prediction — the form is replaced by a sentence naming the
   * button — and `onSettled` brings back what actually happened.
   *
   * ⚠️ WHICH ALSO MEANS `onError` HAS NOTHING TO ROLL BACK, and that is why
   * there is no `beginWrite` here. A refused decision puts the FORM back
   * (`isPending` goes false) carrying the reason, which is exactly the old
   * behaviour — React used to do it by ending the transition. Nothing on screen
   * was ever moved to a value the database refused, so nothing has to be undone.
   *
   * ⚠️ THE FORM IS REPLACED WHOLE, not just the buttons. The alternative is a
   * live Approve sitting under a request that has already been approved, which
   * is an invitation to press it twice.
   * ------------------------------------------------------------------------
   */
  const submit = useMutation({
    mutationFn: (payload: Record<string, unknown>) => decide(requestId, payload),

    onError: (error) => {
      // The form comes back carrying the reason. `fieldErrors` are not read
      // here: every field on this panel is a picker or a date, and the one free
      // -text field has its own floor enforced by `richTextLength` before submit.
      setFormError(error.message);
    },

    onSuccess: (data) => {
      toast.success(
        data.status === "APPROVED"
          ? "Approved — the task is created, and the PIC and the client have been told."
          : data.status === "RETURNED"
            ? "Returned. The requester has been emailed the reason."
            : "Rejected. The requester has been emailed the reason.",
      );
    },

    /*
     * ⚠️ FIRED, NEVER AWAITED, AND THE PREFIX IS THE POINT. `["requests"]`
     * covers this request's own row and every part under it, the `/requests`
     * queue, AND `qk.pendingRequests(...)` — the Gate 1 queue the TASK views
     * draw above their stages, which is a different row set under the same
     * prefix precisely so a decision here moves it.
     *
     * `qk.tasks()` and `qk.snapshot()` because APPROVING CREATES A TASK:
     * `vizserve_pms_approve_request` inserts into `vizserve_pms_tasks` in the
     * request's department, which is a new row in a list and a new number in the
     * rail. `["lists"]` is NOT swept — a list created here is created by the
     * OTHER mutation below, which sweeps it itself.
     */
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["requests"] });
      void queryClient.invalidateQueries({ queryKey: ["request"] });
      void queryClient.invalidateQueries({ queryKey: qk.tasks() });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
    },
  });

  /**
   * What was pressed — while it is in flight AND after it lands.
   *
   * ⚠️ `isSuccess` IS NOT OPTIONAL HERE, and leaving it off puts a live Approve
   * button back under a request that has just been approved. `isPending` goes
   * false the instant the write returns, but this panel is unmounted by its
   * PARENT, which stops rendering it when `qk.request(id)` comes back no longer
   * `PENDING_REVIEW` — a refetch that `onSettled` has only just fired. The gap
   * between those two moments is precisely what the old `useOptimistic` was held
   * open across `router.refresh()` to cover.
   *
   * `submit.variables` survives a success, which is what makes this readable at
   * all — TanStack keeps the last arguments until the mutation is reset.
   */
  const taken =
    submit.isPending || submit.isSuccess
      ? (submit.variables?.decision as "approved" | "returned" | "rejected" | undefined)
      : undefined;

  /**
   * P7-23 — create a list without leaving the review.
   *
   * `saveList` is the SAME action /tasks/lists uses, called with a null id to
   * mean "new". Not a second creation path: a lighter one here would be a
   * second set of rules to keep in step with the first, and this one already
   * checks the department is in scope and maps the unique-name collision to a
   * sentence.
   *
   * ⚠️ THE NEW LIST IS HELD IN LOCAL STATE, NOT PATCHED INTO THE CACHE, and the
   * distinction matters. `extraLists` is about THIS FORM — it exists so the list
   * somebody just made is selected and selectable immediately, and creating a
   * list and then having to find it in the dropdown is the step that makes
   * people not bother. `onSettled` sweeps `["lists"]` so `/tasks/lists`, the
   * `/tasks` filter dropdown and the rail all learn about it; this component
   * does not wait for that, because it already knows the id.
   */
  const addListMutation = useMutation({
    mutationFn: (name: string) =>
      createList(null, {
        department_id: departmentId,
        name,
        description: "",
        is_active: true,
        sort_order: 0,
        // P7-25. Client Requests, so the list appears with the client work in
        // the sidebar rather than hanging loose under the department.
        group_id: clientFolderId,
      }),

    onError: (error) => toast.error(error.message),

    onSuccess: (data, name) => {
      // Selected straight away.
      setExtraLists((current) => [...current, { id: data.id, name }]);
      setListId(data.id);
      setNewListName("");
      setCreatingList(false);
      toast.success(`"${name}" created.`);
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["lists"] });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
      /* The panel's own list picker, so a reopened page sees it without this
         component's local `extraLists`. */
      void queryClient.invalidateQueries({ queryKey: qk.requestPart(requestId, "review") });
    },
  });

  const pending = submit.isPending || addListMutation.isPending;

  function run(payload: Record<string, unknown>) {
    setFormError(null);
    submit.mutate(payload);
  }

  function addList() {
    const name = newListName.trim();

    if (!name) {
      toast.error("Give the list a name.");
      return;
    }

    setFormError(null);
    addListMutation.mutate(name);
  }

  function approve() {
    // Mirrors the raise in `vizserve_pms_approve_request`. The database is the
    // authority; this is so the reviewer is told before the round trip rather
    // than after it.
    if (!listId) {
      setFormError("Choose the list this task will go under.");
      return;
    }

    run({
      decision: "approved",
      assignee_id: assigneeId || undefined,
      qa_assignee_id: qaAssigneeId === NO_QA ? null : qaAssigneeId,
      approved_target_date: approvedDate || null,
      list_id: listId,
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
            <Label htmlFor="approved_date">Delivery date you are committing to</Label>
            <DatePicker
              id="approved_date"
              className="w-56"
              value={approvedDate}
              onChange={(value) => setApprovedDate(value ?? "")}
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
              {/* P7-23 — "No list" is gone. It was the only way to approve a
                  request into a task belonging to nowhere: absent from
                  /tasks/lists, in no folder, findable only by scrolling the flat
                  list. `vizserve_pms_approve_request` now refuses a null list,
                  so offering the option would be offering a button that errors. */}
              <Select
                items={listItems}
                value={listId}
                onValueChange={(v) => v !== null && setListId(v)}
              >
                <SelectTrigger id="list" className="w-64">
                  <SelectValue placeholder="Choose a list" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((list) => (
                    <SelectItem key={list.id} value={list.id}>
                      {list.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {/* Creating one WITHOUT LEAVING THE APPROVAL. The alternative is
                  telling somebody mid-decision to open /tasks/lists in another
                  tab, make a list, come back and start the review again — at
                  which point they pick whatever list already exists instead,
                  which is how work ends up in the wrong place. */}
              {creatingList ? (
                <div className="flex items-center gap-1.5">
                  <Input
                    ref={focusWithoutScroll}
                    value={newListName}
                    disabled={pending}
                    placeholder="New list name"
                    aria-label="Name for the new list"
                    className="h-9"
                    onChange={(event) => setNewListName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addList();
                      }
                      if (event.key === "Escape") setCreatingList(false);
                    }}
                  />
                  <Button size="sm" onClick={addList} loading={pending}>
                    Create
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setCreatingList(false)}
                  >
                    Cancel
                  </Button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setCreatingList(true)}
                  className="self-start text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  <Plus className="mr-0.5 inline size-3" aria-hidden />
                  New list
                </button>
              )}

              <p className="text-xs text-muted-foreground">
                {options.length === 0
                  ? "This department has no lists yet — create one to approve."
                  : defaultListId
                    ? "Pre-filled from the form's default."
                    : "This form has no default list, so pick one."}
              </p>
            </div>
          ) : null}

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
              <Button type="submit" form="gate1-approve" loading={pending} disabled={!assigneeId}>
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
      </CardContent>
    </Card>
  );
}
