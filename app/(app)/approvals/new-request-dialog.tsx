"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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
import { DatePicker } from "@/components/ui/date-picker";
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
import { TimePicker } from "@/components/ui/time-picker";
import type { LeaveBalanceSummaryRow } from "@/lib/database.types";
import { todayInAppZone } from "@/lib/dates";
import { formatDays } from "@/lib/schemas/leave-balances";
import {
  DAY_HALF_LABELS,
  DAY_HALVES,
  type DayHalf,
  INTERNAL_REQUEST_BLURBS,
  INTERNAL_REQUEST_LABELS,
  INTERNAL_REQUEST_TYPES,
  MAX_OVERTIME_MINUTES,
  type InternalRequestType,
  isTimeCorrectionType,
} from "@/lib/schemas/internal-requests";
import { toMinutes } from "@/lib/schemas/timesheet";
import { cn } from "@/lib/utils";
import { submitInternalRequest } from "./actions";

/** Only what the picker needs. The server page selects the active ones, in order. */
export type PickableLeaveType = { id: string; label: string };

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
function FieldError({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return (
    <p role="alert" className="text-xs text-destructive">
      {messages[0]}
    </p>
  );
}

export function NewRequestDialog({
  leaveTypes = [],
  balances = [],
  prefill,
  hasDepartment = true,
  isAdmin = false,
}: {
  leaveTypes?: PickableLeaveType[];
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
  const router = useRouter();
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

  const leaveTypeItems = Object.fromEntries(
    leaveTypes.map((option) => [option.id, option.label]),
  );
  const balance = balances.find((row) => row.leave_type_id === leaveTypeId);
  const halfItems = Object.fromEntries(
    DAY_HALVES.map((half) => [half, DAY_HALF_LABELS[half]]),
  );
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

    startTransition(async () => {
      const result = await submitInternalRequest(payload);

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      toast.success("Request submitted. Your department lead has been notified.");
      setOpen(false);
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
              className="rounded-md border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive"
            >
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
                  )}
                >
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
                  onValueChange={(value) => value !== null && setLeaveTypeId(value)}
                >
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
                      <span className="font-medium text-foreground">
                        {formatDays(balance.days_remaining)} left
                      </span>
                    )}{" "}
                    — {formatDays(balance.days_allocated)} allocated, {formatDays(balance.days_used)}{" "}
                    approved so far this year. Filing more than you have left is allowed; your lead
                    decides.
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
                    onValueChange={(value) => value !== null && setStartHalf(value as DayHalf)}
                  >
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
                    onValueChange={(value) => value !== null && setEndHalf(value as DayHalf)}
                  >
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
                  {type === "NO_TIME_IN" || type === "TIME_IN_CORRECTION"
                    ? "Time you started"
                    : "Time you finished"}
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
                    type === "NO_TIME_IN" || type === "TIME_IN_CORRECTION"
                      ? "Time you started"
                      : "Time you finished"
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
            <Label htmlFor="reason">Reason</Label>
            <Textarea
              id="reason"
              name="reason"
              rows={3}
              placeholder={
                type === "LEAVE"
                  ? "Family matters, medical appointment…"
                  : type === "OVERTIME"
                    ? "What needed the extra hours."
                    : "What happened, briefly."
              }
            />
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
              aria-describedby={!hasDepartment ? "no-department" : undefined}
            >
              Submit request
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
