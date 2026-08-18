"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { todayInAppZone } from "@/lib/dates";
import {
  INTERNAL_REQUEST_BLURBS,
  INTERNAL_REQUEST_LABELS,
  INTERNAL_REQUEST_TYPES,
  MAX_OVERTIME_MINUTES,
  type InternalRequestType,
} from "@/lib/schemas/internal-requests";
import { toMinutes } from "@/lib/schemas/timesheet";
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
  prefill,
}: {
  leaveTypes?: PickableLeaveType[];
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
  prefill?: { type?: InternalRequestType; date?: string; openOnMount?: boolean };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(Boolean(prefill?.openOnMount));
  const [type, setType] = useState<InternalRequestType>(prefill?.type ?? "LEAVE");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
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
      }}
    >
      <DialogTrigger render={<Button />}>
          <Plus className="size-4" />
          New request
        </DialogTrigger>

      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New request</DialogTitle>
          <DialogDescription>{INTERNAL_REQUEST_BLURBS[type]}</DialogDescription>
        </DialogHeader>

        <form action={submit} className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            {/* Buttons rather than a select: the choice changes the rest of the
                form, which is worth seeing all at once.

                Three columns, not two. P7-04 made this five types, and an odd
                number in a two-column grid leaves the last button stranded on a
                row of its own looking like a different kind of control. */}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {INTERNAL_REQUEST_TYPES.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => {
                    setType(option);
                    setErrors({});
                  }}
                  aria-pressed={type === option}
                  className={
                    type === option
                      ? "rounded-sm border border-primary bg-accent px-3 py-2 text-left text-sm font-medium text-accent-foreground"
                      : "rounded-sm border px-3 py-2 text-left text-sm hover:bg-accent/50"
                  }
                >
                  {INTERNAL_REQUEST_LABELS[option]}
                </button>
              ))}
            </div>
          </div>

          {type === "LEAVE" ? (
            <>
              {/* P7-12. REQUIRED — the shape constraint refuses a LEAVE row
                  without one, so this is not an optional refinement: the whole
                  type stops submitting without it.

                  A native select rather than the styled one, and a plain list
                  rather than grouped: the list is admin-editable data, so any
                  grouping here would be a second opinion about it that goes
                  stale the first time HR adds a type. */}
              <div className="space-y-2">
                <Label htmlFor="leave_type_id">Leave type</Label>
                <select
                  id="leave_type_id"
                  name="leave_type_id"
                  defaultValue=""
                  className="h-9 w-full rounded-sm border bg-transparent px-3 text-sm shadow-raised focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <option value="" disabled>
                    Choose one…
                  </option>
                  {leaveTypes.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <FieldError messages={errors.leave_type_id} />
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="start_date">First day</Label>
                  <Input id="start_date" name="start_date" type="date" defaultValue={today} />
                  <FieldError messages={errors.start_date} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end_date">Last day</Label>
                  <Input id="end_date" name="end_date" type="date" defaultValue={today} />
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
                <Input
                  id="work_date"
                  name="work_date"
                  type="date"
                  max={today}
                  defaultValue={workDate}
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

          {type === "NO_TIME_IN" || type === "NO_TIME_OUT" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="work_date">Which day</Label>
                {/* Capped at today. A correction for a day that has not happened
                    is refused by the submit function anyway; stopping it in the
                    picker saves the round trip. */}
                <Input
                  id="work_date"
                  name="work_date"
                  type="date"
                  max={today}
                  defaultValue={workDate}
                />
                <FieldError messages={errors.work_date} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="correction_time">
                  {type === "NO_TIME_IN" ? "Time you started" : "Time you finished"}
                </Label>
                <Input id="correction_time" name="correction_time" type="time" />
                <FieldError messages={errors.correction_time} />
              </div>
            </div>
          ) : null}

          {type === "REIMBURSEMENT" ? (
            <div className="space-y-2">
              <Label htmlFor="amount">Amount (PHP)</Label>
              <Input
                id="amount"
                name="amount"
                type="number"
                step="0.01"
                min="0"
                inputMode="decimal"
              />
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
            <Button type="submit" loading={pending}>
              Submit request
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
