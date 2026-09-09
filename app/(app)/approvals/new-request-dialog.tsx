"use client";

import { toast } from "@/components/ui/toast";
import { ChevronsUpDown, Plus, X } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { CharacterCount } from "@/components/ui/character-count";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TimePicker } from "@/components/ui/time-picker";
import type { LeaveBalanceSummaryRow } from "@/lib/database.types";
import { todayInAppZone } from "@/lib/dates";
import {
  DAY_HALF_LABELS,
  DAY_HALVES,
  type DayHalf,
  INTERNAL_REASON_MAX,
  INTERNAL_REASON_MIN,
  INTERNAL_REQUEST_BLURBS,
  INTERNAL_REQUEST_LABELS,
  INTERNAL_REQUEST_TYPES,
  type InternalRequestType,
  isTimeCorrectionType,
  MAX_OVERTIME_MINUTES,
  MAX_RELIEVERS,
  TURNOVER_CONFIRMATION_TEXT,
} from "@/lib/schemas/internal-requests";
import { formatDays } from "@/lib/schemas/leave-balances";
import { toMinutes } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";
import { submitInternalRequest } from "./actions";

/**
 * Only what the picker needs. The server page selects the active ones, in order.
 *
 * P9-01 added `requires_reliever`, and it is what makes the hand-over block
 * appear at all — the dialog asks the CHOSEN TYPE rather than testing for the
 * code "VACATION", so HR turning it on for another type needs no change here.
 */
export type PickableLeaveType = { id: string; label: string; requires_reliever: boolean };

/** A colleague who could take the work. The server page scopes these to the department. */
/**
 * P11-11 — a colleague who can be named as a reliever.
 *
 * The department travels with the name because the picker GROUPS by it. Once
 * the list stopped being your own team it became a company directory, and a
 * flat alphabetical run of forty names gives no way to tell the two Marias
 * apart or to find the person you actually work with.
 *
 * Never null: `vizserve_pms_reliever_candidates` joins departments inner, so
 * somebody with no team is not offered at all.
 */
/**
 * P11-11 — the candidate list, split into one entry per department.
 *
 * A WALK, NOT A MAP. `vizserve_pms_reliever_candidates` orders by department
 * name then person, so consecutive rows sharing a department already ARE the
 * group — this only draws the boundaries. Keying an object by department id
 * instead would hand the order of the headings over to key iteration, which is
 * not the sort the server chose.
 */
function groupByDepartment(people: RelieverCandidate[]) {
  const groups: { id: string; name: string; people: RelieverCandidate[] }[] = [];

  for (const person of people) {
    const last = groups.at(-1);
    if (last && last.id === person.department_id) last.people.push(person);
    else groups.push({ id: person.department_id, name: person.department_name, people: [person] });
  }

  return groups;
}
export type RelieverCandidate = {
  id: string;
  full_name: string;
  department_id: string;
  department_name: string;
};

/** One of the requester's own open tasks. */
export type HandoverTask = { id: string; title: string };

/**
 * P9-01 — one row of the hand-over block: a person and the tasks they take.
 *
 * Held as local state and serialised into ONE hidden input as JSON on submit.
 * The rest of this dialog writes a hidden input per control, which works
 * because every other field is a scalar; a nested array of arrays has no honest
 * FormData shape, and inventing one (`relievers[0].task_ids[2]`) would be a
 * parser in two places.
 */
type RelieverRow = { relieverId: string; taskIds: string[] };

const EMPTY_RELIEVER: RelieverRow = { relieverId: "", taskIds: [] };

/** Matches listed at once. Enough to choose from, few enough to read. */
const MATCHES_SHOWN = 8;

/**
 * P9-01 — choosing the tasks one reliever takes on.
 *
 * ⚠️ A COMBOBOX, AND IT IS THE THIRD SHAPE THIS CONTROL HAS HAD. It shipped as
 * a checkbox list, which was defensible only while the set was imagined to be
 * small — the user it was tested against has 22 open tasks, and three relievers
 * each showing 22 checkboxes is not something anybody reads inside a dialog.
 * It then became a search with the five most recent listed underneath, which
 * put a permanent block of rows on screen to answer a question most people were
 * not asking.
 *
 * So: a closed trigger that says what is chosen, and a search that opens on
 * demand. Nothing is listed until somebody types, because "which of my tasks
 * does this person take" is a question you already know the answer to — you are
 * looking for a task you can name, not browsing.
 *
 * ITS OWN COMPONENT because the query and the open state are per-row and the
 * rows are drawn in a `.map()`, where a hook cannot go.
 */
/**
 * P11-11 — choosing a reliever, with a search box.
 *
 * ⚠️ A COMBOBOX, NOT A SELECT, AND THE REASON IS WHAT P11-11 CHANGED. While the
 * candidates were your own department this was a dropdown of four or five names
 * and scrolling was the whole interaction. It is now every active account in the
 * company, so the control has to answer "where is Maria" rather than "show me
 * everyone" — and a native-shaped Select answers only the second.
 *
 * Same shape as `RelieverTaskPicker` directly below: a Popover holding a
 * `Command`, with `shouldFilter={false}` and a plain substring test. cmdk's
 * fuzzy matcher ranks by edit distance, which on a list of names surfaces
 * "Marian Cruz" above "Maria" for the query "maria".
 *
 * THE DEPARTMENT STAYS VISIBLE, in a `CommandGroup` heading while browsing and
 * beside the name once a search has flattened the list. Two people called Maria
 * in different teams are otherwise the same row twice.
 */
