import { describe, expect, it } from "vitest";

import { dayRequestRowSchema } from "@/lib/schemas/time-records";

// 31 Oct 2026: a withdrawn correction in a lead's scope failed the WHOLE DTR
// table with "came back in a shape this build does not recognise", because this
// schema predated P9-02's WITHDRAWN status.
describe("dayRequestRowSchema", () => {
  const row = {
    id: "6f1c2f8e-3b1a-4c7e-9f0a-1d2e3f4a5b6c",
    request_type: "NO_TIME_IN",
    work_date: "2026-10-20",
    requester_id: "0b5d1a2c-7e3f-4a6b-8c9d-0e1f2a3b4c5d",
    correction_at: null,
    overtime_minutes: null,
  };

  it.each(["PENDING_REVIEW", "APPROVED", "REJECTED", "WITHDRAWN"])("accepts %s", (status) => {
    expect(dayRequestRowSchema.safeParse({ ...row, status }).success).toBe(true);
  });
});
