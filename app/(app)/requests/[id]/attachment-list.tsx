"use client";

import { useState } from "react";
import { Download, Loader2, Paperclip } from "lucide-react";
import { toast } from "@/components/ui/toast";

import { formatBytes } from "@/lib/attachments";

import { getAttachmentDownloadUrl } from "../actions";

/**
 * P1-09 — the staff-side attachment list.
 *
 * Each row fetches its own signed URL on click rather than the page minting URLs
 * for everything up front. Two reasons: a signed URL in the HTML is a signed URL
 * in the browser history and in any screenshot of the page source, and most
 * attachments on most requests are never opened.
 */

export type Attachment = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  field_key: string | null;
};

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  const [opening, setOpening] = useState<string | null>(null);

  async function open(attachment: Attachment) {
    setOpening(attachment.id);
    try {
      const result = await getAttachmentDownloadUrl(attachment.id);

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      window.open(result.url, "_blank", "noopener,noreferrer");
    } finally {
      setOpening(null);
    }
  }

  if (attachments.length === 0) {
    return <p className="text-xs text-muted-foreground">None.</p>;
  }

  return (
    <ul className="space-y-1">
      {attachments.map((attachment) => (
        <li key={attachment.id}>
          <button
            type="button"
            onClick={() => open(attachment)}
            disabled={opening !== null}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60 disabled:opacity-60"
          >
            {opening === attachment.id ? (
              <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
            <span className="shrink-0 text-2xs text-muted-foreground">
              {formatBytes(attachment.size_bytes)}
            </span>
            <Download className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}
