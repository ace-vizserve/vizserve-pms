"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Archive, ArchiveRestore, Ban, Loader2, MoreHorizontal, RotateCcw, Trash2 } from "lucide-react";
import { toast } from "@/components/ui/toast";

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
import { Textarea } from "@/components/ui/textarea";
import { formatDuration } from "@/lib/dates";
import { useTaskRefresh } from "@/lib/query/use-task-refresh";
import type { TaskStatus } from "@/lib/schemas/tasks";

import {
  archiveClientTask,
  cancelClientTask,
  clientTaskDeleteImpact,
  deleteClientTask,
  reopenClientTask,
  restoreClientTask,
  type ClientTaskDeleteImpact,
} from "../client-task-lifecycle";

type Dialogs = "cancel" | "archive" | "delete" | null;

/**
 * P16-03 — the client task's own lifecycle: cancel, reopen, archive, restore,
 * delete. Every one of them asks for a reason, and delete also asks for the
 * word DELETE once it has said what goes with the task.
 *
 * `canSteer` (Team Leader of the department, or the Manager) and `canDelete`
 * (Manager or Admin) only decide what is offered; the database functions decide
 * what is allowed.
 */
export function ClientTaskMenu({
  taskId,
  title,
  status,
  archived,
  canSteer,
  canDelete,
}: {
  taskId: string;
  title: string;
  status: TaskStatus;
  archived: boolean;
  canSteer: boolean;
  canDelete: boolean;
}) {
  const router = useRouter();
  const refresh = useTaskRefresh();
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, startTransition] = useTransition();
  const [impact, setImpact] = useState<ClientTaskDeleteImpact | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);

  // The damage is read when Delete is chosen, so the dialog can say it first.
  function openDelete() {
    setImpact(null);
    setImpactError(null);
    setDialog("delete");
    void clientTaskDeleteImpact(taskId).then((result) => {
      if (!result.ok) setImpactError(result.error);
      else setImpact(result.data);
    });
  }

  const finished = status === "COMPLETED" || status === "COMPLETED_NO_RESPONSE";
  const cancelled = status === "CANCELLED";

  const items = {
    cancel: canSteer && !finished && !cancelled,
    reopen: canSteer && cancelled && !archived,
    archive: canSteer && (finished || cancelled) && !archived,
    restore: canSteer && archived,
    delete: canDelete,
  };
  if (!Object.values(items).some(Boolean)) return null;

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        toast.error(result.error ?? "That did not work.");
        return;
      }
      await refresh();
      toast.success(success);
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="outline" size="icon-sm" disabled={pending} aria-label="More actions for this task">
              {pending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
            </Button>
          }
        />
        <DropdownMenuContent align="end">
          {items.cancel ? (
            <DropdownMenuItem onClick={() => setDialog("cancel")}>
              <Ban />
              Cancel task
            </DropdownMenuItem>
          ) : null}
          {items.reopen ? (
            <DropdownMenuItem onClick={() => run(() => reopenClientTask(taskId), "Reopened.")}>
              <RotateCcw />
              Reopen
            </DropdownMenuItem>
          ) : null}
          {items.archive ? (
            <DropdownMenuItem onClick={() => setDialog("archive")}>
              <Archive />
              Archive
            </DropdownMenuItem>
          ) : null}
          {items.restore ? (
            <DropdownMenuItem onClick={() => run(() => restoreClientTask(taskId), "Restored from the archive.")}>
              <ArchiveRestore />
              Restore
            </DropdownMenuItem>
          ) : null}
          {items.delete ? (
            <>
              {items.cancel || items.reopen || items.archive || items.restore ? <DropdownMenuSeparator /> : null}
              <DropdownMenuItem variant="destructive" onClick={openDelete}>
                <Trash2 />
                Delete
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "cancel" ? (
        <ReasonDialog
          title="Cancel this task?"
          description="Work stops and it leaves every open count and performance figure. Logged hours stay. Its request is cancelled too. You can reopen it."
          confirmLabel="Cancel task"
          placeholder="e.g. The client withdrew the request."
          onClose={() => setDialog(null)}
          onConfirm={(reason) => cancelClientTask(taskId, { reason })}
          onDone={async () => {
            await refresh();
            toast.success("Cancelled.");
          }}
        />
      ) : null}

      {dialog === "archive" ? (
        <ReasonDialog
          title="Archive this task?"
          description="It leaves the lists and the board. Nothing is deleted, reports still count it, and the request page still links to it. You can restore it."
          confirmLabel="Archive"
          placeholder="e.g. Delivered and closed last quarter."
          destructive={false}
          onClose={() => setDialog(null)}
          onConfirm={(reason) => archiveClientTask(taskId, { reason })}
          onDone={async () => {
            await refresh();
            toast.success("Archived.");
          }}
        />
      ) : null}

      {dialog === "delete" ? (
        <DeleteDialog
          taskId={taskId}
          title={title}
          impact={impact}
          impactError={impactError}
          onClose={() => setDialog(null)}
          onDeleted={async () => {
            toast.success("Task deleted.");
            router.push("/tasks");
            await refresh();
          }}
        />
      ) : null}
    </>
  );
}

