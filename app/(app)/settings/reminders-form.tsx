"use client";

import { useRef, useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff, Play, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/lib/attachments";
import {
  ALLOWED_SOUND_MIME_TYPES,
  MAX_REMINDER_LEAD_MINUTES,
  MAX_SOUND_BYTES,
  MIN_REMINDER_LEAD_MINUTES,
  type SoundKey,
} from "@/lib/preferences";
import { playReminderSound, reminderSoundSrc } from "@/lib/sound";

import { removeReminderSound, saveReminderPreferences, uploadReminderSound } from "./actions";

/**
 * P8-12 — the reminder settings.
 *
 * Three groups, in the order somebody thinks about them: WHEN it fires, WHAT it
 * sounds like, and HOW it reaches them.
 *
 * ⚠️ THE SOUND IS NOT PART OF THE FORM'S SAVE. Uploading a sound is choosing
 * it, and removing it is going back to the shipped chime — both are their own
 * server action, because the storage object and the row have to move together
 * (see `lib/schemas/preferences.ts`). The Save button covers the toggles, the
 * lead time and the volume, which is everything that is genuinely just a value.
 */

/*
 * A one-value external store over `Notification.permission`.
 *
 * The browser gives no event for a permission change, so the store is nudged by
 * hand from the one place that can cause one — `Notification.requestPermission`
 * resolving. Anything else that changes it (the address-bar site settings) is
 * outside this page and lands on the next load, which is the same behaviour the
 * effect-based version had.
 */
const permissionListeners = new Set<() => void>();

function subscribePermission(listener: () => void) {
  permissionListeners.add(listener);
  return () => {
    permissionListeners.delete(listener);
  };
}

function readPermission(): NotificationPermission | null {
  // `null` doubles as "this browser has no Notification API", which reads the
  // same way on screen as "not granted" and needs no separate branch.
  return "Notification" in window ? Notification.permission : null;
}

function notifyPermissionChanged() {
  for (const listener of permissionListeners) listener();
}

export type RemindersFormProps = {
  clockInReminder: boolean;
  clockOutReminder: boolean;
  leadMinutes: number;
  soundKey: SoundKey;
  soundVolume: number;
  /** A signed URL when they have uploaded one. Null for the shipped default. */
  soundUrl: string | null;
  /** Their work hours, or null. Decides whether any of this can ever fire. */
  workStart: string | null;
  workEnd: string | null;
};

export function RemindersForm(props: RemindersFormProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, startUpload] = useTransition();

  const [clockIn, setClockIn] = useState(props.clockInReminder);
  const [clockOut, setClockOut] = useState(props.clockOutReminder);
  const [lead, setLead] = useState(String(props.leadMinutes));
  const [volume, setVolume] = useState(props.soundVolume);
  const [errors, setErrors] = useState<Record<string, string[]>>({});

  const fileInput = useRef<HTMLInputElement>(null);

  /*
   * ⚠️ `Notification.permission` IS A BROWSER FACT THE SERVER CANNOT SEE, so it
   * has to arrive after hydration — rendering the button's label straight from
   * it on the first pass is a hydration mismatch, because the server has no
   * `Notification` object at all.
   *
   * `useSyncExternalStore` rather than an effect that calls `setState`, which
   * is the obvious version and the one React Compiler rejects: a synchronous
   * setState in a mount effect is a second render for a value that was
   * available all along. This gives the server `null`, the browser the real
   * permission, and one re-render when `notifyPermissionChanged` fires after
   * the prompt is answered.
   */
  const permission = useSyncExternalStore(
    subscribePermission,
    readPermission,
    () => null as NotificationPermission | null,
  );

  const hasSchedule = Boolean(props.workStart && props.workEnd);

  function save() {
    startTransition(async () => {
      setErrors({});

      // Number("") is 0, which the schema would reject with the right sentence
      // — but NaN gets there with the same result and without pretending an
      // empty field meant zero.
      const parsedLead = lead.trim() === "" ? Number.NaN : Number(lead);

      const result = await saveReminderPreferences({
        clock_in_reminder: clockIn,
        clock_out_reminder: clockOut,
        reminder_lead_minutes: parsedLead,
        sound_volume: volume,
      });

      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.error(result.error);
        return;
      }

      toast.success("Saved.");
      router.refresh();
    });
  }

  function preview() {
    /*
     * THE PREVIEW BUTTON DOES TWO JOBS, and the second is the one worth
     * knowing about. It plays the sound, obviously — and because it is a real
     * user gesture, it is also what satisfies the browser's autoplay policy for
     * this document, so a reminder firing later in the same tab is allowed to
     * make a noise. That is why the hint below tells people to press it.
     */
    void playReminderSound(reminderSoundSrc(props.soundUrl), volume);
  }

  function requestPermission() {
    if (!("Notification" in window)) {
      toast.error("This browser does not support notifications.");
      return;
    }

    // ⚠️ ONLY EVER FROM A CLICK. Browsers permanently block a prompt that was
    // raised without a gesture, so this must never move into an effect or a
    // timer — which is exactly why the shell's reminder never asks and this
    // button exists.
    void Notification.requestPermission().then((next) => {
      notifyPermissionChanged();
      if (next === "granted") toast.success("Notifications enabled for this browser.");
      else if (next === "denied") {
        toast.error("This browser is blocking notifications. Reminders will still show in the app.");
      }
    });
  }

  function upload(file: File) {
    startUpload(async () => {
      const formData = new FormData();
      formData.append("file", file);

      const result = await uploadReminderSound(formData);

      // Cleared either way. Without this, picking the SAME file after a failed
      // upload fires no change event and the button looks dead.
      if (fileInput.current) fileInput.current.value = "";

      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      toast.success(`"${result.data.filename}" is now your reminder sound.`);
      router.refresh();
    });
  }

  function removeSound() {
    startUpload(async () => {
      const result = await removeReminderSound();
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Back to the VizServe chime.");
      router.refresh();
    });
  }

  const leadErrors = errors.reminder_lead_minutes ?? [];

  return (
    <div className="space-y-5">
      {/* --------------------------------------------------------------
          The precondition, stated first and only when it is unmet.

          Every control below is inert for somebody with no work hours —
          `dueReminder` returns null the moment `workStart` is null — and a
          screen full of live-looking switches that can never fire is worse
          than no screen. Their schedule is set by an admin on /admin/users,
          so this says who to ask rather than offering a control they do not
          have.
          -------------------------------------------------------------- */}
      {!hasSchedule ? (
        <p
          role="status"
          className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-xs text-foreground"
        >
          You have no work hours recorded, so no reminder can fire whatever is set below. Ask an
          admin to add your scheduled start and finish on the staff record.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Your scheduled day is {props.workStart}–{props.workEnd}. Reminders fire ahead of those
          times, in the browser, while the app is open in a tab.
        </p>
      )}

      {/* ---------------------------------------------------------------- When */}
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="clock_in_reminder">Before I clock in</Label>
            <p className="text-xs text-muted-foreground">
              Only on a day you have not timed in yet.
            </p>
          </div>
          <Switch id="clock_in_reminder" checked={clockIn} onCheckedChange={setClockIn} />
        </div>

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="clock_out_reminder">Before I clock out</Label>
            <p className="text-xs text-muted-foreground">
              Only while a shift is open. Approved overtime moves it later.
            </p>
          </div>
          <Switch id="clock_out_reminder" checked={clockOut} onCheckedChange={setClockOut} />
        </div>

        <div className="space-y-2">
          <Label htmlFor="reminder_lead_minutes">How far ahead</Label>
          <div className="flex items-center gap-2">
            <Input
              id="reminder_lead_minutes"
              name="reminder_lead_minutes"
              type="number"
              inputMode="numeric"
              min={MIN_REMINDER_LEAD_MINUTES}
              max={MAX_REMINDER_LEAD_MINUTES}
              step={1}
              className="w-24 tabular-nums"
              value={lead}
              onChange={(event) => setLead(event.target.value)}
              aria-invalid={leadErrors.length > 0}
            />
            <span className="text-sm text-muted-foreground">minutes before</span>
          </div>
          {leadErrors.map((message) => (
            <p key={message} className="text-xs text-destructive">
              {message}
            </p>
          ))}
        </div>
      </div>

      {/* --------------------------------------------------------------- Sound */}
      <div className="space-y-3 border-t pt-4">
        <div className="space-y-0.5">
          <Label>Sound</Label>
          <p className="text-xs text-muted-foreground">
            {props.soundKey === "custom"
              ? "Playing your own sound."
              : "Playing the VizServe chime that ships with the app."}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={preview}>
            <Play />
            Preview
          </Button>

          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={uploading}
            onClick={() => fileInput.current?.click()}
          >
            <Upload />
            {props.soundKey === "custom" ? "Replace" : "Upload your own"}
          </Button>

          {props.soundKey === "custom" ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={uploading}
              onClick={removeSound}
            >
              <Trash2 />
              Use the chime
            </Button>
          ) : null}

          <input
            ref={fileInput}
            type="file"
            className="sr-only"
            accept={ALLOWED_SOUND_MIME_TYPES.join(",")}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) upload(file);
            }}
          />
        </div>

        <p className="text-xs text-muted-foreground">
          MP3, WAV, OGG, M4A or WebM, up to {formatBytes(MAX_SOUND_BYTES)}. A few seconds is
          plenty. Press Preview at least once per tab — browsers refuse to play audio on a page
          nobody has clicked, and that press is what lets a later reminder be heard.
        </p>

        <div className="space-y-2">
          <Label htmlFor="sound_volume">
            Volume <span className="tabular-nums text-muted-foreground">{volume}%</span>
          </Label>
          <Slider
            id="sound_volume"
            className="max-w-xs"
            min={0}
            max={100}
            step={5}
            value={volume}
            onValueChange={(next) => setVolume(Array.isArray(next) ? (next[0] ?? 0) : next)}
          />
        </div>
      </div>

      {/* ---------------------------------------------------------------- Reach */}
      <div className="space-y-2 border-t pt-4">
        <Label>Browser notifications</Label>

        {permission === "granted" ? (
          <p className="flex items-center gap-1.5 text-xs text-success">
            <Bell className="size-3.5" />
            Enabled. Reminders appear even when this tab is in the background.
          </p>
        ) : permission === "denied" ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BellOff className="size-3.5" />
            Blocked by this browser. Reminders still appear inside the app — to change it, use the
            site permissions in the address bar.
          </p>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Off. Reminders appear inside the app only, so you have to have it on screen to see
              one.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={requestPermission}>
              <Bell />
              Enable browser notifications
            </Button>
          </div>
        )}
      </div>

      <div className="border-t pt-4">
        <Button type="button" loading={pending} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
