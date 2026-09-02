import { describe, expect, it } from "vitest";

import { weekDates } from "@/lib/dates";
import { DEFAULT_BREAK_MINUTES, scheduledDayMinutes } from "@/lib/dtr-schedule";
import { expandLeaveDays, leaveKey, type DayHalf, type LeaveSpan } from "@/lib/leave";
import { scheduledWeekMinutes } from "@/lib/schemas/timesheet";

/**
 * P8-05 — the two pure functions behind "this week is short of your schedule".
 *
 * ⚠️ WHAT IS BEING PINNED HERE IS AN EXEMPTION, not a threshold. The threshold
 * is arithmetic and would be obvious if it were wrong; the exemptions are the
 * cases where refusing to answer is the correct answer, and every one of them
 * fails SILENTLY in the same direction — by inventing a shortfall against a fact
 * nobody ever recorded, and refusing a week somebody had every right to submit.
 *
 * These mirror the three short-circuits in `vizserve_pms_submit_timesheet_week`.
 * The database is the authority; if these ever disagree with it, the screen is
 * what is wrong. There is no test here that can prove they agree — that would
 * need the database, and tests/db does not run against the live project — so
 * the comments name the SQL each case corresponds to instead.
 */

describe("scheduledDayMinutes", () => {
  it("subtracts the break from the span, because the span is not the day", () => {
    // The trap P7-36's column comment warned about: 08:00-17:00 is a NINE-hour
    // span describing an EIGHT-hour day. A caller doing `work_end - work_start`
    // would demand an extra hour a day of everybody in the company.
    expect(scheduledDayMinutes({ work_start: "08:00:00", work_end: "17:00:00" }, 60)).toBe(480);
  });

  it("takes the seconds Postgres returns without choking on them", () => {
    // `time` comes back as `HH:MM:SS`; every other reader in this app goes
    // through `scheduleFor` for exactly this reason and so does this one.
    expect(scheduledDayMinutes({ work_start: "09:00:00", work_end: "18:30:00" }, 30)).toBe(540);
  });

  it("defaults to the company break when none is given", () => {
    expect(scheduledDayMinutes({ work_start: "09:00", work_end: "18:00" })).toBe(
      540 - DEFAULT_BREAK_MINUTES,
    );
  });

  // EXEMPTION 1 — `u.work_start is not null and u.work_end is not null` in the
  // WHERE clause of the SQL. Nobody set these hours, so there is nothing to
  // judge anybody against.
  it("is exempt when no schedule is recorded", () => {
    expect(scheduledDayMinutes({ work_start: null, work_end: null })).toBeNull();
  });

  it("is exempt when only half a schedule is recorded", () => {
    // The CHECK constraint refuses this pair, but a hand-edited row or a stale
    // cache could still produce it, and half a schedule is not a schedule.
    expect(scheduledDayMinutes({ work_start: "09:00", work_end: null })).toBeNull();
    expect(scheduledDayMinutes({ work_start: null, work_end: "18:00" })).toBeNull();
  });

  // EXEMPTION 2 — `if v_day_minutes is not null and v_day_minutes > 0` in the
  // SQL. A break longer than the day it sits inside is a data-entry mistake in
  // /admin/settings or /admin/users, and a mistake there must never be the
  // reason somebody cannot hand in their week.
  it("is exempt when the break is longer than the span", () => {
    expect(scheduledDayMinutes({ work_start: "09:00", work_end: "12:00" }, 240)).toBeNull();
  });

  it("is exempt when the break exactly swallows the span", () => {
    // Zero is not "nothing owed", it is a broken record. Same branch.
    expect(scheduledDayMinutes({ work_start: "09:00", work_end: "10:00" }, 60)).toBeNull();
  });

  it("keeps a deliberate zero break distinct from an unset one", () => {
    // ⚠️ THE WHOLE REASON `vizserve_pms_users.break_minutes` IS NULLABLE. An
    // explicit 0 is somebody who takes no unpaid break and whose day is
    // therefore worth the full span; the same field left blank inherits the
    // company hour. Collapsing them costs an hour a day in one direction and
    // gains one in the other, and nothing on screen would say which happened.
    //
    // Resolution is the CALLER's job — `u.break_minutes ?? settings.breakMinutes`
    // — so what this pins is that 0 is honoured rather than treated as absent.
    const company = 60;
    const takesNoBreak: number | null = 0;
    const neverAsked: number | null = null;

    // `??` — the coalesce the SQL performs and the one the page performs.
    expect(
      scheduledDayMinutes({ work_start: "09:00", work_end: "18:00" }, takesNoBreak ?? company),
    ).toBe(540);
    expect(
      scheduledDayMinutes({ work_start: "09:00", work_end: "18:00" }, neverAsked ?? company),
    ).toBe(480);

    // The bug this guards against, written out: `||` turns a real 0 into the
    // company hour, and the two people above would then be treated identically.
    expect(
      scheduledDayMinutes({ work_start: "09:00", work_end: "18:00" }, takesNoBreak || company),
    ).toBe(480);
  });
});

