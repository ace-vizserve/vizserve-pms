import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { approvedParams, receivedParams, type RequestEmailSubject } from "@/lib/emailjs";

/**
 * The EmailJS template is the one artefact in this repo with NO runtime safety
 * net whatsoever.
 *
 * It lives in a web UI, it is pasted there by hand, and EmailJS renders an
 * unresolved variable as an empty string and reports no error. A typo does not
 * fail a build or throw at send time — it ships as a labelled row with a blank
 * beside it, in a client's inbox, and nothing anywhere says why.
 *
 * So the checks that would normally be a compiler's job are here instead.
 */

const TEMPLATE = readFileSync(join(process.cwd(), "docs/emailjs/template.html"), "utf8");

/** The template with HTML comments removed — what EmailJS's variables live in. */
const WITHOUT_COMMENTS = TEMPLATE.replace(/<!--[\s\S]*?-->/g, "");

const SUBJECT: RequestEmailSubject = {
  referenceNo: "VB-2026-0042",
  requesterName: "Maria Santos",
  requesterEmail: "maria.santos@hfse.edu.sg",
  requesterOrg: "HFSE",
  title: "Quarterly newsletter layout",
  description: "Four pages, A4.",
  formName: "Design Request",
  targetDate: "5 Aug 2026",
  submittedAt: "25 Aug 2026, 2:14 PM",
  statusUrl: "https://pms.vizserve.com/status/abc123",
};

describe("no placeholder syntax inside HTML comments", () => {
  /**
   * The bug this exists for, and it is not hypothetical — it shipped into a
   * draft of this template and ate the whole progress trail.
   *
   * AN HTML COMMENT IS NOT A TEMPLATE COMMENT. EmailJS parses the entire file,
   * so a section marker written in a comment as an EXAMPLE opens a real block,
   * and everything down to the next matching close tag is swallowed. The
   * symptom is silent: the markup renders as literal text or vanishes, and no
   * error is raised anywhere.
   */
  it("has no {{ ... }} anywhere in a comment", () => {
    const comments = TEMPLATE.match(/<!--[\s\S]*?-->/g) ?? [];
    const offenders = comments.filter((comment) => comment.includes("{{"));

    expect(
      offenders,
      "describe the syntax in prose instead — EmailJS parses comments too",
    ).toEqual([]);
  });
});

describe("section blocks are balanced", () => {
  it("closes every block it opens, in order", () => {
    const tags = [...WITHOUT_COMMENTS.matchAll(/\{\{([#^/])\s*([a-z_]+)\s*\}\}/g)];
    const stack: string[] = [];

    for (const [, kind, name] of tags) {
      if (kind === "/") {
        // An unmatched close means the block above it swallowed markup, which
        // is the same failure mode as the comment bug and just as silent.
        expect(stack.pop(), `unexpected {{/${name}}}`).toBe(name);
      } else {
        stack.push(name);
      }
    }

    expect(stack, "unclosed section block").toEqual([]);
  });
});

describe("every placeholder is a variable the builders actually pass", () => {
  /**
   * The README's warning, enforced. "EmailJS renders a missing variable as
   * empty, never as an error — so a typo ships as a blank row in a client's
   * email and nothing says why."
   */
  const LOOP = /\{\{#\s*timeline\s*\}\}([\s\S]*?)\{\{\/\s*timeline\s*\}\}/;

  /** Placeholders outside the timeline loop resolve against the top-level bag. */
  function topLevelPlaceholders(): string[] {
    const outside = WITHOUT_COMMENTS.replace(LOOP, "");
    return [...new Set([...outside.matchAll(/\{\{[#^/]?\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))];
  }

  it("resolves every top-level placeholder from receivedParams", () => {
    const params = receivedParams(SUBJECT);
    const missing = topLevelPlaceholders().filter((name) => !(name in params));
    expect(missing).toEqual([]);
  });

  it("resolves every top-level placeholder from approvedParams", () => {
    const params = approvedParams(SUBJECT, "12 Aug 2026", "26 Aug 2026, 9:02 AM");
    const missing = topLevelPlaceholders().filter((name) => !(name in params));
    expect(missing).toEqual([]);
  });

  it("resolves every placeholder inside the loop from a timeline entry", () => {
    const body = WITHOUT_COMMENTS.match(LOOP)?.[1] ?? "";
    const names = [...new Set([...body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]))];

    // Inside the loop, placeholders resolve against the ITEM, not the outer
    // bag — a name that is only a top-level variable renders empty here.
    const entry = (receivedParams(SUBJECT).timeline as { label: string }[])[0];
    const missing = names.filter((name) => !(name in entry));

    expect(names.length, "the loop body should use its item's fields").toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

describe("the progress trail", () => {
  it("carries one stage on the acknowledgement", () => {
    const params = receivedParams(SUBJECT);
    expect(params.timeline).toEqual([
      {
        label: "Request received",
        detail: "We have your request and it is queued for review.",
        at: "25 Aug 2026, 2:14 PM",
      },
    ]);
  });

  it("carries both stages on the approval, oldest first", () => {
    // Repeating "received" is deliberate — this email is read on its own, often
    // weeks later, and a trail starting at "Approved" gives no sense of how
    // long it took.
    const params = approvedParams(SUBJECT, "12 Aug 2026", "26 Aug 2026, 9:02 AM");
    const timeline = params.timeline as { label: string; at: string }[];

    expect(timeline.map((entry) => entry.label)).toEqual([
      "Request received",
      "Approved — work scheduled",
    ]);
    expect(timeline[1].at).toBe("26 Aug 2026, 9:02 AM");
  });

  it("heads the trail only when there is one", () => {
    // The heading is its own scalar because a heading inside the loop would
    // repeat once per stage. Empty means the template's guard drops it.
    expect(receivedParams(SUBJECT).progress_title).toBe("Progress so far");
  });

  /**
   * ⚠️ MIRRORED FROM `vizserve_pms_get_request_status`
   * (`20260825150000_p7_51_request_status_page.sql`), which is the source of
   * truth — it is what `/status/[token]` renders.
   *
   * Pinned here so a change to the SQL wording that is not carried across fails
   * a test rather than shipping an email and a page that describe the same
   * stage in different words.
   */
  it("uses the same wording the tracking page does", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase/migrations/20260825150000_p7_51_request_status_page.sql"),
      "utf8",
    );

    expect(sql).toContain("'Request received'");
    expect(sql).toContain("'We have your request and it is queued for review.'");
    expect(sql).toContain("'Approved — work scheduled'");
    expect(sql).toContain("'A team member has been assigned and work is scheduled.'");
  });
});

describe("the tracking button stays guarded", () => {
  it("wraps the button in a section block", () => {
    // Without the guard it ships as a full-size blue call to action with
    // href="" — a dead CTA in a client's inbox, worse than no button.
    const guarded = /\{\{#\s*status_url\s*\}\}[\s\S]*?Track this request[\s\S]*?\{\{\/\s*status_url\s*\}\}/;
    expect(WITHOUT_COMMENTS).toMatch(guarded);
  });

  it("passes an empty string rather than omitting the key", () => {
    // Both are falsy to EmailJS, but keeping the key means the params bag is
    // one shape whatever happened to the token.
    const params = receivedParams({ ...SUBJECT, statusUrl: null });
    expect(params.status_url).toBe("");
  });
});
