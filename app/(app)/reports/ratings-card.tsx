"use client";

import { Star } from "lucide-react";

import type { RatingBucket, RatingsByPerson } from "@/lib/reports-server";
import { TASK_PRIORITY_LABELS } from "@/lib/schemas/tasks";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/**
 * P7-80 — client ratings, per person and per priority.
 *
 * The department-wide split by priority sits on top; below it, one row per
 * person with their average. Hovering (or focusing) a person's average shows
 * the same split for them alone.
 */

/** One decimal, and only where it earns one — same rule as `metric-cards.tsx`. */
function round1(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function priorityLabel(bucket: RatingBucket): string {
  return bucket.priority ? TASK_PRIORITY_LABELS[bucket.priority] : "No priority";
}

function plural(count: number): string {
  return `${count} ${count === 1 ? "rating" : "ratings"}`;
}

export function RatingsCard({ data }: { data: RatingsByPerson }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Star className="size-4 text-muted-foreground" aria-hidden />
          Ratings by person
        </CardTitle>
        <CardDescription className="text-xs">
          A client&rsquo;s rating counts for the task&rsquo;s PIC and its QA reviewer. Hover an
          average to see it split by task priority.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.people.length === 0 ? (
          <p className="text-xs text-muted-foreground">No ratings were left in this period.</p>
        ) : (
          <>
            {/* The report by priority, for the whole department. */}
            <div className="space-y-1.5">
              <p className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
                By priority
              </p>
              <ul className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {data.byPriority.map((bucket) => (
                  <li key={bucket.priority ?? "none"} className="rounded-md border px-3 py-2">
                    <p className="text-2xs text-muted-foreground">{priorityLabel(bucket)}</p>
                    <p className="text-lg font-semibold tabular-nums">
                      {round1(bucket.average)}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">/ 5</span>
                    </p>
                    <p className="text-2xs text-muted-foreground">{plural(bucket.count)}</p>
                  </li>
                ))}
              </ul>
            </div>

            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-2xs text-muted-foreground">
                  <th className="py-1.5 font-medium">Person</th>
                  <th className="py-1.5 text-right font-medium">Average</th>
                  <th className="py-1.5 text-right font-medium">Ratings</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((person) => (
                  <tr key={person.id} className="border-b last:border-0">
                    <td className="py-1.5">{person.name}</td>
                    <td className="py-1.5 text-right">
                      <Tooltip>
                        <TooltipTrigger
                          className="rounded-sm font-medium tabular-nums underline decoration-dotted underline-offset-4 outline-none focus-visible:outline-2 focus-visible:outline-ring"
                          aria-label={`${person.name}: ${round1(person.average)} out of 5 from ${plural(person.count)}. ${person.byPriority
                            .map((bucket) => `${priorityLabel(bucket)} ${round1(bucket.average)}`)
                            .join(", ")}`}
                        >
                          {round1(person.average)} / 5
                        </TooltipTrigger>
                        <TooltipContent className="w-52 flex-col items-stretch gap-1 px-3 py-2 text-left">
                          <p className="text-2xs font-medium">By task priority</p>
                          <ul className="space-y-0.5">
                            {person.byPriority.map((bucket) => (
                              <li
                                key={bucket.priority ?? "none"}
                                className="flex justify-between gap-3 text-2xs tabular-nums"
                              >
                                <span>{priorityLabel(bucket)}</span>
                                <span>
                                  {round1(bucket.average)} / 5
                                  <span className="ml-1 opacity-70">({bucket.count})</span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                      {person.count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </CardContent>
    </Card>
  );
}
