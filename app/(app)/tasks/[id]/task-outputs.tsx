"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Download, Link2, Loader2, Paperclip, Plus, Upload, X } from "lucide-react";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatBytes } from "@/lib/attachments";

import { outputLinkSchema } from "@/lib/schemas/tasks";

import {
  getTaskAttachmentUrl,
  removeTaskAttachment,
  updateTaskField,
  uploadTaskOutput,
} from "../actions";

/**
 * P3-13 — the PIC's output files.
 *
 * These are what the QA reviewer opens, and in Phase 4 what the client sees on
 * the approval page. That is the reason they are files on the task rather than a
 * link pasted into the resolution: a Drive link rots, and the client approval
 * page cannot render one it has no permission to read.
 *
 * ------------------------------------------------------------------------
 * P7-56 — `variant="field"`, AND THE REASON IT NOW EXISTS.
 *
 * The paragraph above draws a real distinction between a file and a link, and
 * the page then used that distinction to put them in two different places: the
 * "Output link" input sat in `TaskWorkflow`, and these — the OTHER half of the
 * same answer to "where is the thing you made" — were a separate card two
 * sections further down, with Subtasks between them. Nobody looking for the
 * deliverable thinks "is it a URL or a file?" first.
 *
 * A file being more durable than a link is an argument about which one to
 * PREFER. It was never an argument for putting them on opposite ends of the
 * page, so in `field` form this renders as the third field of the card's
 * "What you produced" section, directly under the link.
 *
 * `card` is unchanged and stays the default — nothing else has to move for
 * this, and a caller that wants the standalone panel still gets it.
 * ------------------------------------------------------------------------
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
  outputLink = "",
  variant = "card",
}: {
  taskId: string;
  attachments: TaskAttachment[];
  canUpload: boolean;
  uploaderNames: Map<string, string>;
  /**
   * P7-57 — THE LINK IS AN OUTPUT, so it lives in the same list as the files.
   *
   * It was a labelled `<input type="url">` sitting above this component, which
   * asked the reader to decide "is what I made a URL or a file?" before they
   * could look for it. Nobody thinks that way. One heading, one "Add output"
   * menu, one list.
   *
   * ⚠️ AND IT IS ONE LINK, NOT A LIST OF THEM. `vizserve_pms_tasks.output_link`
   * is a single text column, so "Paste a link" REPLACES whatever is there and
   * the dialog says so. A second link needs a column that does not exist yet —
   * do not fake it with a comma-separated string.
   */
  outputLink?: string;
  /**
   * `card` is its own panel. `field` is a labelled block for a section that
   * already has a heading — see the note above.
   */
  variant?: "card" | "field";
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * THE LINK DIALOG. An EXPLICIT SAVE rather than the autosaved field this
   * replaced, and that is the point of putting it behind a menu: `https:` is
   * invalid on the way to being valid, so an autosaved URL either flashed an
   * error on every pause or silently swallowed half-typed input. A dialog has
   * one moment to validate at, and a Cancel that means it.
   */
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState(outputLink);
  const [linkError, setLinkError] = useState<string | null>(null);

  function openLink() {
    // Seeded on open, so a change made in another tab is not overwritten by a
    // stale draft sitting in this component.
    setLinkDraft(outputLink);
    setLinkError(null);
    setLinkOpen(true);
  }

  function saveLink(next: string) {
    const parsed = outputLinkSchema.safeParse(next);
    if (!parsed.success) {
      // Text next to the field plus `aria-invalid`, never a toast: a toast puts
      // a field message in the far corner of the screen.
      setLinkError(parsed.error.issues[0]?.message ?? "That is not a link.");
      return;
    }

    startTransition(async () => {
      const result = await updateTaskField(taskId, { output_link: parsed.data });
      if (!result.ok) {
        setLinkError(result.error ?? "That did not go through.");
        return;
      }
      setLinkOpen(false);
      toast.success(parsed.data ? "Link saved" : "Link removed");
      router.refresh();
    });
  }

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

  /*
   * The upload control, built once for both shapes.
   *
   * The `<input>` is `sr-only` rather than absent: the Button is the visible
   * affordance, but the field still has to exist for the label below to point
   * at and for the file dialog to come from.
   */
  const fileInput = canUpload ? (
    <input
      ref={inputRef}
      type="file"
      multiple
      className="sr-only"
      id="task-output-upload"
      disabled={pending}
      onChange={(event) => handleFiles(event.target.files)}
    />
  ) : null;

  /*
   * ONE "ADD OUTPUT" MENU, TWO WAYS TO ANSWER THE SAME QUESTION.
   *
   * A labelled "Upload" button and a separate URL field asked the reader to
   * classify their own deliverable before they could record it. They are one
   * job — say where the thing you made is — so they are one control, and both
   * routes land in the one list below it.
   */
  const addOutput = canUpload ? (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="xs" disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Plus />}
            {pending ? "Uploading…" : "Add output"}
            <ChevronDown />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => inputRef.current?.click()}>
          <Upload />
          Upload a file
        </DropdownMenuItem>
        <DropdownMenuItem onClick={openLink}>
          <Link2 />
          {outputLink ? "Replace the link" : "Paste a link"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  const upload = canUpload ? (
    <>
      {fileInput}
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => inputRef.current?.click()}>
        {pending ? <Loader2 className="animate-spin" /> : <Upload />}
        {pending ? "Uploading…" : "Upload"}
      </Button>
    </>
  ) : null;

  const showLink = variant === "field" && outputLink.length > 0;

  const body = (
    <>
      {attachments.length === 0 && !showLink ? (
        <p className="text-xs text-muted-foreground">{canUpload ? "Nothing here yet." : "None."}</p>
      ) : (
        <ul className="space-y-0.5">
          {/* THE LINK, AS A ROW. First, because a task that has one usually has
              it before the files exist — and because the right-hand "link" is
              what tells it apart from the sizes underneath. */}
          {showLink ? (
            <li className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
              <a
                href={outputLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Link2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{outputLink}</span>
                <span className="shrink-0 text-2xs text-muted-foreground">link</span>
              </a>

              {canUpload ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  disabled={pending}
                  onClick={() => saveLink("")}>
                  <X />
                  <span className="sr-only">Remove the output link</span>
                </Button>
              ) : null}
            </li>
          ) : null}

          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/50">
              <button
                type="button"
                onClick={() => open(attachment)}
                disabled={opening !== null}
                className="flex min-w-0 flex-1 items-center gap-2 text-left">
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
                  onClick={() => remove(attachment)}>
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
    </>
  );

  if (variant === "field") {
    return (
      <div className="space-y-2">
        {fileInput}

        {/* The heading and its one action on the same line. */}
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold text-foreground">Output</h3>
          {addOutput}
        </div>

        {/* `-mx-2` so a row's hover fill bleeds to the section's edges rather
            than sitting inset from everything above it. */}
        <div className="-mx-2">{body}</div>

        {/* Says WHICH OF THE TWO to reach for. Both survive — a pasted Drive
            link rots, and the Gate 3 approval page cannot render one the client
            has no permission to open — so the guidance is the whole point. */}
        <p className="text-2xs text-muted-foreground">
          Attach the work itself where you can — the client can open an attachment at approval, but
          not a Drive link they have no access to. Paste a link for anything that will not upload.
        </p>

        {/* AN EXPLICIT SAVE, in a dialog. See the note on `linkOpen`. */}
        <Dialog open={linkOpen} onOpenChange={setLinkOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>{outputLink ? "Replace the link" : "Paste a link"}</DialogTitle>
              <DialogDescription>
                {outputLink
                  ? "A task holds one link. Saving this replaces the one already on it."
                  : "For work that will not upload — a Drive folder, a live page, a design file."}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="output_link">Link</Label>
                <Input
                  id="output_link"
                  type="url"
                  autoFocus
                  placeholder="https://drive.google.com/…"
                  value={linkDraft}
                  disabled={pending}
                  aria-invalid={linkError !== null}
                  aria-describedby={linkError ? "output_link_error" : undefined}
                  onChange={(event) => {
                    setLinkDraft(event.target.value);
                    // Silence, not an error, while it is still being typed.
                    setLinkError(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      saveLink(linkDraft);
                    }
                  }}
                />
                {linkError ? (
                  <p id="output_link_error" role="alert" className="text-xs text-destructive">
                    {linkError}
                  </p>
                ) : null}
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" disabled={pending} onClick={() => setLinkOpen(false)}>
                  Cancel
                </Button>
                {/* `disabled` is never the only explanation (§4.2) — an empty
                    box is its own. */}
                <Button
                  loading={pending}
                  disabled={linkDraft.trim() === outputLink.trim()}
                  title={
                    linkDraft.trim() === outputLink.trim()
                      ? "Nothing has been changed yet."
                      : undefined
                  }
                  onClick={() => saveLink(linkDraft)}>
                  Save
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Output files</CardTitle>
        <CardDescription className="text-xs">
          What you produced. The QA reviewer opens these, and the client sees them at approval.
        </CardDescription>

        {upload ? <CardAction>{upload}</CardAction> : null}
      </CardHeader>

      <CardContent>{body}</CardContent>
    </Card>
  );
}
