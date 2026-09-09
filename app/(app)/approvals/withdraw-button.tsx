"use client";

import { Undo2 } from "lucide-react";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { CharacterCount } from "@/components/ui/character-count";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { toast } from "@/components/ui/toast";
import { richTextLength } from "@/lib/rich-text";
import { INTERNAL_REASON_MAX } from "@/lib/schemas/internal-requests";

import { qk } from "@/lib/query/keys";
import { fromAction } from "@/lib/query/mutate";
import { withdrawInternalRequest } from "./actions";

/** The Server Action, as a promise TanStack can drive `onError` off. */
const sendWithdrawal = fromAction(withdrawInternalRequest);

/**
 * P9-03 — the author takes their own request back.
 *
 * ⚠️ CONFIRMED, unlike every other button on this page. Withdrawing is the only
 * action here a person takes on their OWN work with no second signature, and it
 * cannot be undone — the request goes to WITHDRAWN and the way back is to file
 * a new one. Approve and reject are both somebody else's decision about
 * somebody else's request, and both already require a reason for the negative
 * path; this one asks for nothing, so the dialog is the whole safeguard.
 *
 * The rule that decides whether it is legal lives in
 * `vizserve_pms_withdraw_internal_request` and is mirrored on the server page
 * to decide whether this renders at all. Nothing is re-checked here — a check
 * in a client component is a suggestion.
 *
 * P11-13 — AND A NOTE, OPTIONAL OR REQUIRED DEPENDING ON `needsNote`.
 *
 * The people this reaches are the ones who were waiting, or who have already
 * signed: the team leader holding it in their queue, the manager who approved
 * it last week, the relievers who agreed to cover the work. They used to be
 * told only that it was gone.
 *
 * ⚠️ THE TWO ROUTES ARE ONE CONTROL, and the difference is the words. While
 * nobody has answered, P9-03's asymmetry holds — withdrawing owes nobody an
 * explanation, the note is offered and the copy says so. Once somebody has put
 * their name to it, the note is required, because they arranged something on
 * the strength of this. The page decides which; the database enforces both, and
 * this only stops somebody being refused after typing nothing.
 */
