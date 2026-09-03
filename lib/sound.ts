/**
 * P8-12 — playing a reminder sound in the browser.
 *
 * Four lines of real work wrapped in the two things that make it safe to call
 * from a timer nobody is watching.
 *
 * ⚠️ AUTOPLAY IS REFUSED IN A TAB NOBODY HAS TOUCHED, and that refusal arrives
 * as a REJECTED PROMISE rather than an exception. Every browser gates audio
 * behind a user gesture in the document; a page somebody loaded and walked away
 * from — which is exactly the page a shift reminder fires on — may never have
 * had one. An unhandled rejection there would surface as an error in a console
 * nobody has open, and in a `useEffect` it is noise attached to a feature that
 * is working as designed.
 *
 * So a blocked sound is SWALLOWED, on purpose, and the caller is told nothing.
 * The sound was never the whole reminder: the toast always renders and the OS
 * notification fires when permission was granted, so silence degrades the nudge
 * rather than losing it. `/settings` says so in as many words, next to the
 * Preview button that supplies the gesture.
 */

import { DEFAULT_SOUND_SRC } from "@/lib/preferences";

/**
 * Plays a sound once, at a volume given in percent.
 *
 * Returns a promise that resolves either way — it never rejects, and there is
 * no boolean saying whether the sound came out. A caller that branched on that
 * would be building a second, quieter reminder for the blocked case, and the
 * toast already is one.
 */
export async function playReminderSound(src: string, volumePercent: number): Promise<void> {
  if (typeof window === "undefined") return;

  try {
    const audio = new Audio(src);

    // `HTMLMediaElement.volume` is 0–1; the column is percent, because a slider
    // emits integers and a float column invites 0.7000000000000001 into an
    // audit row. Clamped rather than trusted: this value has been through a
    // database, a network and a prop.
    audio.volume = Math.min(1, Math.max(0, volumePercent / 100));

    await audio.play();
  } catch {
    // Blocked autoplay, a missing file, an expired signed URL. See the header:
    // none of them is worth interrupting the reminder that is still on screen.
  }
}

/**
 * The URL to play, given what the person chose.
 *
 * The signed URL when they uploaded their own, the shipped file otherwise — and
 * the shipped file ALSO when a signed URL was expected and is not there. That
 * second case is real: signing can fail, and a reminder that arrives silently
 * because the object storage had a bad minute is worse than one that arrives
 * with the wrong chime.
 */
export function reminderSoundSrc(customUrl: string | null | undefined): string {
  return customUrl || DEFAULT_SOUND_SRC;
}