describe("scheduledWeekMinutes", () => {
  const EIGHT_HOUR_DAY = 480;

  it("is five days of the scheduled day in an ordinary week", () => {
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 5, leaveDays: 0 }),
    ).toEqual({ expectedDays: 5, minimumMinutes: 2400 });
  });

  it("expects nothing of the days a holiday took away", () => {
    // A proclaimed holiday is not a day anybody was due in, and demanding hours
    // for it would refuse a perfectly complete week. `vizserve_pms_is_working_day`
    // makes the same subtraction on the server, reading the same holiday table.
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 4, leaveDays: 0 }),
    ).toEqual({ expectedDays: 4, minimumMinutes: 1920 });
  });

  it("expects nothing of the days approved leave took away", () => {
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 5, leaveDays: 2 }),
    ).toEqual({ expectedDays: 3, minimumMinutes: 1440 });
  });

  it("counts half a day of leave as half a day of expectation", () => {
    // P7-16 leave can start or end at midday. Rounding the day count up would
    // demand a full extra day of somebody who was genuinely away for half of it.
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 5, leaveDays: 1.5 }),
    ).toEqual({ expectedDays: 3.5, minimumMinutes: 1680 });
  });

  it("rounds once, at the end", () => {
    // 4.5 days of a 450-minute day is 2025 minutes. Rounding the day or the
    // count first moves that, and the SQL rounds in the same place.
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: 450, workingDays: 5, leaveDays: 0.5 }),
    ).toEqual({ expectedDays: 4.5, minimumMinutes: 2025 });
  });

  it("stacks holidays and leave in the same week", () => {
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 4, leaveDays: 1 }),
    ).toEqual({ expectedDays: 3, minimumMinutes: 1440 });
  });

  // EXEMPTION 1, carried through: no schedule means no answer, whatever the
  // week looked like.
  it("is exempt when there is no scheduled day", () => {
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: null, workingDays: 5, leaveDays: 0 }),
    ).toBeNull();
  });

  // EXEMPTION 2, carried through.
  it("is exempt when the scheduled day is not positive", () => {
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: 0, workingDays: 5, leaveDays: 0 }),
    ).toBeNull();
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: -60, workingDays: 5, leaveDays: 0 }),
    ).toBeNull();
  });

  // EXEMPTION 3 — `if v_expected > 0` in the SQL. A week entirely holiday, or
  // entirely approved leave, owes nothing, and `0 * anything` is not a
  // threshold worth applying to anybody.
  it("is exempt when the week was entirely holiday", () => {
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 0, leaveDays: 0 }),
    ).toBeNull();
  });

  it("is exempt when leave covered every working day", () => {
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 5, leaveDays: 5 }),
    ).toBeNull();
  });

  it("is exempt rather than negative when leave exceeds the working days", () => {
    // Only reachable from bad data, and the honest response is silence — a
    // negative expectation is not a number anybody should be shown.
    expect(
      scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 3, leaveDays: 5 }),
    ).toBeNull();
  });

  it("treats leave as optional, defaulting to none", () => {
    expect(scheduledWeekMinutes({ scheduledDayMinutes: EIGHT_HOUR_DAY, workingDays: 5 })).toEqual({
      expectedDays: 5,
      minimumMinutes: 2400,
    });
  });
});

