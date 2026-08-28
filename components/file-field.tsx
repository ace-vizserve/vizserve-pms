"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Paperclip, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/attachments";
import type { AttachmentRef } from "@/lib/schemas/forms";

/**
 * P1-09 — the file picker.
 *
 * Uploads on selection rather than on submit, which is the difference between
 * "your request failed, re-pick four files" and "that one file was too large".
 * Each upload returns a receipt id; the form value is the list of receipts.
 *
 * The client-side size and type hints below are courtesy only. The real limits
 * are enforced server-side on the actual bytes, and this component never sees
 * whether they passed until the server says so.
 */

export type UploadFn = (formData: FormData) => Promise<
  { ok: true; attachment: AttachmentRef } | { ok: false; error: string }
>;

export function FileField({
  id,
  formId,
  fieldKey,
  value,
  onChange,
  upload,
  accept,
  maxFiles = 10,
  maxBytes,
  disabled,
}: {
  id: string;
  formId: string;
  fieldKey: string | null;
  value: AttachmentRef[];
  onChange: (next: AttachmentRef[]) => void;
  upload: UploadFn;
  /** Passed straight to the input. A filter, not a guarantee. */
  accept?: string;
  maxFiles?: number;
  maxBytes?: number;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const full = value.length >= maxFiles;

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setError(null);

    const room = maxFiles - value.length;
    if (files.length > room) {
      setError(`You can attach ${maxFiles} files in total.`);
    }

    const batch = Array.from(files).slice(0, Math.max(room, 0));

    startTransition(async () => {
      const accepted: AttachmentRef[] = [];

      // Sequential, not parallel. Five simultaneous 10 MB uploads from a client
      // on office wifi is how you get five timeouts instead of five files.
      for (const file of batch) {
        /*
         * SIZE CHECKED HERE, BEFORE THE POST, and this is not merely a
         * courtesy like the `accept` filter is.
         *
         * An oversize file is not rejected cleanly by the server — the request
         * body exceeds Next’s Server Action limit, the multipart stream is
         * TRUNCATED, and the parser fails with “Unexpected end of form”. That
         * surfaces as a framework stack trace pointing at this component rather
         * than at the file, so the person uploading has no idea what went wrong.
         *
         * The server still enforces the real rule against the actual bytes
         * (`uploadPendingAttachment`); this exists so the common case gets a
         * sentence instead of a crash.
         */
        if (maxBytes && file.size > maxBytes) {
          setError(
            `${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(maxBytes)}.`,
          );
          break;
        }

        const formData = new FormData();
        formData.set("form_id", formId);
        if (fieldKey) formData.set("field_key", fieldKey);
        formData.set("file", file);

        const result = await upload(formData);

        if (!result.ok) {
          // Name the file. "That file is too large" is useless when four were
          // selected.
          setError(`${file.name}: ${result.error}`);
          break;
        }

        accepted.push({ ...result.attachment, field_key: fieldKey });
      }

      if (accepted.length > 0) onChange([...value, ...accepted]);

      // Reset the input so re-picking the same file fires a change event.
      if (inputRef.current) inputRef.current.value = "";
    });
  }

  function remove(id: string) {
    // Drops the receipt, not the object. The sweeper collects anything
    // unredeemed after a day — deleting here would need a second endpoint
    // that takes an id from an unauthenticated caller, which is a worse trade.
    onChange(value.filter((attachment) => attachment.id !== id));
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        id={id}
        type="file"
        multiple
        accept={accept}
        className="sr-only"
        disabled={disabled || pending || full}
        onChange={(event) => handleFiles(event.target.files)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || pending || full}
          onClick={() => inputRef.current?.click()}
        >
          {pending ? <Loader2 className="animate-spin" /> : <Paperclip />}
          {pending ? "Uploading…" : value.length > 0 ? "Add another" : "Choose files"}
        </Button>

        <span className="text-xs text-muted-foreground">
          {full
            ? `${maxFiles} files attached — that is the limit.`
            : maxBytes
              ? `Up to ${formatBytes(maxBytes)} each.`
              : null}
        </span>
      </div>

      {value.length > 0 ? (
        <ul className="space-y-1">
          {value.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
            >
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatBytes(attachment.size_bytes)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="size-6 shrink-0 p-0"
                onClick={() => remove(attachment.id)}
                disabled={disabled || pending}
              >
                <X className="size-3.5" />
                <span className="sr-only">Remove {attachment.filename}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
