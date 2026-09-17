"use client";

import { Archive, ArchiveRestore, Loader2, MoreHorizontal, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";

import {
  archiveForm,
  deleteForm,
  getFormWorkload,
  restoreForm,
  type FormWorkload,
} from "./actions";

/**
 * P7-72 — archive, restore and delete, and the confirmation in front of
 * unpublishing.
 *
 * ⚠️ NOTHING HERE DECIDES ANYTHING. Every refusal is raised by the database
 * (`vizserve_pms_archive_form`, `vizserve_pms_delete_form`) and every count is
 * read from `vizserve_pms_form_workload` — the function those two decide from.
 * The dialogs explain in advance what the database will say, so nobody fills in
 * a confirmation only to be refused; they are not what enforces it.
 */

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Loads the counts once, when the dialog mounts.
 *
 * The dialogs below are MOUNTED ONLY WHILE OPEN, so closing one discards its
 * counts and its typed confirmation with it — nothing to reset, and a reopened
 * dialog never shows the previous opening's numbers.
 */
function useWorkload(formId: string) {
  const [workload, setWorkload] = useState<FormWorkload | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getFormWorkload(formId).then((result) => {
      if (cancelled) return;
      if (result.ok) setWorkload(result.data);
      else setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [formId]);

  return { workload, error };
}

function Loading({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      Checking what is behind this form…
    </p>
  );
}

// ---------------------------------------------------------------------------
// The row menu on /forms.
// ---------------------------------------------------------------------------

export function FormRowActions({
  form,
  isOwner,
}: {
  form: { id: string; name: string; archived_at: string | null };
  /** Force delete is owner-only in the database; this only decides what to offer. */
  isOwner: boolean;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<"archive" | "delete" | null>(null);
  const [pending, startTransition] = useTransition();

  function restore() {
    startTransition(async () => {
      const result = await restoreForm(form.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${form.name} restored. It stays unpublished until you publish it.`);
      router.refresh();
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-xs" disabled={pending} aria-label={`Actions for ${form.name}`}>
              {pending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {form.archived_at ? (
            <DropdownMenuItem onClick={restore}>
              <ArchiveRestore />
              Restore
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={() => setDialog("archive")}>
              <Archive />
              Archive
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
            <Trash2 />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "archive" ? <ArchiveFormDialog form={form} onClose={() => setDialog(null)} /> : null}
      {dialog === "delete" ? (
        <DeleteFormDialog form={form} isOwner={isOwner} onClose={() => setDialog(null)} />
      ) : null}
    </>
  );
}

function ArchiveFormDialog({
  form,
  onClose,
}: {
  form: { id: string; name: string };
  onClose: () => void;
}) {
  const router = useRouter();
  const { workload, error } = useWorkload(form.id);
  const [pending, startTransition] = useTransition();

  const blocked = workload !== null && (workload.pending_requests > 0 || workload.open_tasks > 0);

  function archive() {
    startTransition(async () => {
      const result = await archiveForm(form.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${form.name} archived.`);
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {form.name}?</DialogTitle>
          <DialogDescription>
            It stops accepting submissions and leaves the forms list. Nothing is deleted — every request,
            response and task is kept, and reports still count them.
          </DialogDescription>
        </DialogHeader>

        {workload === null ? (
          <Loading error={error} />
        ) : blocked ? (
          <p role="alert" className="rounded-sm border border-warning-border bg-warning-subtle px-3 py-2 text-sm">
            It still has {plural(workload.pending_requests, "pending request", "pending requests")} and{" "}
            {plural(workload.open_tasks, "open task", "open tasks")}. Decide the requests and close the tasks
            first, then archive it.
          </p>
        ) : workload.list_name ? (
          <p className="text-sm text-muted-foreground">
            Its list, <span className="font-medium text-foreground">{workload.list_name}</span>, is archived with
            it and comes back if you restore the form.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={archive} disabled={workload === null || blocked} loading={pending}>
            Archive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFormDialog({
  form,
  isOwner,
  onClose,
}: {
  form: { id: string; name: string; archived_at: string | null };
  isOwner: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const { workload, error } = useWorkload(form.id);
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();

  const submissions = workload ? workload.requests + workload.responses : 0;

  /*
   * The same three refusals `vizserve_pms_delete_form` raises, in the same
   * order, so the dialog never offers a button the database will turn down.
   */
  let refusal: string | null = null;
  if (workload) {
    if (workload.tasks_from_requests > 0) {
      refusal = `${plural(workload.tasks_from_requests, "request", "requests")} from this form became tasks, so it cannot be deleted. ${
        form.archived_at ? "It is already archived, which keeps everything." : "Archive it instead — nothing is lost, and its tasks stay client work."
      }`;
    } else if (workload.open_tasks > 0) {
      refusal = `Its list still has ${plural(workload.open_tasks, "open task", "open tasks")}. Close or move them before deleting the form.`;
    } else if (submissions > 0 && !isOwner) {
      refusal = `This form has ${plural(submissions, "submission", "submissions")}. Deleting it deletes them too, which only an owner can do. Archiving keeps them.`;
    }
  }

  const force = submissions > 0;
  const confirmed = !force || typed.trim() === form.name.trim();

  function remove() {
    startTransition(async () => {
      const result = await deleteForm(form.id, force);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${form.name} deleted.`);
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {form.name}?</DialogTitle>
          <DialogDescription>
            This cannot be undone. The deletion is recorded in the audit log. Its list, if it has one, is
            archived rather than deleted.
          </DialogDescription>
        </DialogHeader>

        {workload === null ? (
          <Loading error={error} />
        ) : refusal ? (
          <p role="alert" className="rounded-sm border border-warning-border bg-warning-subtle px-3 py-2 text-sm">
            {refusal}
          </p>
        ) : force ? (
          <div className="space-y-3">
            <p
              role="alert"
              className="rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2 text-sm text-destructive">
              This also permanently deletes{" "}
              {[
                workload.requests > 0 ? plural(workload.requests, "request", "requests") : null,
                workload.responses > 0 ? plural(workload.responses, "response", "responses") : null,
              ]
                .filter(Boolean)
                .join(" and ")}
              , with every uploaded file. None of them became a task.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="confirm-form-name">
                Type <span className="font-semibold">{form.name}</span> to confirm
              </Label>
              <Input
                id="confirm-form-name"
                value={typed}
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Nothing has been submitted to it.</p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={remove}
            disabled={workload === null || refusal !== null || !confirmed}
            loading={pending}>
            {force ? "Delete with submissions" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Unpublishing.
// ---------------------------------------------------------------------------

/**
 * P7-72 — TAKING A FORM DOWN IS NOT A PLAIN TOGGLE ONCE WORK HAS COME IN.
 *
 * Nothing is lost by unpublishing — the list, its tasks and every pending
 * request stay exactly where they are — but a form with work behind it going
 * quiet should be a decision somebody saw the numbers for, not a misclick.
 *
 * Usage: `confirm(proceed)` reads the counts and either runs `proceed` straight
 * away (nothing behind the form) or opens the dialog, which runs it on confirm.
 * Render `dialog` once, anywhere in the component.
 */
export function useUnpublishConfirm(formId: string | undefined) {
  const [workload, setWorkload] = useState<FormWorkload | null>(null);
  const [proceed, setProceed] = useState<(() => void) | null>(null);
  // A ref, not state: it is only ever read inside `close`, never drawn.
  const cancelRef = useRef<(() => void) | null>(null);

  async function confirm(run: () => void, onCancel?: () => void) {
    if (!formId) return run();

    const result = await getFormWorkload(formId);
    // Fails OPEN to the dialog rather than to the save: unable to count is not
    // the same as nothing to count.
    const counts = result.ok
      ? result.data
      : { requests: 0, pending_requests: 0, responses: 0, tasks_from_requests: 0, open_tasks: 0, list_name: null };

    if (result.ok && counts.requests + counts.responses + counts.open_tasks === 0) return run();

    setWorkload(counts);
    setProceed(() => () => run());
    cancelRef.current = onCancel ?? null;
  }

  function close(confirmed: boolean) {
    if (confirmed) proceed?.();
    else cancelRef.current?.();
    setWorkload(null);
    setProceed(null);
  }

  const dialog = (
    <Dialog open={workload !== null} onOpenChange={(next) => (next ? null : close(false))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unpublish this form?</DialogTitle>
          <DialogDescription>
            It stops accepting new submissions. Everything already in stays where it is and is still counted in
            reports.
          </DialogDescription>
        </DialogHeader>

        {workload ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {workload.requests > 0 ? (
              <li>
                {plural(workload.requests, "request", "requests")}
                {workload.pending_requests > 0 ? `, ${workload.pending_requests} still waiting for a decision` : null}
              </li>
            ) : null}
            {workload.responses > 0 ? <li>{plural(workload.responses, "response", "responses")}</li> : null}
            {workload.open_tasks > 0 ? (
              <li>
                {plural(workload.open_tasks, "open task", "open tasks")}
                {workload.list_name ? ` in ${workload.list_name}` : null}
              </li>
            ) : null}
            {workload.requests + workload.responses + workload.open_tasks === 0 ? (
              <li>The counts could not be read. Unpublish only if you are sure nothing is waiting on it.</li>
            ) : null}
          </ul>
        ) : null}

        <DialogFooter>
          <Button variant="ghost" onClick={() => close(false)}>
            Keep it published
          </Button>
          <Button variant="destructive" onClick={() => close(true)}>
            Unpublish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}