describe("the two together, as the timesheet page composes them", () => {
  it("puts a 09:00-18:00 person on a 40-hour week and an eight-hour day", () => {
    const day = scheduledDayMinutes({ work_start: "09:00:00", work_end: "18:00:00" }, 60);
    expect(day).toBe(480);
    expect(scheduledWeekMinutes({ scheduledDayMinutes: day, workingDays: 5 })).toEqual({
      expectedDays: 5,
      minimumMinutes: 2400,
    });
  });

  it("says nothing at all about somebody with no fixed hours", () => {
    // Most of this company. The feature must not exist for them — see P7-36.
    const day = scheduledDayMinutes({ work_start: null, work_end: null }, 60);
    expect(scheduledWeekMinutes({ scheduledDayMinutes: day, workingDays: 5 })).toBeNull();
  });

  it("lowers the week for a person who takes no break, and raises what they owe", () => {
    // An explicit 0 makes the day worth the whole span, so the week they have
    // to reach is HIGHER, not lower. Worth pinning because the intuition runs
    // the other way: "no break" sounds like a concession.
    const noBreak = scheduledDayMinutes({ work_start: "09:00", work_end: "18:00" }, 0);
    const companyBreak = scheduledDayMinutes({ work_start: "09:00", work_end: "18:00" }, 60);

    const withoutBreak = scheduledWeekMinutes({ scheduledDayMinutes: noBreak, workingDays: 5 });
    const withBreak = scheduledWeekMinutes({ scheduledDayMinutes: companyBreak, workingDays: 5 });

    expect(withoutBreak?.minimumMinutes).toBe(2700);
    expect(withBreak?.minimumMinutes).toBe(2400);
  });
});

/**
 * P8-05, second round — the leave count the shortfall check is built on.
 *
 * ⚠️ WHAT IS BEING PINNED IS THAT LEAVE IS COUNTED PER DAY, NOT PER REQUEST.
 *
 * `vizserve_pms_submit_timesheet_week` used to sum `vizserve_pms_leave_days`
 * over the matching requests, so two approved LEAVE rows both covering the same
 * Wednesday subtracted TWO days there while this arithmetic subtracted one. The
 * screen then demanded 1440 minutes on a week the database was happy to accept
 * at 960 — a false "you are short", which is the one direction an advance
 * warning must never be wrong in. The SQL now walks the week's own dates the
 * way the loop below does; these cases are the shape both sides must agree on.
 *
 * This mirrors the accumulation in `app/(app)/timesheet/page.tsx` rather than
 * importing it — that loop lives inside an async server component and cannot be
 * called from here. Keep the two in step: if the page's loop changes, this
 * helper is the second place to change.
 */