function ReasonDialog({
  title,
  description,
  confirmLabel,
  placeholder,
  destructive = true,
  onClose,
  onConfirm,
  onDone,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  placeholder: string;
  destructive?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<{ ok: boolean; error?: string }>;
  onDone: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await onConfirm(reason);
      if (!result.ok) {
        setError(result.error ?? "That did not work.");
        return;
      }
      await onDone();
      onClose();
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next || pending ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="task-lifecycle-reason">Reason</Label>
          <Textarea
            id="task-lifecycle-reason"
            rows={3}
            value={reason}
            disabled={pending}
            placeholder={placeholder}
            aria-invalid={Boolean(error)}
            onChange={(event) => setReason(event.target.value)}
          />
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Back
          </Button>
          <Button
            variant={destructive ? "destructive" : "default"}
            onClick={submit}
            loading={pending}
            disabled={reason.trim().length < 3}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  taskId,
  title,
  impact,
  impactError,
  onClose,
  onDeleted,
}: {
  taskId: string;
  title: string;
  impact: ClientTaskDeleteImpact | null;
  impactError: string | null;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const error = submitError ?? impactError;

  const blocked = impact?.ok === false ? impact.reason : null;
  const damage = impact?.ok ? impact : null;
  const losses = damage
    ? [
        damage.subtasks > 0 ? `${damage.subtasks} ${damage.subtasks === 1 ? "subtask" : "subtasks"}` : null,
        damage.tracked_minutes > 0 ? `${formatDuration(damage.tracked_minutes)} of logged time` : null,
        damage.comments > 0 ? `${damage.comments} ${damage.comments === 1 ? "comment" : "comments"}` : null,
        damage.attachments > 0 ? `${damage.attachments} ${damage.attachments === 1 ? "file" : "files"}` : null,
      ].filter(Boolean)
    : [];

  function submit() {
    setSubmitError(null);
    startTransition(async () => {
      const result = await deleteClientTask(taskId, { reason });
      if (!result.ok) {
        setSubmitError(result.error);
        return;
      }
      onClose();
      await onDeleted();
    });
  }

  return (
    <Dialog open onOpenChange={(next) => (next || pending ? null : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this task for good?</DialogTitle>
          <DialogDescription className="break-words">{title}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm">
          {!impact && !error ? (
            <p className="text-muted-foreground">Checking what this would remove…</p>
          ) : blocked ? (
            <p role="alert" className="rounded-sm border border-warning-border bg-warning-subtle px-3 py-2 text-xs">
              {blocked}
            </p>
          ) : damage ? (
            <>
              <div className="rounded-sm border border-destructive-border bg-destructive-subtle px-3 py-2 text-xs text-destructive">
                <p className="font-medium">This cannot be undone.</p>
                {losses.length > 0 ? <p className="mt-1">It also deletes {losses.join(", ")}.</p> : null}
                <p className="mt-1">Its request is marked cancelled. The audit log keeps what was removed and why.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="delete-task-reason">Reason</Label>
                <Textarea
                  id="delete-task-reason"
                  rows={2}
                  value={reason}
                  disabled={pending}
                  onChange={(event) => setReason(event.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="delete-task-confirm">
                  Type <span className="font-semibold">DELETE</span> to confirm
                </Label>
                <Input
                  id="delete-task-confirm"
                  value={typed}
                  autoComplete="off"
                  disabled={pending}
                  onChange={(event) => setTyped(event.target.value)}
                />
              </div>
            </>
          ) : null}

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Back
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            loading={pending}
            disabled={!damage || typed !== "DELETE" || reason.trim().length < 3}>
            Delete task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
