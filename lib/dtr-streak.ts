import { addDays, isBusinessDay } from "@/lib/dates";

/** How far back the streak looks. A streak longer than this reads as the cap. */
export const STREAK_WINDOW_DAYS = 120;

/**
 * Consecutive working days with a time-in, counting back from `today`.
 *
 * - TODAY NOT PUNCHED YET DOES NOT BREAK IT. At 08:00 the day is still open, so
 *   the count starts from yesterday until today's time-in lands. A whole day
 *   with no time-in breaks it once the day is over.
 * - Weekends and seeded holidays neither count nor break it. Punching on one of
 *   them DOES count — the DTR records a Saturday shift.
 * - Any other day without a time-in ends it — LEAVE INCLUDED. Approved leave is
 *   a day you did not time in, and the streak is about timing in.
 *
 * `isBusinessDay` only knows the seeded holiday list, so a holiday an admin
 * added breaks the streak. This is a nudge on the home page, not a record.
 */
export function computeDtrStreak({
  today,
  punchedDates,
}: {
  today: string;
  punchedDates: ReadonlySet<string>;
}): number {
  let streak = 0;

  for (let back = 0; back < STREAK_WINDOW_DAYS; back++) {
    const day = addDays(today, -back);
    if (!day) break;

    if (punchedDates.has(day)) {
      streak++;
      continue;
    }
    if (back === 0) continue;
    if (!isBusinessDay(day)) continue;
    break;
  }

  return streak;
}