describe("approved leave, expanded into days before it is counted", () => {
  const USER = "11111111-1111-4111-8111-111111111111";

  // Monday 31 Aug 2026. Mon 08-31, Tue 09-01, Wed 09-02, Thu 09-03, Fri 09-04.
  const MONDAY = "2026-08-31";

  function span(
    start: string,
    end: string,
    startHalf: DayHalf | null = null,
    endHalf: DayHalf | null = null,
  ): LeaveSpan {
    return {
      user_id: USER,
      start_date: start,
      end_date: end,
      start_half: startHalf,
      end_half: endHalf,
      type_name: null,
    };
  }

  /** The page's own loop: weekdays only, halves worth half, holidays skipped. */
  function leaveDaysInWeek(spans: LeaveSpan[], holidays: string[] = []): number {
    const days = weekDates(MONDAY);
    const byDay = expandLeaveDays(spans, days[0]!, days[6]!);

    let leaveDays = 0;

    // `slice(0, 5)` IS the weekend test, exactly as the page argues it.
    for (const day of days.slice(0, 5)) {
      if (holidays.includes(day)) continue;

      const leave = byDay.get(leaveKey(USER, day));
      if (leave) leaveDays += leave.portion === "full" ? 1 : 0.5;
    }

    return leaveDays;
  }

  it("counts a day covered by two requests once, not twice", () => {
    // THE BUG THIS ROUND FIXED, in one line. Two approved requests, both
    // covering Wednesday. The person is absent on a day, not absent twice.
    const doubled = leaveDaysInWeek([span("2026-09-02", "2026-09-02"), span("2026-09-01", "2026-09-03")]);

    expect(doubled).toBe(3);

    // And the minimum that comes out of it — 960, not the 480 a per-request sum
    // would have produced by subtracting Wednesday a second time.
    expect(scheduledWeekMinutes({ scheduledDayMinutes: 480, workingDays: 5, leaveDays: doubled })).toEqual(
      { expectedDays: 2, minimumMinutes: 960 },
    );
  });

  it("takes a half only on the request's OWN end", () => {
    // Monday to Wednesday, back at midday on the Wednesday. Monday and Tuesday
    // are whole; only the end date carries the marker.
    expect(leaveDaysInWeek([span("2026-08-31", "2026-09-02", null, "MORNING")])).toBe(2.5);
  });

  it("treats a date inside a span as whole, whatever the halves say", () => {
    // Away from Monday midday until Friday midday: the three days in between
    // are whole days off, and reading the markers on them would refund half a
    // day of expectation the person never worked.
    expect(leaveDaysInWeek([span("2026-08-31", "2026-09-04", "AFTERNOON", "MORNING")])).toBe(4);
  });

  it("keeps whole days whole when the span runs out of the week", () => {
    // Thursday to next Tuesday. The clip lands on a date that is not the
    // request's end, so nothing carries a half across it — the same reasoning
    // that let the SQL drop its greatest/least dance entirely.
    expect(leaveDaysInWeek([span("2026-09-03", "2026-09-08", null, "MORNING")])).toBe(2);
  });

  it("makes two complementary halves from two requests a whole day", () => {
    // One request ends Wednesday morning, another starts Wednesday afternoon.
    // Away all morning and all afternoon is away, so Wednesday is 1 — this is
    // `merge()` in lib/leave.ts, and the SQL's outer CASE mirrors it.
    expect(
      leaveDaysInWeek([
        span("2026-08-31", "2026-09-02", null, "MORNING"),
        span("2026-09-02", "2026-09-04", "AFTERNOON", null),
      ]),
    ).toBe(5);
  });

  it("still counts one half when both requests cover the same half", () => {
    expect(
      leaveDaysInWeek([
        span("2026-09-02", "2026-09-02", "AFTERNOON", null),
        span("2026-09-02", "2026-09-03", "AFTERNOON", null),
      ]),
    ).toBe(1.5);
  });

  it("never deducts leave from a day the week did not count", () => {
    // A holiday the person also booked leave over. The day was already removed
    // from what was expected of them, and removing it twice would take the
    // minimum BELOW the schedule — the mirror of the double-count bug.
    const days = leaveDaysInWeek([span("2026-09-02", "2026-09-02")], ["2026-09-02"]);

    expect(days).toBe(0);
    expect(scheduledWeekMinutes({ scheduledDayMinutes: 480, workingDays: 4, leaveDays: days })).toEqual({
      expectedDays: 4,
      minimumMinutes: 1920,
    });
  });

  it("ignores leave that falls on the weekend", () => {
    // Saturday and Sunday, which were never expected days.
    expect(leaveDaysInWeek([span("2026-09-05", "2026-09-06")])).toBe(0);
  });
});
