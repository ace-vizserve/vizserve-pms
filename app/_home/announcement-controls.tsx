"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Megaphone, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { ANNOUNCEMENT_BODY_MAX, ANNOUNCEMENT_TITLE_MAX } from "@/lib/schemas/announcements";

import { postAnnouncement, takeDownAnnouncement } from "./announcement-actions";

/** P17-04 — the "Post" button in the announcements cell, and its dialog. */
export function PostAnnouncementButton({ today }: { today: string }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Megaphone />
        Post
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-lg">
          {/* Unmounted while closed so the form is seeded fresh each time. */}
          {open ? <AnnouncementForm today={today} onDone={() => setOpen(false)} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function AnnouncementForm({ today, onDone }: { today: string; onDone: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [expiresOn, setExpiresOn] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  function submit() {
    setFormError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await postAnnouncement({ title, body, expires_on: expiresOn });
      if (!result.ok) {
        setFormError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      router.refresh();
      toast.success("Announcement posted");
      onDone();
    });
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Post an announcement</DialogTitle>
        <DialogDescription>
          Everyone sees it on the home page when they sign in.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-2">
          <Label htmlFor="announcement_title">Title</Label>
          <Input
            id="announcement_title"
            value={title}
            maxLength={ANNOUNCEMENT_TITLE_MAX}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Office closed Friday afternoon"
            aria-invalid={Boolean(fieldErrors.title)}
          />
          <FieldError messages={fieldErrors.title} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="announcement_body">Message</Label>
          <Textarea
            id="announcement_body"
            value={body}
            maxLength={ANNOUNCEMENT_BODY_MAX}
            rows={5}
            onChange={(e) => setBody(e.target.value)}
            aria-invalid={Boolean(fieldErrors.body)}
          />
          <FieldError messages={fieldErrors.body} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="announcement_expires">Show until (optional)</Label>
          <DatePicker
            id="announcement_expires"
            value={expiresOn}
            onChange={setExpiresOn}
            min={today}
            placeholder="Until taken down"
            invalid={Boolean(fieldErrors.expires_on)}
          />
          <p className="text-xs text-muted-foreground">
            The last day it shows. Leave empty to keep it up until somebody takes it down.
          </p>
          <FieldError messages={fieldErrors.expires_on} />
        </div>

        {formError ? (
          <p role="alert" className="text-sm text-destructive">
            {formError}
          </p>
        ) : null}
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone} disabled={pending}>
          Cancel
        </Button>
        <Button loading={pending} onClick={submit}>
          Post
        </Button>
      </DialogFooter>
    </>
  );
}

/** Take one down — its author, or a Manager and above. Archived, never deleted. */
export function TakeDownAnnouncementButton({ id, title }: { id: string; title: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function confirm() {
    startTransition(async () => {
      const result = await takeDownAnnouncement({ id });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
      toast.success("Announcement taken down");
      setOpen(false);
    });
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Take down “${title}”`}
        onClick={() => setOpen(true)}
      >
        <X />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Take this announcement down?</DialogTitle>
            <DialogDescription>{title}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            It disappears from everyone&rsquo;s home page. It stays in the audit trail.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" loading={pending} onClick={confirm}>
              Take down
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
