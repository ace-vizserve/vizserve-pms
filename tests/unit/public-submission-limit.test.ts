import { describe, expect, it } from "vitest";

import {
  readRejectionRecord,
  rejectSubmission,
  type RejectionRecord,
} from "@/lib/public-submission-limit";

/**
 * P1-15 / P7-66 — the ORDERING PROPERTY, pinned at the level it is honestly
 * testable.
 *
 * ⚠️ WHAT THESE CAN AND CANNOT PROVE, stated up front because the distinction is
 * the difference between a test and a decoration.
 *
 * They prove OUR control flow: that no branch out of a refused submission
 * returns without the limiter having been told, and that a sender already over
 * the cap hears "throttled" rather than "correct the highlighted fields". The
 * recorder is a parameter, not a mock of a module — `rejectSubmission` takes the
 * side effect as an argument precisely so that "was it called?" is a real
 * question about real code rather than a mock asserting itself.
 *
 * They CANNOT prove the half that lives in Postgres: that
 * `vizserve_pms_record_public_submission_rejection` actually inserts the row,
 * counts the same window `vizserve_pms_submit_request` counts, and reads the same
 * limits singleton. That needs a database, it is `tests/db/` territory, and the
 * function is unapplied — so it is unverified and said so plainly rather than
 * simulated here.
 */

const FIELD_ERRORS = { colour: "Choose one of the listed options." };

/** A recorder that answers as asked and remembers that it was asked. */
function recorder(answer: RejectionRecord) {
  const calls: number[] = [];

  return {
    calls,
    record: async () => {
      calls.push(Date.now());
      return answer;
    },
  };
}

describe("rejectSubmission", () => {
  it("records the attempt before returning field errors", async () => {
    const { calls, record } = recorder({ throttled: false });

    const result = await rejectSubmission({ fieldErrors: FIELD_ERRORS }, record);

    // The regression in one line: this used to be 0, so a bot posting an empty
    // `field_values` at a form with one required field never touched the cap.
    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      ok: false,
      error: "validation_failed",
      field_errors: FIELD_ERRORS,
    });
  });

  it("records the attempt when the FORM could not be checked, not just an answer", async () => {
    const { calls, record } = recorder({ throttled: false });

    const result = await rejectSubmission(
      { fieldErrors: {}, formError: "This form could not be checked." },
      record,
    );

    // The cheapest request to send in a loop, so the one that must not be free.
    expect(calls).toHaveLength(1);
    // No `field_errors`: there is no field to point at.
    expect(result).toEqual({ ok: false, error: "validation_failed" });
  });

  it("tells a throttled sender they are throttled, not to fix their fields", async () => {
    const { calls, record } = recorder({ throttled: true });

    const result = await rejectSubmission({ fieldErrors: FIELD_ERRORS }, record);

    expect(calls).toHaveLength(1);
    // "Too many submissions from here in the last hour" — the only advice that
    // is true for them. `field_errors` must not ride along: the browser routes
    // on it and would highlight a field the sender cannot get past.
    expect(result).toEqual({ ok: false, error: "rate_limited" });
  });

  it("tells a throttled sender they are throttled even when the form is unreadable", async () => {
    const { record } = recorder({ throttled: true });

    const result = await rejectSubmission(
      { fieldErrors: {}, formError: "This form could not be checked." },
      record,
    );

    expect(result).toEqual({ ok: false, error: "rate_limited" });
  });

  it("does not become a 500 when the recorder throws, and still answers the client", async () => {
    let called = 0;

    const result = await rejectSubmission({ fieldErrors: FIELD_ERRORS }, async () => {
      called += 1;
      // `createAdminClient()` throws outright when the service key is missing.
      throw new Error("SUPABASE_SECRET_KEY is not set.");
    });

    expect(called).toBe(1);
    // Fails OPEN: a deployment fault must not tell a paying client on a live
    // form that they have submitted too many times.
    expect(result).toEqual({
      ok: false,
      error: "validation_failed",
      field_errors: FIELD_ERRORS,
    });
  });
});

describe("readRejectionRecord", () => {
  it("reads the function's answer", () => {
    expect(readRejectionRecord({ data: { throttled: true }, error: null })).toEqual({
      throttled: true,
    });
    expect(readRejectionRecord({ data: { throttled: false }, error: null })).toEqual({
      throttled: false,
    });
  });

  it("fails OPEN on an error — including the function not existing yet", () => {
    expect(
      readRejectionRecord({
        data: null,
        error: { message: "function vizserve_pms_record_public_submission_rejection does not exist" },
      }),
    ).toEqual({ throttled: false });
  });

  it("fails OPEN on an unreadable answer rather than guessing throttled", () => {
    // `{"throttled": null}` is the shape a missing limits row would produce.
    expect(readRejectionRecord({ data: { throttled: null }, error: null })).toEqual({
      throttled: false,
    });
    expect(readRejectionRecord({ data: null, error: null })).toEqual({ throttled: false });
    expect(readRejectionRecord({ data: "throttled", error: null })).toEqual({ throttled: false });
  });
});
