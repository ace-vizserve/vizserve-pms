import Link from "next/link";
import { ArrowRight, Inbox } from "lucide-react";

import { formatDate, isOverdue, relativeDays } from "@/lib/dates";
import type { PendingRequest } from "@/lib/schemas/approvals";
import { cn } from "@/lib/utils";

import { PendingGroup } from "./status-group";

/**
 * Client requests waiting on Gate 1, rendered beside the tasks.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING HERE: these are not tasks, and the UI
 * must not pretend otherwise. They carry no status pill, no assignee, no
 * priority and no inline editing, they cannot be dragged on the board, and
 * every one of them leads to exactly one place — the review screen, where the
 * only thing you can do with a request is decide about it.
 *
 * Making them look like task rows would be worse than leaving them off the page:
 * somebody would try to drag one, or read the count as work in progress, and
 * the first thing they would learn is that this list lies about what its rows
 * are.
 */

/** "Waiting 3 days" — the only number that matters in a queue. */
function waitedFor(submittedAt: string | null): string | null {
  if (!submittedAt) return null;
  const said = relativeDays(submittedAt.slice(0, 10));
  return said === "—" ? null : said;
}

/**
 * The list-view group. Rendered above the stages, because a queue is read
 * before the work — and because "Open" reading as the first thing on the page
 * while three requests sit unlooked-at is how a request waits a week.
 */
export function PendingRequestList({ requests }: { requests: PendingRequest[] }) {
  // No empty state. A group that says "nothing waiting" on every ordinary day
  // is a heading people learn to skip, and the page has its own empty state for
  // the case where there is genuinely nothing at all.
  if (requests.length === 0) return null;

  return (
    <PendingGroup count={requests.length}>
      <ul className="divide-y">
        {requests.map((request) => {
          const late = isOverdue(request.target_date);
          const waited = waitedFor(request.submitted_at);

          return (
            <li key={request.id}>
              <Link
                href={`/requests/${request.id}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 hover:bg-muted/50"
              >
                <span className="font-mono text-2xs text-muted-foreground">
                  {request.reference_no}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{request.title}</span>

                <span className="truncate text-xs text-muted-foreground">
                  {request.requester_name}
                  {request.requester_org ? ` · ${request.requester_org}` : null}
                </span>

                {/* The date the CLIENT asked for, not a due date — nothing has
                    been agreed yet, and calling it "Due" would show a commitment
                    nobody has made. */}
                {request.target_date ? (
                  <span
                    className={cn(
                      "text-xs whitespace-nowrap tabular-nums",
                      late ? "font-medium text-destructive" : "text-muted-foreground",
                    )}
                  >
                    wants {formatDate(request.target_date)}
                  </span>
                ) : null}

                {waited ? (
                  <span className="text-2xs whitespace-nowrap text-muted-foreground">
                    submitted {waited}
                  </span>
                ) : null}

                <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary">
                  Review
                  <ArrowRight className="size-3.5" aria-hidden />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </PendingGroup>
  );
}

/**
 * The board column. Same rows, dealt as cards.
 *
 * It is NOT a `BoardColumn` — that component is a drop target, and a request
 * cannot be dropped into. Approving is a decision with a PIC, a QA reviewer and
 * a list to choose; a drag cannot express any of it, and a column that accepted
 * a card and then bounced it back would be worse than one that never offered.
 */
export function PendingRequestColumn({ requests }: { requests: PendingRequest[] }) {
  if (requests.length === 0) return null;

  return (
    <section className="flex w-72 shrink-0 flex-col rounded-lg border border-dashed bg-muted/30">
      <header className="flex items-center gap-2 border-b border-dashed px-2.5 py-2">
        <Inbox className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="text-2xs font-semibold tracking-[0.03em] uppercase text-muted-foreground">
          Awaiting approval
        </h2>
        <span className="font-mono text-2xs font-semibold tabular-nums text-muted-foreground">
          {requests.length}
        </span>
      </header>

      {/* Dashed border and the muted ground, throughout: this column is not one
          of the stages, and it should not read as the one before Open. Nothing
          in it has been agreed to yet. */}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
        {requests.map((request) => {
          const late = isOverdue(request.target_date);
          const waited = waitedFor(request.submitted_at);

          return (
            <Link
              key={request.id}
              href={`/requests/${request.id}`}
              className="block rounded-md border border-dashed bg-card p-2.5 text-left hover:border-solid hover:shadow-raised"
            >
              <p className="font-mono text-2xs text-muted-foreground">{request.reference_no}</p>
              <p className="mt-0.5 line-clamp-2 text-sm font-medium">{request.title}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {request.requester_name}
                {request.requester_org ? ` · ${request.requester_org}` : null}
              </p>

              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                {request.target_date ? (
                  <span
                    className={cn(
                      "text-2xs tabular-nums",
                      late ? "font-medium text-destructive" : "text-muted-foreground",
                    )}
                  >
                    wants {formatDate(request.target_date)}
                  </span>
                ) : null}
                {waited ? (
                  <span className="text-2xs text-muted-foreground">submitted {waited}</span>
                ) : null}
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
