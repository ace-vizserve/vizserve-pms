import { CircleCheck, Clock, MessageSquareQuote, Scale } from "lucide-react";

import { formatDate } from "@/lib/dates";
import type {
  ClientEngagement,
  FeedbackReport,
  Negotiation,
  Turnaround,
} from "@/lib/query/fetchers/reports";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * P6-04 / P6-06 / P6-07 — the four metric cards.
 *
 * Presentational only: every figure arrives computed from
 * `lib/query/fetchers/reports.ts` (it was `lib/reports-server.ts` until P12-21,
 * when the reads moved to the browser and the module lost its `server-only`).
 * They are separate from `page.tsx` because that file is already 400 lines of
 * P6-05 and these are four independent questions rather than a continuation of
 * one.
 *
 * ⚠️ EVERY CARD SAYS ITS DENOMINATOR. At this volume the count matters more than
 * the figure — "4.8 from 3 responses" is three people, not a rating — and a
 * number with no denominator is the shape of report that gets quoted in a
 * meeting and then cannot be defended.
 */

/** Nothing to average, nothing to say. Used rather than rendering 0 as a fact. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}

function Figure({
  value,
  unit,
  label,
  tone,
}: {
  value: string;
  unit?: string;
  label: string;
  tone?: "success" | "warning";
}) {
  return (
    <div>
      <p
        className={cn(
          "text-2xl font-semibold tabular-nums",
          tone === "success" && "text-success",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
        {unit ? <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span> : null}
      </p>
      <p className="text-2xs text-muted-foreground">{label}</p>
    </div>
  );
}

/** One decimal, and only where it earns one. `2.0` reads as false precision. */
function round1(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function TurnaroundCard({ data }: { data: Turnaround }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Clock className="size-4 text-muted-foreground" aria-hidden />
          Turnaround
        </CardTitle>
        <CardDescription className="text-xs">
          {/* Both halves stated: what starts the clock, and what stops it. A
              reader who does not know cannot tell whether a figure is good. */}
          From the moment a request was submitted to the moment its task was
          finished, for everything completed in this period.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.completed === 0 ? (
          <Empty>Nothing was completed in this period.</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {/* ⚠️ MEDIAN FIRST, and the mean beside it rather than instead of
                  it. One request that sat over a shutdown drags an average past
                  a fortnight while nineteen took two days — the gap between the
                  two figures is itself the finding. */}
              <Figure value={round1(data.medianDays ?? 0)} unit="days" label="Median" />
              <Figure value={round1(data.meanDays ?? 0)} unit="days" label="Average" />
              <Figure value={String(data.fastestDays ?? 0)} unit="days" label="Fastest" />
              <Figure value={String(data.slowestDays ?? 0)} unit="days" label="Slowest" />
            </div>

            <p className="text-2xs text-muted-foreground">
              {data.completed} {data.completed === 1 ? "request" : "requests"} completed.
            </p>

            {data.worst.length > 0 ? (
              <div className="space-y-1 border-t pt-3">
                <p className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                  Longest in this period
                </p>
                <ul className="space-y-1 text-xs">
                  {data.worst.map((row) => (
                    <li key={`${row.reference}-${row.days}`} className="flex items-baseline gap-2">
                      <span className="font-mono text-2xs text-muted-foreground">
                        {row.reference}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{row.title}</span>
                      <span className="shrink-0 tabular-nums">{row.days}d</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function NegotiationCard({ data }: { data: Negotiation }) {
  const shift = data.medianShiftDays;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Scale className="size-4 text-muted-foreground" aria-hidden />
          Negotiated dates
        </CardTitle>
        <CardDescription className="text-xs">
          {/* Says what the number is FOR. This is the only metric in the app
              that answers "is Gate 1 doing anything", and left unexplained it
              reads as trivia about dates. */}
          What the client asked for against what the team committed to — the
          evidence that Gate 1 negotiates rather than rubber-stamps.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.approved === 0 ? (
          <Empty>No requests were reviewed in this period.</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Figure
                value={String(data.negotiated)}
                label={`Negotiated of ${data.approved}`}
                tone={data.negotiated > 0 ? "success" : undefined}
              />
              <Figure value={String(data.asRequested)} label="Taken as requested" />
              <Figure
                value={shift === null ? "—" : `${shift > 0 ? "+" : ""}${round1(shift)}`}
                unit={shift === null ? undefined : "days"}
                label="Median shift"
              />
            </div>

            <p className="text-2xs text-muted-foreground">
              {data.pushedLater} pushed later, {data.pulledEarlier} pulled earlier.{" "}
              {/* ⚠️ Named explicitly: a null approved date is a deliberate
                  "as requested" (P2-06), not missing data. Without this line a
                  reader assumes the gate skipped those. */}
              A request approved without a new date was taken exactly as asked.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function EngagementCard({ data }: { data: ClientEngagement }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <CircleCheck className="size-4 text-muted-foreground" aria-hidden />
          Client engagement
        </CardTitle>
        <CardDescription className="text-xs">
          Whether a person answered at Gate 3, or the job simply timed out and
          closed itself.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.decisions === 0 ? (
          <Empty>Nothing reached a client decision in this period.</Empty>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Figure
                value={data.engagementPercent === null ? "—" : `${data.engagementPercent}%`}
                label="Answered by a client"
                tone={
                  data.engagementPercent === null
                    ? undefined
                    : data.engagementPercent >= 50
                      ? "success"
                      : "warning"
                }
              />
              <Figure value={String(data.approved)} label="Approved" />
              {/* ⚠️ NOT A FAILURE. A client reading the work and asking for a
                  change is the gate doing exactly its job, and colouring it as
                  a problem would teach the team to avoid it. */}
              <Figure value={String(data.revisionRequested)} label="Changes asked for" />
              <Figure
                value={String(data.autoCompleted)}
                label="Closed with no answer"
                tone={data.autoCompleted > 0 ? "warning" : undefined}
              />
            </div>

            <p className="text-2xs text-muted-foreground">
              {data.decisions} {data.decisions === 1 ? "decision" : "decisions"} in total. The
              percentage counts the automatic ones in its denominator — over answered decisions
              alone it would always read 100%.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function FeedbackCard({ data }: { data: FeedbackReport }) {
  const most = Math.max(1, ...data.distribution);

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <MessageSquareQuote className="size-4 text-muted-foreground" aria-hidden />
          Feedback
        </CardTitle>
        <CardDescription className="text-xs">
          What clients said after the work landed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.responses === 0 ? (
          <Empty>No feedback was left in this period.</Empty>
        ) : (
          <>
            <div className="flex items-end gap-6">
              <Figure
                value={round1(data.averageRating ?? 0)}
                unit="/ 5"
                label={`From ${data.responses} ${data.responses === 1 ? "response" : "responses"}`}
              />

              {/* ⚠️ THE DISTRIBUTION SITS BESIDE THE AVERAGE, not under a
                  disclosure. A 4.0 made of fives and twos is a different
                  department from a 4.0 made of fours, and the average alone
                  cannot say which one this is. */}
              <ul className="flex-1 space-y-0.5">
                {[5, 4, 3, 2, 1].map((stars) => {
                  const count = data.distribution[stars - 1];
                  return (
                    <li key={stars} className="flex items-center gap-2 text-2xs">
                      <span className="w-3 shrink-0 tabular-nums text-muted-foreground">
                        {stars}
                      </span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-track">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${(count / most) * 100}%` }}
                        />
                      </span>
                      <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">
                        {count}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            {data.comments.length > 0 ? (
              <div className="space-y-2 border-t pt-3">
                <p className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                  What they wrote
                </p>
                <ul className="space-y-2 text-xs">
                  {data.comments.map((row) => (
                    <li key={row.at} className="border-l-2 pl-2.5">
                      <p className="wrap-break-word text-foreground-muted">{row.comment}</p>
                      <p className="mt-0.5 text-2xs text-muted-foreground tabular-nums">
                        {row.rating}/5 · {formatDate(row.at.slice(0, 10))}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
