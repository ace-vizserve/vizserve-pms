import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  sendRequestApprovedEmail,
  sendRequestSubmittedEmail,
} from "@/lib/email/client-emails";

/**
 * P7-47 — the acknowledgement a requester gets the moment a public form is
 * submitted.
 *
 * Until this existed a client filled in the form and heard nothing until a Team
 * Leader got round to it: no reference number, no proof it arrived. The
 * predictable outcome is a second submission of the same job the next day,
 * which somebody then has to spot and close as a duplicate.
 *
 * These run in DRY-RUN, which is the real code path with `RESEND_API_KEY`
 * unset: `sendEmail` renders the body, logs the subject and sends nothing. That
 * makes the render itself testable — a template that threw on a missing field
 * would fail here rather than in front of a client.
 */

const originalKey = process.env.RESEND_API_KEY;
let logged: string[];

beforeEach(() => {
  // Explicit rather than assumed. A machine with a real key in its environment
  // would otherwise try to send these for real.
  delete process.env.RESEND_API_KEY;
  logged = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    logged.push(String(line));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = originalKey;
});

const REQUEST = {
  to: "procurement@hfse.edu.sg",
  requesterName: "Maria Santos",
  referenceNo: "VB-2026-0042",
  title: "Quarterly newsletter layout",
};

describe("sendRequestSubmittedEmail", () => {
  it("renders and would send to a real address", async () => {
    // `dry-run` means it got all the way through rendering. A template
    // referencing a field that does not exist throws before this point.
    await expect(sendRequestSubmittedEmail(REQUEST)).resolves.toEqual({ status: "dry-run" });
  });

  it("carries the reference number in the subject", async () => {
    /*
     * THE REFERENCE NUMBER IS THE POINT OF THIS EMAIL. It is the only handle a
     * client has on their request — the return email quotes it, the Phase 4
     * approval quotes it, and support asks for it. Putting it in the SUBJECT is
     * what makes the mailbox searchable months later.
     */
    await sendRequestSubmittedEmail(REQUEST);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("VB-2026-0042");
    expect(logged[0]).toContain("procurement@hfse.edu.sg");
  });

  it("never delivers to a seeded test account", async () => {
    /*
     * The seed safety rule, and the reason it is asserted on THIS email rather
     * than only on `isDeliverable`: the acknowledgement fires on every public
     * submission, so a QA run against a seeded form is the most likely way the
     * app ever tries to mail a reserved address.
     */
    await expect(
      sendRequestSubmittedEmail({ ...REQUEST, to: "test.client@example.com" }),
    ).resolves.toMatchObject({ status: "skipped" });

    expect(logged).toHaveLength(0);
  });

  it("skips a value that is not an address rather than throwing", async () => {
    // `requester_email` is NOT NULL and validated on the way in, so this should
    // be unreachable — but the caller swallows failures by design, and a throw
    // here would be swallowed silently. Better that it returns a reason.
    await expect(
      sendRequestSubmittedEmail({ ...REQUEST, to: "not-an-address" }),
    ).resolves.toMatchObject({ status: "skipped" });
  });

  it("does not throw on a name with no surname", async () => {
    // `firstName` splits on whitespace. A one-word name must not produce an
    // empty greeting, and a blank one must not crash the send.
    await expect(
      sendRequestSubmittedEmail({ ...REQUEST, requesterName: "Cher" }),
    ).resolves.toEqual({ status: "dry-run" });

    await expect(
      sendRequestSubmittedEmail({ ...REQUEST, requesterName: "   " }),
    ).resolves.toEqual({ status: "dry-run" });
  });
});

describe("sendRequestApprovedEmail", () => {
  /*
   * P7-48. Until this existed, approval was the ONLY Gate 1 outcome that told
   * the client nothing — returned and rejected both emailed, approved did not.
   * From the client's side, silence after a good decision is indistinguishable
   * from a form that never arrived.
   */

  const APPROVED = {
    to: "procurement@hfse.edu.sg",
    requesterName: "Maria Santos",
    referenceNo: "VB-2026-0042",
    title: "Quarterly newsletter layout",
    approvedTargetDate: "5 Aug 2026",
  };

  it("renders with an agreed date", async () => {
    await expect(sendRequestApprovedEmail(APPROVED)).resolves.toEqual({ status: "dry-run" });
  });

  it("renders when no date was agreed", async () => {
    /*
     * A NULL DATE IS A REAL STATE, not missing data — an approval can be
     * recorded without one. The branch that drops the "Agreed delivery" row
     * must not throw, and must not fall back to the requested date: Gate 1
     * exists to negotiate that date, so echoing the client's own ask back as
     * though it were agreed would be the app committing on the team's behalf.
     */
    await expect(
      sendRequestApprovedEmail({ ...APPROVED, approvedTargetDate: null }),
    ).resolves.toEqual({ status: "dry-run" });
  });

  it("puts the reference in the subject", async () => {
    await sendRequestApprovedEmail(APPROVED);

    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("VB-2026-0042");
  });

  it("never delivers to a seeded test account", async () => {
    await expect(
      sendRequestApprovedEmail({ ...APPROVED, to: "test.client@example.com" }),
    ).resolves.toMatchObject({ status: "skipped" });

    expect(logged).toHaveLength(0);
  });
});
