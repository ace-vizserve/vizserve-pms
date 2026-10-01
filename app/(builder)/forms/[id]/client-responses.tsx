import Link from "next/link";
import { Inbox, TriangleAlert } from "lucide-react";

import { EmptyState } from "@/components/empty-state";
import { QueryError } from "@/components/query-error";
import { RequestStatusBadge } from "@/components/status-badge";
import { formatDateTime } from "@/lib/dates";
import type { VizservePmsRequestStatus } from "@/lib/database.types";
import { createClient } from "@/utils/supabase/server";

import { ExportAnswers } from "./export-answers";

/**
 * P15-05 — THE RESPONSES TAB OF A CLIENT FORM.
 *
 * Different from an internal form's because a client submission is a REQUEST:
 * it has a reference, a sender and a place in the approval flow. So this lists
 * the requests the form produced, each linking to /requests/[id], where the
 * Gate 1 decision and everything after it still happen. The answers to the
 * form's own questions are in the CSV export, same as an internal form.
 *
 * Read as the caller: RLS scopes requests exactly as it does on /requests.
 */

/** How many recent requests to list. The count above it is never capped. */
const LIST_CAP = 200;

type RequestRow = {
  id: string;
  reference_no: string;
  requester_name: string;
  requester_email: string;
  title: string;
  status: VizservePmsRequestStatus;
  submitted_at: string;
};

export async function ClientFormResponses({ formId }: { formId: string }) {
  const supabase = await createClient();

  const [list, statuses] = await Promise.all([
    supabase
      .from("vizserve_pms_requests")
      .select("id, reference_no, requester_name, requester_email, title, status, submitted_at", {
        count: "exact",
      })
      .eq("form_id", formId)
      .order("submitted_at", { ascending: false })
      .limit(LIST_CAP),
    // Status only, for the breakdown — light enough to read whole.
    supabase.from("vizserve_pms_requests").select("status").eq("form_id", formId),
  ]);

  if (list.error) {
    return (
      <Section>
        <QueryError what="this form's requests" message={list.error.message} />
      </Section>
    );
  }

  const rows = (list.data ?? []) as RequestRow[];
  const total = list.count ?? rows.length;
  const newest = rows[0]?.submitted_at ?? null;

  // Only shown when it covers every request — PostgREST's `max-rows` would
  // otherwise truncate it silently, and a breakdown that sums short misleads.
  const byStatus = new Map<VizservePmsRequestStatus, number>();
  if (!statuses.error && (statuses.data?.length ?? 0) === total) {
    for (const row of statuses.data ?? []) {
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    }
  }

  return (
    <Section>
      <div className="rounded-lg border bg-card p-5 grade-surface shadow-raised">
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-3xl font-semibold tracking-[-0.02em] tabular-nums">
              {total} {total === 1 ? "request" : "requests"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {newest === null ? "Nothing yet" : `Last on ${formatDateTime(newest)}`}
            </p>
          </div>

          <ExportAnswers formId={formId} disabled={total === 0} />
        </div>

        {byStatus.size > 0 ? (
          <ul className="mt-3.5 flex flex-wrap gap-2" aria-label="Requests by status">
            {[...byStatus.entries()].map(([status, count]) => (
              <li key={status} className="flex items-center gap-1.5">
                <RequestStatusBadge status={status} />
                <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground">
          Each request opens in the request queue, where it is approved. Every answer to this
          form&rsquo;s questions is in the CSV export.
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border bg-card grade-surface shadow-raised">
          <EmptyState
            icon={<Inbox />}
            title="No requests yet"
            description="Requests appear here as clients submit the form. Publish it, then share the link from the top of this page."
          />
        </div>
      ) : (
        <section className="rounded-lg border bg-card grade-surface shadow-raised">
          <h3 className="border-b px-5 py-3 text-sm font-semibold tracking-tight">Requests</h3>

          {total > rows.length ? (
            <p className="flex gap-2.5 border-b border-warning-border bg-warning-subtle px-5 py-2.5 text-xs leading-relaxed text-warning">
              <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                Showing the most recent <span className="tabular-nums">{rows.length}</span> of{" "}
                <span className="tabular-nums">{total}</span>. The export has all of them.
              </span>
            </p>
          ) : null}

          <ul className="divide-y">
            {rows.map((request) => (
              <li key={request.id}>
                <Link
                  href={`/requests/${request.id}`}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-2.5 hover:bg-accent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{request.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      <span className="tabular-nums">{request.reference_no}</span> ·{" "}
                      {request.requester_name} · {request.requester_email}
                    </span>
                  </span>
                  <RequestStatusBadge status={request.status} className="shrink-0" />
                  <time
                    dateTime={request.submitted_at}
                    className="shrink-0 text-xs tabular-nums text-muted-foreground"
                  >
                    {formatDateTime(request.submitted_at)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Section>
  );
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section
      className="mx-auto w-full max-w-3xl space-y-4 p-5"
      aria-labelledby="client-responses-heading"
    >
      <h2 id="client-responses-heading" className="sr-only">
        Responses
      </h2>
      {children}
    </section>
  );
}