export function WithdrawButton({
  requestId,
  needsNote = false,
}: {
  requestId: string;
  /** True once anybody has signed — see `canWithdraw` on the request page. */
  needsNote?: boolean;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  /*
   * ------------------------------------------------------------------------
   * P11-05 / P12-19 — THE BUTTON ANSWERS ON THE CLICK.
   *
   * ⚠️ IT REPLACES ITSELF RATHER THAN PREDICTING THE PAGE. The status pill, the
   * stage rail and the whole "waiting on" paragraph are rendered by the tree
   * around this one, and there is no honest way to reach up and repaint them
   * from here — withdrawing an APPROVED leave request undoes consequences
   * scattered across the timesheet and the leave calendar, none of which this
   * control can see. What is certain is that the request is being withdrawn and
   * this control is finished, so it says so, and the page catches up with the
   * invalidation.
   *
   * The dialog closes with it. Leaving a modal up over a decision already taken
   * reads as the button not having worked.
   *
   * ⚠️ `isSuccess` IS IN `withdrawing` FOR THE REASON THE DECISION PANEL GIVES:
   * `isPending` goes false the instant the write returns, and the parent only
   * stops rendering this once `qk.approval(id)` comes back WITHDRAWN — a refetch
   * `onSettled` has only just fired. Without it the Withdraw button flashes back
   * into existence under the cursor.
   * ------------------------------------------------------------------------
   */
  const submit = useMutation({
    mutationFn: () => sendWithdrawal(requestId, { note }),

    onMutate: () => {
      setOpen(false);
    },

    onError: (mutationError) => {
      /* The button comes back. The dialog is NOT reopened: the commonest
         failure is somebody having answered seconds ago, and the toast says so
         — reopening a confirm for an action that is no longer legal would be
         offering it again. */
      toast.error(mutationError.message);
    },

    onSuccess: () => toast.success("Request withdrawn."),

    /* The same five roots the decision panel sweeps, and for the same reasons —
       a withdrawal notifies whoever it was waiting on, so the inbox and the
       badge move too. `vizserve_pms_withdraw_internal_request` sends those
       inside the function. */
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["approval"] });
      void queryClient.invalidateQueries({ queryKey: ["approvals"] });
      void queryClient.invalidateQueries({ queryKey: qk.snapshot() });
      void queryClient.invalidateQueries({ queryKey: qk.unread() });
      void queryClient.invalidateQueries({ queryKey: ["inbox"] });
    },
  });

  const pending = submit.isPending;
  const withdrawing = submit.isPending || submit.isSuccess;

  function withdraw() {
    /*
     * The one check made before the write, and it is a COURTESY rather than the
     * rule. `vizserve_pms_withdraw_internal_request` refuses an empty note on
     * this route anyway; catching it here keeps the dialog open with the cursor
     * in the box instead of closing it, failing, and leaving a toast to explain
     * what went wrong to somebody who can no longer see the field.
     *
     * `richTextLength`, not `.trim()`: an empty editor is `<p></p>`, which is
     * seven characters of nothing.
     */
    if (needsNote && richTextLength(note) === 0) {
      setError("Say why — the people who already approved this will be told.");
      return;
    }

    setError(null);
    submit.mutate();
  }

  return (
    <>
      {withdrawing ? (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          Withdrawing…
        </p>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
          <Undo2 className="size-3.5" aria-hidden />
          Withdraw
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        {/* Wider than the `sm:max-w-sm` default: this stopped being a two-line
            confirm the moment it grew an editor, and a rich-text box in a
            narrow column wraps every sentence twice. */}
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Withdraw this request?</DialogTitle>
            {/* ⚠️ TWO DIFFERENT FACTS, so two different sentences. "Nobody is
                asked to decide it" is plainly false of leave a manager approved
                last week, and telling somebody that while they undo a signed
                decision is how a confirm dialog stops being read at all. */}
            <DialogDescription>
              {needsNote ? (
                <>
                  This has already been approved. Withdrawing it takes the leave off the calendar
                  and releases anyone covering for you, and the people who approved it will be told.
                  It is not the same as being rejected — the record will say you took it back — but
                  you cannot undo it.
                </>
              ) : (
                <>
                  It stops here and nobody is asked to decide it. Withdrawing is not the same as
                  being rejected — the record will say you took it back — but you cannot undo it.
                  File a new request if you change your mind.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {/* No `htmlFor`: the editor's input is a contenteditable `div`,
                which is not a labelable element, so `htmlFor` would resolve to
                nothing. The editor carries the same words as its `aria-label`
                instead — the same arrangement as the decision panel. */}
            <Label>
              Note{" "}
              <span className="text-muted-foreground">
                ({needsNote ? "required" : "optional"})
              </span>
            </Label>
            <RichTextEditor
              value={note}
              // The error clears as soon as they start writing, rather than on
              // the next submit. An error message that outlives the mistake is
              // read as a second, different complaint.
              onChange={(value) => {
                setNote(value);
                if (error) setError(null);
              }}
              ariaLabel="Why you are withdrawing this"
              invalid={Boolean(error)}
              placeholder={
                needsNote
                  ? "Why you are taking it back. The people who approved it will see this."
                  : "Why you are taking it back. Whoever was waiting on this will see it."
              }
              minHeight="min-h-20"
            />
            {/* The cap. There is no floor to show even when a note is required:
                the rule is "write something", not "write 5 characters", and a
                counter cannot say the first. */}
            <CharacterCount value={note} max={INTERNAL_REASON_MAX} rich />
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {/* Said plainly, because a note written for a team leader and
                    read by three relievers is not what "note" alone implies. */}
                {needsNote
                  ? "Everyone who signed this will see it, and it stays on the record."
                  : "Everyone who was waiting on this request will see it, and it stays on the record."}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Keep it
            </Button>
            {/* A form action rather than an onClick: React gives it its own
                transition, and the confirm still works with JS loading. */}
            <form action={withdraw}>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending ? "Withdrawing…" : "Withdraw"}
              </Button>
            </form>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
