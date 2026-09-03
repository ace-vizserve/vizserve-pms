/**
 * P8-12 — the per-user preference defaults, and the only client-safe copy.
 *
 * ⚠️ EVERY DEFAULT HERE MIRRORS A COLUMN DEFAULT in
 * 20260904090000_p8_11_password_and_preferences.sql, restated for the same
 * reason `DEFAULT_GRACE_MINUTES` is restated in `lib/dtr-schedule.ts`: a
 * preferences read that fails — RLS wobble, the migration not pasted yet, the
 * row simply never created — must degrade to a working reminder rather than
 * take out the app shell, which is where this is read.
 *
 * IF THIS FILE AND THE MIGRATION EVER DISAGREE, THE MIGRATION WINS and these
 * are the lines to fix.
 *
 * Deliberately NOT `server-only`. The settings form, the reminder component and
 * the server reader all need these numbers, and a second copy living in a
 * client component is how the screen ends up showing a default the database
 * never had.
 */

/** Minutes before the scheduled time that a reminder fires. */
export const DEFAULT_REMINDER_LEAD_MINUTES = 15;

/** The floor is 1, not 0: a reminder at the scheduled minute is a report. */
export const MIN_REMINDER_LEAD_MINUTES = 1;

/** Two hours. A warning that far ahead of a shift is noise, not a nudge. */
export const MAX_REMINDER_LEAD_MINUTES = 120;

/** Percent. Divided by 100 before it reaches `HTMLMediaElement.volume`. */
export const DEFAULT_SOUND_VOLUME = 70;

/**
 * The two sound sources.
 *
 * `default` is the file shipped with the app; `custom` is an object in the
 * `user-sounds` bucket, reached through a signed URL. There is no `none` — a
 * silent reminder is what the two toggles are for, and adding a third way to
 * turn the same thing off is how two controls end up disagreeing.
 */
export const SOUND_KEYS = ["default", "custom"] as const;
export type SoundKey = (typeof SOUND_KEYS)[number];

/** Served from `public/`. Same origin, no signing, no expiry. */
export const DEFAULT_SOUND_SRC = "/assets/default_ringtone.mp3";

export const SOUND_LABELS: Record<SoundKey, string> = {
  default: "VizServe chime",
  custom: "Your own sound",
};

/** Half a megabyte. Long enough for a ringtone, short enough to load instantly. */
export const MAX_SOUND_BYTES = 512 * 1024;

/**
 * An ALLOWLIST, never a denylist — the same posture
 * `vizserve_pms_attachment_rules` takes, and for the same reason.
 *
 * Kept OUT of that table on purpose. Its rules are read by the PUBLIC client
 * form, so adding audio there to let staff pick a ringtone would also let an
 * anonymous submitter post audio through a client form. Two audiences, two rule
 * sets — which is also why the uploads land in their own bucket.
 */
export const ALLOWED_SOUND_MIME_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/mp4",
  "audio/webm",
] as const;

/** What the resolved preference set looks like everywhere downstream. */
export type UserPreferences = {
  clockInReminder: boolean;
  clockOutReminder: boolean;
  leadMinutes: number;
  soundKey: SoundKey;
  /** The storage object path, not a URL. Null unless `soundKey` is `custom`. */
  customSoundPath: string | null;
  /** 0–100. */
  soundVolume: number;
};

/** What a person with no row gets — and what a failed read degrades to. */
export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  clockInReminder: true,
  clockOutReminder: true,
  leadMinutes: DEFAULT_REMINDER_LEAD_MINUTES,
  soundKey: "default",
  customSoundPath: null,
  soundVolume: DEFAULT_SOUND_VOLUME,
};

export function isSoundKey(value: unknown): value is SoundKey {
  return typeof value === "string" && (SOUND_KEYS as readonly string[]).includes(value);
}
