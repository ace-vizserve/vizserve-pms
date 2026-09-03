import { describe, expect, it } from "vitest";

import {
  changeOwnPasswordSchema,
  forcedPasswordChangeSchema,
  passwordSchema,
} from "@/lib/schemas/auth";
import { userPreferencesSchema } from "@/lib/schemas/preferences";
import {
  DEFAULT_REMINDER_LEAD_MINUTES,
  DEFAULT_USER_PREFERENCES,
  MAX_REMINDER_LEAD_MINUTES,
  MIN_REMINDER_LEAD_MINUTES,
  isSoundKey,
} from "@/lib/preferences";

/**
 * P8-11 / P8-12 — the two contracts behind `/settings`.
 *
 * These are the D3a handoff artefacts: the forms and the server actions import
 * the same objects, so a bound asserted here is the bound both sides apply.
 * The DATABASE is still the enforcement — every rule below mirrors a CHECK
 * constraint or a GoTrue policy — and these exist so somebody sees a sentence
 * under a field instead of a constraint name in a toast.
 */

/** Long enough, mixed case, a digit. The minimum the policy accepts. */
const GOOD = "Correct1Horse";

function issuePaths(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) {
  return (result.error?.issues ?? []).map((issue) => String(issue.path[0] ?? "form"));
}