function RelieverPicker({
  index,
  people,
  value,
  onChange,
}: {
  /** Which of the three rows this is. Only used to keep the labels apart. */
  index: number;
  /** Already filtered by the caller to exclude whoever the other rows took. */
  people: RelieverCandidate[];
  value: string;
  onChange: (relieverId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const term = query.trim().toLowerCase();
  const chosen = people.find((person) => person.id === value) ?? null;

  /* Name AND department, so "design" finds the whole team — which is how
     somebody looks when they know the department but not who is free. */
  const matches = term
    ? people.filter(
        (person) =>
          person.full_name.toLowerCase().includes(term) || person.department_name.toLowerCase().includes(term),
      )
    : people;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Cleared on close, so reopening starts from the full list rather than
        // from whatever was typed a minute ago and then abandoned.
        if (!next) setQuery("");
      }}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            id={`reliever_${index}`}
            /* Three of these can be on screen at once and all three would
               otherwise read "Choose a colleague…". */
            aria-label={`Choose reliever ${index + 1}`}
            className="w-full justify-between font-normal">
            {chosen ? (
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate">{chosen.full_name}</span>
                <span className="shrink-0 text-2xs text-muted-foreground">{chosen.department_name}</span>
              </span>
            ) : (
              <span className="text-muted-foreground">Choose a colleague…</span>
            )}
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden />
          </Button>
        }
      />
      <PopoverContent className="w-[min(32rem,100vw)] p-0 h-56" align="center">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search by name or team" value={query} onValueChange={setQuery} />
          {/* `max-h-36`, matching the height Amier set on the Select this
              replaced. Roughly six rows: enough to show a team without the
              popover covering the tasks underneath it. */}
          <CommandList className="max-h-full">
            {matches.length === 0 ? (
              <CommandEmpty>Nobody matches “{query.trim()}”.</CommandEmpty>
            ) : term ? (
              /* SEARCHING — one flat list, department beside each name.
                 Headings while filtering would leave single-row groups scattered
                 down the list, and the ranking people expect from a search is
                 "best match first", not "grouped by team". */
              matches.map((person) => (
                <CommandItem
                  key={person.id}
                  value={person.id}
                  onSelect={() => {
                    onChange(person.id);
                    setOpen(false);
                  }}>
                  <span aria-hidden className="w-3 shrink-0 text-center">
                    {person.id === value ? "✓" : ""}
                  </span>
                  <span className="truncate">{person.full_name}</span>
                  <span className="ml-auto shrink-0 text-2xs text-muted-foreground">{person.department_name}</span>
                </CommandItem>
              ))
            ) : (
              /* BROWSING — grouped, which is the P11-11 heading. */
              groupByDepartment(matches).map((group) => (
                <CommandGroup key={group.id} heading={group.name}>
                  {group.people.map((person) => (
                    <CommandItem
                      key={person.id}
                      value={person.id}
                      onSelect={() => {
                        onChange(person.id);
                        setOpen(false);
                      }}>
                      <span aria-hidden className="w-3 shrink-0 text-center">
                        {person.id === value ? "✓" : ""}
                      </span>
                      <span className="truncate">{person.full_name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function RelieverTaskPicker({
  tasks,
  selected,
  claimed,
  failed,
  onChange,
  index,
}: {
  tasks: HandoverTask[];
  selected: string[];
  /** Taken by ANOTHER reliever on this request. One task, one reliever. */
  claimed: Set<string>;
  failed: boolean;
  onChange: (taskIds: string[]) => void;
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const titleOf = new Map(tasks.map((task) => [task.id, task.title]));
  const term = query.trim().toLowerCase();

  const matches = term ? tasks.filter((task) => task.title.toLowerCase().includes(term)) : [];

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((it) => it !== id) : [...selected, id]);

  if (failed) {
    /* NOT "you have no tasks". A failed read that reads as an empty one is how
       this went wrong the first time — somebody files a hand-over with nothing
       in it, or gives up on the form. */
    return (
      <p className="text-xs text-destructive">
        Your tasks could not be loaded. Reload the page — do not file this without them.
      </p>
    );
  }

  if (tasks.length === 0) {
    return <p className="text-xs text-muted-foreground">You have no open tasks to hand over.</p>;
  }

  return (
    <div className="space-y-2">
      {/* WHAT IS ALREADY CHOSEN, outside the popover and always visible. The
          whole point of the block is that somebody can read their own hand-over
          back before they attest to it, and a combobox that hides its selection
          behind a trigger would defeat that at the one moment it matters. */}
      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((id) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => toggle(id)}
                className="inline-flex max-w-full items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-2xs hover:bg-muted">
                <span className="truncate">{titleOf.get(id) ?? "A task"}</span>
                <X className="size-3 shrink-0" aria-hidden />
                <span className="sr-only">Remove {titleOf.get(id) ?? "this task"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              /* Three of these can be on screen at once and every one of them
                 reads "Choose tasks…". Without this they are three identically
                 named controls to anybody not looking at the layout. */
              aria-label={`Choose tasks for reliever ${index + 1}`}
              /* The count, not the titles: the chips above already carry those,
                 and a trigger listing three task names is a trigger nobody can
                 read the label of. */
              className="w-full justify-between text-xs font-normal">
              {selected.length === 0
                ? "Choose tasks…"
                : `${selected.length} task${selected.length === 1 ? "" : "s"} chosen`}
              <ChevronsUpDown className="size-3.5 opacity-50" aria-hidden />
            </Button>
          }
        />
        <PopoverContent className="w-[min(32rem,100vw)] p-0" align="center">
          {/*
            `shouldFilter={false}` — cmdk's own fuzzy match is off, and the
            filtering is the plain substring test above. Same call
            `app/(app)/timesheet/week-grid.tsx` makes: a fuzzy matcher on task
            titles that all begin "Implementation of…" ranks by the wrong thing.
          */}
          <Command shouldFilter={false}>
            <CommandInput
              placeholder={`Search your ${tasks.length} open tasks`}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              {term === "" ? (
                <CommandEmpty>Type to find a task.</CommandEmpty>
              ) : matches.length === 0 ? (
                <CommandEmpty>Nothing matches “{query.trim()}”.</CommandEmpty>
              ) : (
                matches.slice(0, MATCHES_SHOWN).map((task) => {
                  const isClaimed = claimed.has(task.id);
                  const isSelected = selected.includes(task.id);
                  return (
                    <CommandItem
                      key={task.id}
                      value={task.id}
                      disabled={isClaimed}
                      onSelect={() => toggle(task.id)}
                      className="text-xs">
                      {/* Spelled out, never carried by the tint alone. */}
                      <span aria-hidden className="w-3 shrink-0 text-center">
                        {isSelected ? "✓" : ""}
                      </span>
                      <span className="truncate">
                        {task.title}
                        {isClaimed ? <span className="text-muted-foreground"> — with another reliever</span> : null}
                      </span>
                    </CommandItem>
                  );
                })
              )}
            </CommandList>
          </Command>

          {/* Said out loud, or eight rows reads as "eight is all there is". */}
          {term && matches.length > MATCHES_SHOWN ? (
            <p className="border-t px-3 py-2 text-2xs text-muted-foreground">
              {matches.length - MATCHES_SHOWN} more match — keep typing to narrow it.
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * P5-06 — the four internal request forms.
 *
 * One dialog with a type switcher rather than four routes: the four differ by
 * two or three fields, and four near-identical pages is four places to fix the
 * next change.
 *
 * Errors come back from the server action's `fieldErrors` rather than being
 * revalidated here. The zod schema and the Postgres CHECK constraints are the
 * two authorities; a third copy in the browser is the one that drifts.
 */

export function NewRequestDialog({
  leaveTypes = [],
  balances = [],
  relieverCandidates = [],
  handoverTasks = [],
  handoverTasksFailed = false,
  prefill,
  hasDepartment = true,
  isAdmin = false,
}: {
  leaveTypes?: PickableLeaveType[];
  /**
   * P9-01 — who may be named as a reliever.
   *
   * Already scoped by the server page to ACTIVE members of the filer's own
   * department, minus the filer. Scoped there rather than filtered here for the
   * usual reason: the submit function re-checks every one of them, so a wider
   * list would not be a security hole, it would just be a list of people whose
   * selection is refused after the form is filled in.
   */
  relieverCandidates?: RelieverCandidate[];
  /**
   * P9-01 — the filer's own unfinished tasks, the only ones they can hand over.
   *
   * "Their own" is `vizserve_pms_is_on_task`, not `assignee_id`: since P7-13 a
   * person can be on a task through the assignee table without being its PIC,
   * and that work is just as much theirs to hand over.
   */
  handoverTasks?: HandoverTask[];
  /**
   * P9-01 — did the read FAIL, as opposed to coming back empty?
   *
   * "You have no open tasks" and "we could not load your tasks" are opposite
   * claims, and only one of them is ever true by accident. This shipped without
   * the distinction and told a person with 22 open tasks they had none, because
   * a 16,542-character query string made `fetch` itself fail and the page
   * rendered `data ?? []`.
   */
  handoverTasksFailed?: boolean;
  /**
   * P7-33 — the filer's own allocated / used / remaining, per type.
   *
   * Shown beside the type they picked, and ADVISORY ONLY: a request that would
   * overdraw still submits, because entitlement is HR's call and this schema
   * models none of the reasons they might allow it. Disabling the submit button
   * on a negative figure would make the app the authority on a question it
   * cannot answer, and would strand anybody whose allocation simply has not
   * been set yet.
   *
   * Empty when the summary could not be read, which renders as nothing rather
   * than as zero — a hint that is missing is better than one that is wrong.
   */
  balances?: LeaveBalanceSummaryRow[];
  /**
   * F — where the DTR shortcut lands.
   *
   * Already narrowed by `narrowRequestPrefill` on the server, so a hand-edited
   * URL arrives here as `undefined` rather than as a bad type. PREFILL IS A
   * CONVENIENCE, NEVER AN AUTHORITY: nothing here is trusted server-side,
   * because `vizserve_pms_submit_internal_request` resolves the department from
   * the caller's own row and refuses a future correction whatever this says.
   *
   * `openOnMount` is what makes it a shortcut rather than a hint. Somebody who
   * clicked "Time-in missing?" on a DTR row has already decided; making them
   * press "New request" again on arrival would leave the whole trip pointless.
   */
  prefill?: { type?: InternalRequestType; date?: string; time?: string; openOnMount?: boolean };
  /**
   * Whether the filer has a `primary_department_id`.
   *
   * ⚠️ THE REQUEST CANNOT ROUTE WITHOUT ONE. `vizserve_pms_submit_internal_request`
   * resolves the approving department from the caller's own row and raises when
   * it is null — correctly, since a request with no department has no queue to
   * land in and no lead to notify. What was wrong was WHERE you found out:
   * after picking a type, a day, a time and writing a reason, as a red toast
   * that threw the form away.
   */
  hasDepartment?: boolean;
  /**
   * Only to choose the wording. The database rule is identical either way.
   *
   * An admin hitting "Ask an admin to set your department" is being told to ask
   * themselves — which is what this screen did, and it reads as a dead end
   * rather than as a two-click fix.
   */
  isAdmin?: boolean;
}) {
  const [open, setOpen] = useState(Boolean(prefill?.openOnMount));
  const [type, setType] = useState<InternalRequestType>(prefill?.type ?? "LEAVE");
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  /*
   * The three Selects below are CONTROLLED, each paired with its own hidden
   * input, because this dialog submits through a native `<form action={submit}>`
   * and reads FormData.
   *
   * Base UI's Select accepts a `name` and emits its own hidden input from it.
   * That is not used here on purpose: if it emits one and we emit one, the field
   * appears twice in the FormData and `.get()` silently returns whichever came
   * first. One explicit input is unambiguous, and it is the same shape the rest
   * of this form already uses.
   */
  const [leaveTypeId, setLeaveTypeId] = useState("");
  /*
   * The dates are state now rather than `defaultValue`, because `DatePicker` is
   * controlled — it has no uncontrolled mode by design, since a calendar has to
   * re-render its own selection. Each still writes a hidden input, so the native
   * `<form action={submit}>` reads exactly the same FormData keys it always did.
   */
  /*
   * P7-56. The reason is a rich-text editor now, which has no form value of its
   * own — so it joins the Selects and the DatePickers above in the
   * controlled-state-plus-hidden-input arrangement this form already uses.
   */
  const [reason, setReason] = useState("");
  const [startDate, setStartDate] = useState<string | null>(null);
  const [endDate, setEndDate] = useState<string | null>(null);
  const [correctionDate, setCorrectionDate] = useState<string | null>(null);
  /**
   * P7-40. Seeded from the DTR link's `?time=` — the SCHEDULED time — and then
   * fully the person's to change. It is an attestation about when they actually
   * started, so the prefill is a starting point, never a submitted default
   * nobody read.
   */
  const [correctionTime, setCorrectionTime] = useState<string | null>(prefill?.time ?? null);
  const [startHalf, setStartHalf] = useState<DayHalf>("MORNING");
  const [endHalf, setEndHalf] = useState<DayHalf>("AFTERNOON");
  // P9-01. One row to begin with — the block only appears when at least one is
  // required, so starting empty would show a hand-over section with nothing in
  // it and an "Add" button as the only way forward.
  const [relievers, setRelievers] = useState<RelieverRow[]>([EMPTY_RELIEVER]);
  const [turnoverConfirmed, setTurnoverConfirmed] = useState(false);

  const leaveTypeItems = Object.fromEntries(leaveTypes.map((option) => [option.id, option.label]));
  const balance = balances.find((row) => row.leave_type_id === leaveTypeId);
  /**
   * P9-01. THE CHOSEN TYPE decides whether the hand-over block exists, so
   * switching from Vacation to Sick mid-form makes it disappear and the
   * (ignored) rows go with it — the submit function drops a stale array for a
   * type that wants none rather than refusing it.
   */
  const needsReliever =
    type === "LEAVE" && Boolean(leaveTypes.find((option) => option.id === leaveTypeId)?.requires_reliever);
  const halfItems = Object.fromEntries(DAY_HALVES.map((half) => [half, DAY_HALF_LABELS[half]]));
  const [pending, startTransition] = useTransition();

  const today = todayInAppZone();

  /**
   * The day the correction is about.
   *
   * `prefill.date` is a date from the past — the row somebody was looking at —
   * and `today` is the fallback. It is applied only to the two correction types
   * and to overtime, all of which ask "which day": seeding a LEAVE request's
   * first day with a past date would be filing leave for a day already worked.
   */
  const workDate = prefill?.date ?? today;

  // Seeded from the same values the old `defaultValue`s used. `??` not `||`, so
  // a deliberate clear (null) is not silently refilled on the next render.
  const startValue = startDate ?? today;
  const endValue = endDate ?? today;
  const correctionValue = correctionDate ?? workDate;

  function submit(formData: FormData) {
    setErrors({});

    const reason = String(formData.get("reason") ?? "");

    // Built as the discriminated union the schema expects, so a reimbursement
    // literally cannot carry a start date from here.
    const payload =
      type === "LEAVE"
        ? {
            request_type: "LEAVE" as const,
            reason,
            start_date: String(formData.get("start_date") ?? ""),
            end_date: String(formData.get("end_date") ?? ""),
            leave_type_id: String(formData.get("leave_type_id") ?? ""),
            // P7-16. The defaults are a whole span, which is what every request
            // meant before these two controls existed.
            start_half: String(formData.get("start_half") ?? "MORNING"),
            end_half: String(formData.get("end_half") ?? "AFTERNOON"),
            /**
             * P9-01. Read from state rather than from FormData — this is the
             * one field on the form that is not a scalar.
             *
             * ⚠️ ONLY WHOLLY EMPTY ROWS ARE DROPPED — `||`, not `&&`, and the
             * difference is a silent data loss.
             *
             * A person who pressed "Add a reliever" and then thought better of
             * it leaves a blank row on screen, and refusing the submission over
             * it would be a rule about a control rather than about the
             * hand-over. But a row naming a COLLEAGUE WITH NO TASKS is not
             * empty, it is unfinished — and `&&` discarded it without a word,
             * so somebody could tick the confirmation, submit, and be told the
             * request was filed while the person they had just named held
             * nothing at all.
             *
             * Kept, so `relieverAssignmentSchema` can say "Give every reliever
             * at least one task" and point at the row. Same for a row with
             * tasks and nobody chosen.
             *
             * Not narrowed by `needsReliever`: the schema takes an empty array
             * happily and the function ignores a stale one, so sending what is
             * on screen keeps this branch free of a second copy of the rule.
             */
            relievers: relievers
              .filter((row) => row.relieverId || row.taskIds.length > 0)
              .map((row) => ({ reliever_id: row.relieverId, task_ids: row.taskIds })),
            turnover_confirmed: turnoverConfirmed,
          }
        : type === "REIMBURSEMENT"
          ? {
              request_type: "REIMBURSEMENT" as const,
              reason,
              // Number("") is 0, which would fail as "must be positive" rather
              // than "enter the amount". NaN gets the right message.
              amount: Number(String(formData.get("amount") ?? "").trim() || "NaN"),
            }
          : type === "OVERTIME"
            ? {
                request_type: "OVERTIME" as const,
                reason,
                work_date: String(formData.get("work_date") ?? ""),
                // Two fields, one number. `toMinutes` is the parser the
                // timesheet already uses — a second one here would be a second
                // set of rules about what "1h 30" means.
                overtime_minutes:
                  toMinutes(
                    String(formData.get("overtime_hours") ?? ""),
                    String(formData.get("overtime_mins") ?? ""),
                  ) ?? Number.NaN,
              }
            : {
                request_type: type,
                reason,
                work_date: String(formData.get("work_date") ?? ""),
                correction_time: String(formData.get("correction_time") ?? ""),
              };

    /*
     * P11-05 — the dialog closes on the click.
     *
     * ⚠️ SAFE HERE BECAUSE THE FORM DOES NOT UNMOUNT ON CLOSE, unlike
     * `new-task-dialog`. Every field is still mounted and still filled in, so a
     * refusal reopens onto exactly what was typed — which matters more on this
     * form than on most: a leave request with three relievers and a task
     * assigned to each is a minute of work to re-enter.
     *
     * The request itself is NOT predicted. It lands in a queue rendered by a
     * server component elsewhere on the page, and the stage it opens at depends
     * on the leave type (P9-03) — a placeholder row would have to guess that and
     * would guess wrong for vacation.
     */
    setOpen(false);

    startTransition(async () => {
      const result = await submitInternalRequest(payload);

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        setOpen(true);
        toast.error(result.error);
        return;
      }

      // P9-01. Who was actually told depends on where the request opens, and
      // saying "your department lead has been notified" about a request sitting
      // with three relievers is simply untrue.
      toast.success(
        needsReliever
          ? "Request submitted. Your relievers have been asked to confirm."
          : "Request submitted. Your department lead has been notified.",
      );
      setErrors({});
      setRelievers([EMPTY_RELIEVER]);
      setTurnoverConfirmed(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setErrors({});
      }}>
      <DialogTrigger render={<Button />}>
        <Plus className="size-4" />
        New request
      </DialogTrigger>

      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New request</DialogTitle>
          <DialogDescription>{INTERNAL_REQUEST_BLURBS[type]}</DialogDescription>
        </DialogHeader>

        <form action={submit} className="space-y-4">
          {/*
           * BEFORE the fields, not beside the submit button, because it decides
           * whether filling them in is worth anything. This screen used to let
           * you pick a type, a day, a time and write a reason, and only then
           * throw a red toast that discarded the lot.
           */}
          {!hasDepartment ? (
            <p
              id="no-department"
              role="alert"
              className="rounded-md border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive">
              You have no department set, so a request from you has nobody to route to.{" "}
              {isAdmin ? (
                <Link href="/admin/users" className="font-medium underline underline-offset-2">
                  Set your department in Users
                </Link>
              ) : (
                "Ask an admin to set your department."
              )}
            </p>
          ) : null}

          <div className="space-y-2">
            <Label>Type</Label>
            {/* REAL RADIOS, not `aria-pressed` buttons. This is one choice from
                a fixed set of five, which is exactly what a radio group is — and
                the semantics are worth having: arrow keys move between options,
                and it announces as "one of five" rather than as five separate
                toggles that happen to be mutually exclusive.

                Still laid out as cards rather than a list, because the choice
                changes the rest of the form and is worth seeing all at once.

                Three columns, not two. P7-04 made this five types, and an odd
                number in a two-column grid leaves the last option stranded on a
                row of its own looking like a different kind of control. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup">
              {INTERNAL_REQUEST_TYPES.map((option) => (
                <label
                  key={option}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-sm border px-3 py-2 text-sm",
                    "hover:bg-accent/50",
                    // The selected look comes from the input's own `:checked`, so
                    // it cannot drift from the value that gets submitted.
                    "has-[:checked]:border-primary has-[:checked]:bg-accent has-[:checked]:font-medium has-[:checked]:text-accent-foreground",
                    "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                  )}>
                  <input
                    type="radio"
                    name="request_type"
                    value={option}
                    checked={type === option}
                    onChange={() => {
                      setType(option);
                      setErrors({});
                      // A time typed for one end of the day is wrong for the
                      // other, so switching between the correction types starts
                      // clean rather than carrying it across.
                      setCorrectionTime(null);
                    }}
                    className="size-3.5 shrink-0 accent-primary"
                  />
                  {INTERNAL_REQUEST_LABELS[option]}
                </label>
              ))}
            </div>
          </div>

          {type === "LEAVE" ? (
            <>
              {/* P7-12. REQUIRED — the shape constraint refuses a LEAVE row
                  without one, so this is not an optional refinement: the whole
                  type stops submitting without it.

                  RADIO BUTTONS, NOT A SELECT. There are eight types and a person
                  filing leave picks the same two or three most of the time; a
                  closed select hides all eight behind a click and gives no sense
                  of what is on offer. Real `<input type="radio">`s rather than
                  the `aria-pressed` buttons the type switcher above uses,
                  because this IS a single choice from a fixed set — which is
                  exactly what a radio group is, and it gets arrow-key navigation
                  and the "one of eight" announcement for free.

                  A plain list rather than grouped: the list is admin-editable
                  data, so any grouping here would be a second opinion about it
                  that goes stale the first time HR adds a type. */}
              {/* A DROPDOWN, and it went back to being one. It was briefly a
                  radio grid — a misreading of which control the radios were
                  meant for. They belong on Type above: five options that change
                  the whole form. This is eight rows of admin-editable data that
                  change nothing else, and eight cards pushed the dates and the
                  reason below the fold.

                  A native select rather than the styled one, and a plain list
                  rather than grouped: the list lives in
                  `vizserve_pms_leave_types`, so any grouping here would be a
                  second opinion about it that goes stale the first time HR adds
                  a type. */}
              <div className="space-y-2">
                <Label htmlFor="leave_type_id">Leave type</Label>
                <input type="hidden" name="leave_type_id" value={leaveTypeId} />
                <Select
                  items={leaveTypeItems}
                  value={leaveTypeId || null}
                  onValueChange={(value) => value !== null && setLeaveTypeId(value)}>
                  <SelectTrigger id="leave_type_id" className="w-full">
                    <SelectValue placeholder="Choose one…" />
                  </SelectTrigger>
                  <SelectContent>
                    {leaveTypes.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldError messages={errors.leave_type_id} />

                {/* P7-33. Only once a type is chosen — a summary of all eight
                    above an empty form is a table nobody asked for, and the
                    question "how many do I have left" is only meaningful about
                    the one being filed.

                    The figures are for the CURRENT year and count APPROVED
                    leave only, so a pending request is not deducted twice over
                    once it is decided. Both facts are said out loud rather than
                    left to be inferred from a number that looks too high.

                    State is never conveyed by colour alone (a project rule), so
                    an overdraw reads "over your allocation by" and does not
                    rely on the destructive tint to carry it. */}
                {balance ? (
                  <p className="text-xs text-muted-foreground">
                    {balance.days_remaining < 0 ? (
                      <span className="font-medium text-destructive">
                        {formatDays(-balance.days_remaining)} over your allocation
                      </span>
                    ) : (
                      <span className="font-medium text-foreground">{formatDays(balance.days_remaining)} left</span>
                    )}{" "}
                    — {formatDays(balance.days_allocated)} allocated, {formatDays(balance.days_used)} approved so far
                    this year. Filing more than you have left is allowed; your lead decides.
                  </p>
                ) : null}
              </div>

              {/*
                P7-16 — A HALF AND A DATE, twice.
                
                The half sits BEFORE its date on each row, which is the order the
                sentence runs in: "from the afternoon of the 3rd, to the morning
                of the 5th". Putting the dates together and the halves together
                would group by control type rather than by meaning, and the
                second half would end up describing a date three fields away.

                What they mean is not symmetrical, which is the part people get
                wrong: on the FIRST day, Morning is the whole day and Afternoon is
                half of it; on the LAST day it is the other way round. The hint
                under each says so rather than leaving it to be worked out.
              */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="start_half">Leave start</Label>
                  <input type="hidden" name="start_half" value={startHalf} />
                  <Select
                    items={halfItems}
                    value={startHalf}
                    onValueChange={(value) => value !== null && setStartHalf(value as DayHalf)}>
                    <SelectTrigger id="start_half" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAY_HALVES.map((half) => (
                        <SelectItem key={half} value={half}>
                          {DAY_HALF_LABELS[half]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-2xs text-muted-foreground">Afternoon means you work the morning of that day.</p>
                  <FieldError messages={errors.start_half} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="start_date">Start date</Label>
                  <DatePicker
                    id="start_date"
                    name="start_date"
                    value={startValue}
                    onChange={setStartDate}
                    clearable={false}
                    invalid={Boolean(errors.start_date?.length)}
                  />
                  <FieldError messages={errors.start_date} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="end_half">Leave end</Label>
                  <input type="hidden" name="end_half" value={endHalf} />
                  <Select
                    items={halfItems}
                    value={endHalf}
                    onValueChange={(value) => value !== null && setEndHalf(value as DayHalf)}>
                    <SelectTrigger id="end_half" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAY_HALVES.map((half) => (
                        <SelectItem key={half} value={half}>
                          {DAY_HALF_LABELS[half]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-2xs text-muted-foreground">Morning means you are back for the afternoon.</p>
                  <FieldError messages={errors.end_half} />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="end_date">End date</Label>
                  <DatePicker
                    id="end_date"
                    name="end_date"
                    value={endValue}
                    onChange={setEndDate}
                    min={startValue}
                    clearable={false}
                    invalid={Boolean(errors.end_date?.length)}
                  />
                  <FieldError messages={errors.end_date} />
                </div>
              </div>

              {/*
                P9-01 — THE HAND-OVER.

                Shown only for the leave types HR marked as needing one, which
                today is Vacation alone. It keys off the CHOSEN TYPE rather than
                a hardcoded code, so the day HR ticks Maternity this block
                appears there with no change here.

                It sits AFTER the dates on purpose: you cannot sensibly decide
                who covers what until you have said how long you are gone. The
                confirmation then sits after the rows, because it is a claim
                about what is above it.
              */}
              {needsReliever ? (
                <div className="space-y-3 rounded-lg border p-4">
                  <div>
                    <h3 className="text-sm font-medium">Hand-over</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Name up to {MAX_RELIEVERS} colleagues — from any team — and give each of them the tasks they will
                      hold while you are away. They confirm before your team leader sees this.
                    </p>
                  </div>

                  {relieverCandidates.length === 0 ? (
                    /* Not an error state — it is a fact about the company and
                       the person filing has no way to fix it. Saying so beats an
                       empty dropdown they will click three times.

                       Reworded with P11-11: the list is no longer your own
                       team, so "nobody in your department" would be a wrong
                       explanation for an empty picker. */
                    <p className="text-xs text-muted-foreground">
                      There is nobody else to hand work to yet. Ask an admin before filing this.
                    </p>
                  ) : null}

                  {relievers.map((row, index) => {
                    /* Taken by SOMEBODY ELSE. A person cannot appear twice and a
                       task cannot go to two relievers, so both lists exclude
                       what other rows have claimed — the rule is enforced in zod
                       and again in Postgres, and a control that cannot express
                       the mistake beats three places explaining it afterwards.
                       This row's own choices stay selectable, or picking one
                       would remove it. */
                    const takenPeople = new Set(
                      relievers.filter((_, at) => at !== index).map((other) => other.relieverId),
                    );
                    const takenTasks = new Set(
                      relievers.filter((_, at) => at !== index).flatMap((other) => other.taskIds),
                    );
                    const people = relieverCandidates.filter(
                      (person) => !takenPeople.has(person.id) || person.id === row.relieverId,
                    );

                    const update = (next: Partial<RelieverRow>) =>
                      setRelievers(relievers.map((current, at) => (at === index ? { ...current, ...next } : current)));

                    return (
                      /* THE INDEX IS THE IDENTITY HERE, as it is in the form
                         builder's OptionsAttribute. These rows have no id until
                         they are submitted, and a key derived from the chosen
                         person would remount the row on every change of it. */
                      <div key={index} className="space-y-2 rounded-md border bg-muted/30 p-3">
                        <div className="flex items-end gap-2">
                          <div className="flex-1 space-y-1.5">
                            <Label htmlFor={`reliever_${index}`}>Reliever {index + 1}</Label>
                            <RelieverPicker
                              index={index}
                              people={people}
                              value={row.relieverId}
                              onChange={(relieverId) => update({ relieverId })}
                            />
                          </div>
                          {relievers.length > 1 ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setRelievers(relievers.filter((_, at) => at !== index))}>
                              <X className="size-4" aria-hidden />
                              <span className="sr-only">Remove reliever {index + 1}</span>
                            </Button>
                          ) : null}
                        </div>

                        <fieldset className="space-y-1.5">
                          {/* A CHECKBOX LIST, not a multi-select popover. These
                              tasks are the thing the filer has to read carefully
                              and the thing their reliever is agreeing to —
                              collapsing them behind a trigger reading "3
                              selected" is the one place in this form where a
                              summary is worse than the list. */}
                          <legend className="text-xs text-muted-foreground">Tasks for this reliever</legend>
                          <RelieverTaskPicker
                            index={index}
                            tasks={handoverTasks}
                            selected={row.taskIds}
                            claimed={takenTasks}
                            failed={handoverTasksFailed}
                            onChange={(taskIds) => update({ taskIds })}
                          />
                        </fieldset>
                      </div>
                    );
                  })}

                  <FieldError messages={errors.relievers} />

                  {relievers.length < MAX_RELIEVERS ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setRelievers([...relievers, EMPTY_RELIEVER])}>
                      <Plus className="size-4" aria-hidden />
                      Add a reliever
                    </Button>
                  ) : null}

                  {/* P9-01 — THE ATTESTATION.

                      Required, and a real claim rather than a caption: the
                      hand-over block is the filer asserting that the critical
                      work is listed and covered, and the three people
                      downstream are approving that assertion. The wording is a
                      shared constant so this label and the record of what was
                      agreed to cannot drift apart. */}
                  <label className="flex items-start gap-2 border-t pt-3 text-xs">
                    <Checkbox
                      checked={turnoverConfirmed}
                      onCheckedChange={(next) => setTurnoverConfirmed(Boolean(next))}
                    />
                    <span>
                      <span className="font-medium">Turn-over Confirmation (Required)</span>
                      <br />
                      {TURNOVER_CONFIRMATION_TEXT}
                    </span>
                  </label>
                  <FieldError messages={errors.turnover_confirmed} />
                </div>
              ) : null}
            </>
          ) : null}

          {type === "OVERTIME" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="work_date">Which day</Label>
                {/* Today is allowed and capped there. Asking at 17:00 for the
                    evening you are about to work is the ordinary case; the
                    submit function says so too. */}
                <DatePicker
                  id="work_date"
                  name="work_date"
                  value={correctionValue}
                  onChange={setCorrectionDate}
                  max={today}
                  clearable={false}
                  invalid={Boolean(errors.work_date?.length)}
                />
                <FieldError messages={errors.work_date} />
              </div>

              <div className="space-y-2">
                <Label htmlFor="overtime_hours">How long</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="overtime_hours"
                    name="overtime_hours"
                    type="number"
                    min="0"
                    max={Math.floor(MAX_OVERTIME_MINUTES / 60)}
                    inputMode="numeric"
                    placeholder="0"
                    aria-label="Overtime hours"
                    className="w-20 text-center tabular-nums"
                  />
                  <span className="text-sm text-muted-foreground">h</span>
                  <Input
                    id="overtime_mins"
                    name="overtime_mins"
                    type="number"
                    min="0"
                    max="59"
                    inputMode="numeric"
                    placeholder="0"
                    aria-label="Overtime minutes"
                    className="w-20 text-center tabular-nums"
                  />
                  <span className="text-sm text-muted-foreground">m</span>
                </div>
                <FieldError messages={errors.overtime_minutes} />
              </div>
            </div>
          ) : null}

          {isTimeCorrectionType(type) ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="work_date">Which day</Label>
                {/* Capped at today. A correction for a day that has not happened
                    is refused by the submit function anyway; stopping it in the
                    picker saves the round trip. */}
                <DatePicker
                  id="work_date"
                  name="work_date"
                  value={correctionValue}
                  onChange={setCorrectionDate}
                  max={today}
                  clearable={false}
                  invalid={Boolean(errors.work_date?.length)}
                />
                <FieldError messages={errors.work_date} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="correction_time">
                  {type === "NO_TIME_IN" || type === "TIME_IN_CORRECTION" ? "Time you started" : "Time you finished"}
                </Label>
                {/*
                 * P7-40 — DEFAULT VALUE, NOT A CONTROLLED ONE, and the
                 * distinction is the whole ethics of this field.
                 *
                 * The DTR link arrives carrying the SCHEDULED time, so the
                 * field opens saying what the record should have said. But this
                 * is an attestation about when somebody actually started work,
                 * and a value they cannot edit — or one that snaps back — would
                 * turn a statement into a rubber stamp, leaving the approver
                 * signing off a number the system invented. `defaultValue`
                 * seeds it and then gets out of the way.
                 *
                 * `key` so that switching type re-mounts the input rather than
                 * carrying a time typed for the other end of the day.
                 */}
                <TimePicker
                  id="correction_time"
                  name="correction_time"
                  label={
                    type === "NO_TIME_IN" || type === "TIME_IN_CORRECTION" ? "Time you started" : "Time you finished"
                  }
                  value={correctionTime}
                  onChange={setCorrectionTime}
                  invalid={Boolean(errors.correction_time?.length)}
                />
                <FieldError messages={errors.correction_time} />
              </div>
            </div>
          ) : null}

          {type === "REIMBURSEMENT" ? (
            <div className="space-y-2">
              <Label htmlFor="amount">Amount (PHP)</Label>
              <Input id="amount" name="amount" type="number" step="0.01" min="0" inputMode="decimal" />
              <FieldError messages={errors.amount} />
            </div>
          ) : null}

          <div className="space-y-2">
            {/* No `htmlFor` — the editor's input is a contenteditable, which is
                not a labelable element. It carries the same words as its
                `aria-label`. */}
            <Label>Reason</Label>
            <input type="hidden" name="reason" value={reason} />
            <RichTextEditor
              value={reason}
              onChange={setReason}
              ariaLabel="Reason"
              invalid={Boolean(errors.reason?.length)}
              minHeight="min-h-20"
              placeholder={
                type === "LEAVE"
                  ? "Family matters, medical appointment…"
                  : type === "OVERTIME"
                    ? "What needed the extra hours."
                    : "What happened, briefly."
              }
            />
            <CharacterCount value={reason} min={INTERNAL_REASON_MIN} max={INTERNAL_REASON_MAX} rich />
            <FieldError messages={errors.reason} />
          </div>

          {errors.form?.length ? <FieldError messages={errors.form} /> : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {/*
             * `aria-describedby` points at the notice above, so the disabled
             * state is never the sole explanation — the reason is announced with
             * the button rather than left sitting further up the form.
             */}
            <Button
              type="submit"
              loading={pending}
              disabled={!hasDepartment}
              aria-describedby={!hasDepartment ? "no-department" : undefined}>
              Submit request
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
