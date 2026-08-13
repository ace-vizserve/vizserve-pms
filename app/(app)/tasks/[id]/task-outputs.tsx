"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Loader2, Paperclip, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatBytes } from "@/lib/attachments";

import { getTaskAttachmentUrl, removeTaskAttachment, uploadTaskOutput } from "../actions";

/**
 * P3-13 — the PIC's output files.
 *
 * These are what the QA reviewer opens, and in Phase 4 what the client sees on
 * the approval page. That is the reason they are files on the task rather than a
 * link pasted into the resolution: a Drive link rots, and the client approval
 * page cannot render one it has no permission to read.
 */

export type TaskAttachment = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string | null;
};

export function TaskOutputs({
  taskId,
  attachments,
  canUpload,
  uploaderNames,
}: {
  taskId: string;
  attachments: TaskAttachment[];
  canUpload: boolean;
  uploaderNames: Map<string, string>;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    startTransition(async () => {
      // Sequential. Several large files in parallel from an office connection is
      // how you get several timeouts instead of several files.
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.set("task_id", taskId);
        formData.set("file", file);

        const result = await uploadTaskOutput(formData);

        if (!result.ok) {
          // Name the file — "that file is too large" is useless when four were
          // selected.
          setError(`${file.name}: ${result.error}`);
          break;
        }
      }

      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    });
  }

  async function open(attachment: TaskAttachment) {
    setOpening(attachment.id);
    try {
      const result = await getTaskAttachmentUrl(attachment.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      window.open(result.data.url, "_blank", "noopener,noreferrer");
    } finally {
      setOpening(null);
    }
  }

  function remove(attachment: TaskAttachment) {
    startTransition(async () => {
      const result = await removeTaskAttachment(attachment.id, taskId);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Removed");
      router.refresh();
    });
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Output files</CardTitle>
        <CardDescription className="text-xs">
          What you produced. The QA reviewer opens these, and the client sees them at approval.
        </CardDescription>

        {canUpload ? (
          <CardAction>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="sr-only"
              id="task-output-upload"
              disabled={pending}
              onChange={(event) => handleFiles(event.target.files)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => inputRef.current?.click()}
            >
              {pending ? <Loader2 className="animate-spin" /> : <Upload />}
              {pending ? "Uploading…" : "Upload"}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>

      <CardContent>
        {attachments.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {canUpload ? "Nothing uploaded yet." : "None."}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {attachments.map((attachment) => (
              <li
                key={attachment.id}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
              >
                <button
                  type="button"
                  onClick={() => open(attachment)}
                  disabled={opening !== null}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {opening === attachment.id ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                  <span className="shrink-0 text-2xs text-muted-foreground">
                    {formatBytes(attachment.size_bytes)}
                    {attachment.uploaded_by
                      ? ` · ${uploaderNames.get(attachment.uploaded_by) ?? "someone"}`
                      : null}
                  </span>
                  <Download className="size-3.5 shrink-0 text-muted-foreground" />
                </button>

                {canUpload ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0"
                    disabled={pending}
                    onClick={() => remove(attachment)}
                  >
                    <X />
                    <span className="sr-only">Remove {attachment.filename}</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {error ? (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