describe("changeOwnPasswordSchema", () => {
  it("accepts a current password plus a matching, compliant new one", () => {
    const result = changeOwnPasswordSchema.safeParse({
      currentPassword: "whatever-they-had-before",
      password: GOOD,
      confirmPassword: GOOD,
    });

    expect(result.success).toBe(true);
  });

  it("puts the mismatch on the confirm field, not the password field", () => {
    const result = changeOwnPasswordSchema.safeParse({
      currentPassword: "old",
      password: GOOD,
      confirmPassword: `${GOOD}x`,
    });

    expect(result.success).toBe(false);
    // The path decides which input turns red. On the NEW password it would tell
    // somebody their perfectly good password is wrong.
    expect(issuePaths(result)).toContain("confirmPassword");
  });

  it("refuses a new password that is the current one", () => {
    const result = changeOwnPasswordSchema.safeParse({
      currentPassword: GOOD,
      password: GOOD,
      confirmPassword: GOOD,
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("password");
  });

  it("applies the full policy to the new password", () => {
    for (const weak of ["short1A", "alllowercase1", "ALLUPPERCASE1", "NoDigitsInHere"]) {
      const result = changeOwnPasswordSchema.safeParse({
        currentPassword: "old",
        password: weak,
        confirmPassword: weak,
      });

      expect(result.success, weak).toBe(false);
    }
  });

  /**
   * ⚠️ THE CURRENT PASSWORD IS DELIBERATELY NOT POLICED. It already exists,
   * possibly predating the policy, and the only question worth asking about it
   * is whether GoTrue accepts it. Running `passwordSchema` over it would refuse
   * a legitimate person their only route to a compliant password.
   */
  it("does not apply the policy to the current password", () => {
    expect(passwordSchema.safeParse("abc").success).toBe(false);

    const result = changeOwnPasswordSchema.safeParse({
      currentPassword: "abc",
      password: GOOD,
      confirmPassword: GOOD,
    });

    expect(result.success).toBe(true);
  });

  it("requires a current password to be present at all", () => {
    const result = changeOwnPasswordSchema.safeParse({
      currentPassword: "",
      password: GOOD,
      confirmPassword: GOOD,
    });

    expect(result.success).toBe(false);
    expect(issuePaths(result)).toContain("currentPassword");
  });
});

describe("forcedPasswordChangeSchema", () => {
  /**
   * No current password: they are signed in WITH the temporary one, so the
   * session is the proof. The "not the same as the current" check cannot run
   * here for want of anything to compare against — `changeOwnPassword` asks
   * GoTrue instead, by trying to sign in with the NEW password.
   */
  it("accepts a new password with no current one", () => {
    expect(
      forcedPasswordChangeSchema.safeParse({ password: GOOD, confirmPassword: GOOD }).success,
    ).toBe(true);
  });

  it("still enforces the policy and the match", () => {
    expect(
      forcedPasswordChangeSchema.safeParse({ password: "weak", confirmPassword: "weak" }).success,
    ).toBe(false);
    expect(
      forcedPasswordChangeSchema.safeParse({ password: GOOD, confirmPassword: "other" }).success,
    ).toBe(false);
  });
});

describe("userPreferencesSchema", () => {
  const valid = {
    clock_in_reminder: true,
    clock_out_reminder: false,
    reminder_lead_minutes: DEFAULT_REMINDER_LEAD_MINUTES,
    sound_volume: 70,
  };

  it("accepts the defaults", () => {
    expect(userPreferencesSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts both ends of the lead-time range and refuses just outside", () => {
    for (const minutes of [MIN_REMINDER_LEAD_MINUTES, MAX_REMINDER_LEAD_MINUTES]) {
      expect(
        userPreferencesSchema.safeParse({ ...valid, reminder_lead_minutes: minutes }).success,
        String(minutes),
      ).toBe(true);
    }

    for (const minutes of [0, -1, MAX_REMINDER_LEAD_MINUTES + 1]) {
      expect(
        userPreferencesSchema.safeParse({ ...valid, reminder_lead_minutes: minutes }).success,
        String(minutes),
      ).toBe(false);
    }
  });

  /**
   * ZERO IS NOT "OFF" HERE, unlike the grace period where zero means exact. A
   * reminder at the scheduled minute is a report, and turning a reminder off is
   * what the two toggles are for — a second way to do it is a second thing to
   * disagree with.
   */
  it("refuses a zero lead time rather than reading it as off", () => {
    expect(userPreferencesSchema.safeParse({ ...valid, reminder_lead_minutes: 0 }).success).toBe(
      false,
    );
  });

  it("refuses fractional minutes", () => {
    expect(userPreferencesSchema.safeParse({ ...valid, reminder_lead_minutes: 7.5 }).success).toBe(
      false,
    );
  });

  it("accepts the full volume range and refuses outside it", () => {
    for (const volume of [0, 50, 100]) {
      expect(userPreferencesSchema.safeParse({ ...valid, sound_volume: volume }).success).toBe(
        true,
      );
    }
    for (const volume of [-1, 101]) {
      expect(userPreferencesSchema.safeParse({ ...valid, sound_volume: volume }).success).toBe(
        false,
      );
    }
  });

  /**
   * ⚠️ THE SOUND COLUMNS ARE NOT IN THIS CONTRACT, and that is the whole point
   * of the test. `sound_key` and `custom_sound_path` are owned by
   * `uploadReminderSound` and `removeReminderSound`, which are the only callers
   * that can move the storage object and the row together. A form that could
   * set the key would strand the uploaded file the moment somebody went back to
   * the shipped chime.
   */
  it("ignores a sound_key somebody posts anyway", () => {
    const result = userPreferencesSchema.safeParse({
      ...valid,
      sound_key: "custom",
      custom_sound_path: "sounds/someone-else/theirs.mp3",
    });

    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("sound_key");
    expect(result.data).not.toHaveProperty("custom_sound_path");
  });
});

describe("preference defaults", () => {
  /**
   * ⚠️ THESE MIRROR COLUMN DEFAULTS in
   * 20260904090000_p8_11_password_and_preferences.sql. If this test and the
   * migration ever disagree, THE MIGRATION WINS and `lib/preferences.ts` is the
   * file to fix — the same contract `DEFAULT_GRACE_MINUTES` has with P7-37.
   */
  it("matches what a person with no row gets", () => {
    expect(DEFAULT_USER_PREFERENCES).toEqual({
      clockInReminder: true,
      clockOutReminder: true,
      leadMinutes: 15,
      soundKey: "default",
      customSoundPath: null,
      soundVolume: 70,
    });
  });

  /** The column is text with a CHECK, so the reader narrows rather than casts. */
  it("recognises only the two sound keys", () => {
    expect(isSoundKey("default")).toBe(true);
    expect(isSoundKey("custom")).toBe(true);
    expect(isSoundKey("chime")).toBe(false);
    expect(isSoundKey(null)).toBe(false);
    expect(isSoundKey(undefined)).toBe(false);
  });
});
