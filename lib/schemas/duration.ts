/**
 * SLA durations, as typed — `5d`, `8h`, `2d 4h`.
 *
 * SEPARATE FROM `parseCellDuration` ON PURPOSE. The two grammars disagree, and
 * the disagreement is deliberate rather than an oversight to be tidied away:
 *
 *   |            | parseCellDuration (timesheet) | parseSlaDuration (here) |
 *   | bare `5`   | 5 HOURS                       | 5 DAYS                  |
 *   | units      | h m s                         | d h m                   |
 *   | `1d`       | not accepted                  | 480 minutes             |
 *
 * A timesheet cell holds part of one working day, so a bare number there is
 * hours. An SLA is a turnaround standard measured in days — the field was
 * literally labelled "SLA (days)" before this file existed, and the people
 * typing into it type `5` meaning five days. Reading that as five hours would
 * silently cut every existing SLA to an eighth.
 *
 * `unit-divergence` in tests/unit/duration.test.ts pins both readings so this
 * cannot be "fixed" into agreement by someone who finds it surprising.
 */

/**
 * A WORKING day, not a calendar one.
 *
 * 480 minutes is already the working day this schema assumes: D24 caps overtime
 * at 960 because that is exactly `1440 - 480`. An SLA of `5d` is five working
 * days — which is what "five days" has always meant on this field — so it is
 * 2400 minutes and not 7200.
 */
export const SLA_MINUTES_PER_DAY = 480;

/** One minute. A zero SLA is not a fast promise, it is an empty field. */
export const MIN_SLA_MINUTES = 1;
/** 365 working days. The old column capped at 365 days; the ceiling carries over. */
export const MAX_SLA_MINUTES = 365 * SLA_MINUTES_PER_DAY;

/**
 * NO COLON FORM, for the same reason the timesheet refuses it: `2:30` looks
 * like a clock and half the team will read it as half past two.
 */
const SLA_COLON_LIKE = /\d\s*:\s*\d/;

/** `5`, `2.5` — a number on its own. DAYS, per the hint on screen. */
const SLA_BARE = /^\d+(?:\.\d+)?$/;

/**
 * An SLA as typed, into minutes.
 *
 * Returns null for anything that does not mean a duration — including the empty
 * string. An SLA has no "clear this" state the way a timesheet cell does; the
 * column is `not null`, so blank is a validation error and the caller says so.
 */
export function parseSlaDuration(raw: string): number | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;

  if (SLA_COLON_LIKE.test(value)) return null;

  // Accumulated in minutes throughout — unlike the timesheet there is no
  // seconds unit to round against, and the smallest unit here IS the minute.
  let minutes: number;

  if (SLA_BARE.test(value)) {
    minutes = Number(value) * SLA_MINUTES_PER_DAY;
  } else {
    const scanned = scanSlaUnits(value);
    if (scanned === null) return null;
    minutes = scanned;
  }

  minutes = Math.round(minutes);

  if (!Number.isFinite(minutes)) return null;
  if (minutes < MIN_SLA_MINUTES || minutes > MAX_SLA_MINUTES) return null;
  return minutes;
}

/**
 * `2d 4h`, and every sensible spelling of it.
 *
 * Sticky, so the scan consumes the whole input or fails — a trailing `banana`
 * cannot be skipped over.
 *
 * EVERY number here needs a unit, which is the one place this is STRICTER than
 * the timesheet scanner. There, a unit-less number means minutes, so `1h30` is
 * ninety. Here `2d 4` has no honest reading: hours and minutes are both
 * plausible and the difference is sixty-fold. A bare number on its own never
 * reaches this function — `SLA_BARE` claims it above and reads it as days.
 *
 * Returns minutes, or null.
 */
function scanSlaUnits(value: string): number | null {
  // Longest spelling first in each group, or `days?` would never win over `d`.
  const token = /\s*(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)\s*/y;

  let minutes = 0;
  let found = false;

  while (token.lastIndex < value.length) {
    const at = token.lastIndex;
    const match = token.exec(value);

    if (!match || token.lastIndex === at) return null;

    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return null;

    const unit = match[2];
    minutes +=
      unit.startsWith("d")
        ? amount * SLA_MINUTES_PER_DAY
        : unit.startsWith("h")
          ? amount * 60
          : amount;

    found = true;
  }

  return found ? minutes : null;
}

/**
 * Minutes as the SLA field reads them back — `2d 4h`.
 *
 * Round-trips through `parseSlaDuration`: what the field renders after a save
 * is exactly what could be typed into it. Largest unit first, empty units
 * dropped, so 2400 is `5d` rather than `5d 0h 0m`.
 */
export function formatSlaDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0m";

  const days = Math.floor(minutes / SLA_MINUTES_PER_DAY);
  const rest = minutes % SLA_MINUTES_PER_DAY;
  const hours = Math.floor(rest / 60);
  const mins = rest % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);

  return parts.join(" ");
}
