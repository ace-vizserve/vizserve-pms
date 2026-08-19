"use client";

import { useState } from "react";
import { Download, Loader2, Paperclip } from "lucide-react";
import { toast } from "sonner";

import { formatBytes } from "@/lib/attachments";

import { getRequestAttachmentUrl } from "../actions";

/**
 * P7-22 — the files the CLIENT sent, on the task.
 *
 * Deliberately not a reuse of `requests/[id]/attachment-list.tsx`, which looks
 * identical and is not: that component calls `getAttachmentDownloadUrl`, which
 * opens with `requireRole("team_leader")` because it serves the Gate 1 review.
 * Importing it here would render a list of files that every member — the people
 * this card exists for — is refused on click.
 *
 * Same signing rule as everywhere else: each row asks for its own URL when
 * clicked rather than the page minting URLs up front. A signed URL in the HTML
 * is a signed URL in the browser history and in any screenshot of the source,
 * and most attachments on most requests are never opened.
 */

export type ClientFile = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
};

export function RequestAttachmentList({ attachments }: { attachments: ClientFile[] }) {
  const [opening, setOpening] = useState<string | null>(null);

  async function open(file: ClientFile) {
    setOpening(file.id);
    try {
      const result = await getRequestAttachmentUrl(file.id);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      window.open(result.data.url, "_blank", "noopener,noreferrer");
    } finally {
      setOpening(null);
    }
  }

  return (
    <ul className="space-y-0.5">
      {attachments.map((file) => (
        <li key={file.id}>
          <button
            type="button"
            onClick={() => open(file)}
            disabled={opening !== null}
            className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted/60 disabled:opacity-60"
          >
            {opening === file.id ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{file.filename}</span>
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              {formatBytes(file.size_bytes)}
            </span>
            <Download className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            {/* The icon is not a label. Without this the button reads as the
                filename alone and gives no clue that clicking opens it. */}
            <span className="sr-only">Open {file.filename}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
