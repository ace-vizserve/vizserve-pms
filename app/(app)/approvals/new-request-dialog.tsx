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
  type InternalRequestType,
} from "@/lib/schemas/internal-requests";
import { submitInternalRequest } from "./actions";

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

export function NewRequestDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<InternalRequestType>("LEAVE");
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [pending, startTransition] = useTransition();

  const today = todayInAppZone();

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
          }
        : type === "REIMBURSEMENT"
          ? {
              request_type: "REIMBURSEMENT" as const,
              reason,
              // Number("") is 0, which would fail as "must be positive" rather
              // than "enter the amount". NaN gets the right message.
              amount: Number(String(formData.get("amount") ?? "").trim() || "NaN"),
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
            {/* Buttons rather than a select: there are exactly four, they are
                not going to grow, and the choice changes the rest of the form —
                which is worth seeing all at once. */}
            <div className="grid grid-cols-2 gap-2">
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
                  defaultValue={today}
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
