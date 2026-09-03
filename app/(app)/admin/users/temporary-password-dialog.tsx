"use client";

import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * P8-11 — the one and only time this password is ever on a screen.
 *
 * ⚠️ IT IS NOT STORED ANYWHERE AND CANNOT BE FETCHED AGAIN. The server returned
 * it from the action that set it and kept no copy: not in the audit row, not in
 * a column, not in a mail. Closing this dialog destroys the only readable copy
 * that exists, and the recovery is to issue another one — which writes another
 * audit row naming whoever did it.
 *
 * That is why the copy button and the warning are not decoration. An owner who
 * closes this before writing the password down has quietly locked somebody out
 * of their own account until they come back and ask.
 */
export function TemporaryPasswordDialog({
  issued,
  onClose,
}: {
  /** Null when nothing has been issued. Set by the action's return value. */
  issued: { email: string; password: string; created?: boolean } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!issued) return;

    try {
      await navigator.clipboard.writeText(issued.password);
      setCopied(true);
      toast.success("Copied.");
    } catch {
      // Clipboard access is refused outside a secure context and in some
      // locked-down browsers. The password is on screen either way, which is
      // why this fails quietly rather than alarming anybody — the fallback is
      // reading it.
      toast.error("Could not copy. Select the password and copy it manually.");
    }
  }

  return (
    <Dialog
      open={Boolean(issued)}
      onOpenChange={(open) => {
        if (!open) {
          setCopied(false);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {issued?.created ? "Account created" : "Temporary password issued"}
          </DialogTitle>
          <DialogDescription>
            Give this to {issued?.email} yourself — it is not emailed. They will be asked to
            replace it the moment they sign in, and nothing else in the app is reachable until
            they do.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border bg-muted/40 p-3">
            <KeyRound className="size-4 shrink-0 text-muted-foreground" />
            {/*
              `select-all` and a monospace face. This string gets read aloud or
              copied, and the generator already leaves out 0/O and 1/l for the
              same reason — a temporary password that fails on the third attempt
              because somebody heard an O for a zero is a support call.
            */}
            <code className="flex-1 font-mono text-sm break-all select-all">
              {issued?.password}
            </code>
            <Button type="button" variant="ghost" size="icon-sm" onClick={copy} title="Copy">
              {copied ? <Check /> : <Copy />}
              <span className="sr-only">Copy the temporary password</span>
            </Button>
          </div>

          <p
            role="status"
            className="rounded-md border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
          >
            This is the only time it is shown. It is stored nowhere and cannot be looked up again
            — if you close this without keeping it, issue another one.
          </p>
        </div>

        <Button
          type="button"
          onClick={() => {
            setCopied(false);
            onClose();
          }}
        >
          I have it
        </Button>
      </DialogContent>
    </Dialog>
  );
}
