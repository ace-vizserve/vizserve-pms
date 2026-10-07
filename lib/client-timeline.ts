import { z } from "zod";

import { formatDate } from "@/lib/dates";

/**
 * P16-09 — how a client request got to the client, in the client's words.
 *
 * The raw shape is `vizserve_pms_client_timeline`: milestone instants and two
 * names, nothing else. This module turns it into labelled steps, ONCE, for both
 * readers — the public approval page and the Gate 3 email. Two sets of labels
 * would be two descriptions of one job, and the client holds both.
 *
 * Every field is nullable and a null step is NOT DRAWN. A form that skips Gate 1
 * has no "accepted"; a task forced to the client has no "checked by QA". A row
 * reading "—" would be the app inventing an event it cannot vouch for.
 */
export const clientTimelineSchema = z.object({
  requested_at: z.string().nullable().default(null),
  accepted_at: z.string().nullable().default(null),
  started_at: z.string().nullable().default(null),
  finished_at: z.string().nullable().default(null),
  reviewed_at: z.string().nullable().default(null),
  pic_name: z.string().nullable().default(null),
  qa_name: z.string().nullable().default(null),
});

export type ClientTimeline = z.infer<typeof clientTimelineSchema>;

export type ClientTimelineStep = {
  key: "requested" | "accepted" | "started" | "finished" | "reviewed";
  label: string;
  /** Formatted, e.g. "3 Oct 2026". */
  date: string;
  /** Who, where the step has a person — the PIC, the QA reviewer. */
  person: string | null;
};

export function clientTimelineSteps(timeline: ClientTimeline | null | undefined): ClientTimelineStep[] {
  if (!timeline) return [];

  const steps: (Omit<ClientTimelineStep, "date"> & { at: string | null })[] = [
    { key: "requested", label: "Request submitted", at: timeline.requested_at, person: null },
    { key: "accepted", label: "Accepted by the team", at: timeline.accepted_at, person: null },
    { key: "started", label: "Work started", at: timeline.started_at, person: null },
    { key: "finished", label: "Work finished", at: timeline.finished_at, person: timeline.pic_name },
    { key: "reviewed", label: "Checked by QA", at: timeline.reviewed_at, person: timeline.qa_name },
  ];

  return steps
    .filter((step): step is typeof step & { at: string } => Boolean(step.at))
    .map(({ at, ...step }) => ({ ...step, date: formatDate(new Date(at)) }));
}

/** `null` when the payload is missing or malformed — the timeline is then simply not shown. */
export function parseClientTimeline(value: unknown): ClientTimeline | null {
  const parsed = clientTimelineSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
