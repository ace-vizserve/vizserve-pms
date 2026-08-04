import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import { loadPunchState } from "@/lib/dtr-server";
import { PunchPanel } from "../dtr/punch-panel";
import { createClient } from "@/utils/supabase/server";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * P0-08 — dashboard.
 *
 * The time in/out shortcut is here because Amier asked for it explicitly
 * (16:30, "May in and out sa dashboard shortcut"). P5-03 made it real; it was a
 * disabled placeholder through Phases 0-4 so the shape of the product was
 * legible before the module existed.
 *
 * The counts that CAN be real are real: both read through RLS, so each person's
 * numbers are their own scope by construction rather than by a filter someone
 * has to remember to write.
 */

function Card({
  title,
  description,
  children,
  phase,
}: {
  title: string;
  description: string;
  children?: React.ReactNode;
  phase?: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-5 shadow-ring">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        {phase ? (
          <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground">
            {phase}
          </span>
        ) : null}
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </div>
  );
}

function Metric({ value, label }: { value: number | null; label: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className={
          value === null
            ? "text-2xl font-semibold tabular-nums text-muted-foreground/40"
            : "text-2xl font-semibold tabular-nums"
        }
      >
        {value === null ? "—" : value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

export default async function DashboardPage() {
  const context = await requireAuthContext();
  const supabase = await createClient();
  const isApprover = roleAtLeast(context.role, "team_leader");
  const firstName = context.fullName.trim().split(" ")[0] || "there";

  const [punchState, pending, unread, myTasks, myQa] = await Promise.all([
    loadPunchState(context.userId),
    isApprover
      ? supabase
          .from("vizserve_pms_requests")
          .select("id", { count: "exact", head: true })
          .eq("status", "PENDING_REVIEW")
      : Promise.resolve({ count: null }),
    supabase
      .from("vizserve_pms_notifications")
      .select("id", { count: "exact", head: true })
      .is("read_at", null),
    // P3-14 — the member's own live work. "Not finished" rather than a list of
    // active statuses, so a status added later is counted without anyone
    // remembering to come back here.
    supabase
      .from("vizserve_pms_tasks")
      .select("id", { count: "exact", head: true })
      .eq("assignee_id", context.userId)
      .not("status", "in", "(COMPLETED,COMPLETED_NO_RESPONSE)"),
    supabase
      .from("vizserve_pms_tasks")
      .select("id", { count: "exact", head: true })
      .eq("qa_assignee_id", context.userId)
      .in("status", ["FOR_QA", "QA_IN_PROGRESS"]),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Hello, {firstName}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {isApprover
            ? "Requests waiting on you appear here first."
            : "Work assigned to you appears here."}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Card title="Time in / out" description="Punch without leaving the dashboard">
          <PunchPanel initial={punchState} compact />
          <Button variant="ghost" size="sm" className="mt-3 -ml-2" render={<Link href="/dtr" />}>
              Open my DTR <ArrowRight className="size-3.5" />
            </Button>
        </Card>

        {isApprover ? (
          <Card title="Pending approvals" description="Requests awaiting your decision">
            <Metric value={pending.count ?? 0} label="waiting" />
            <Button variant="ghost" size="sm" className="mt-3 -ml-2" render={<Link href="/requests?status=PENDING_REVIEW" />}>
                Open queue <ArrowRight className="size-3.5" />
              </Button>
          </Card>
        ) : null}

        <Card title="My tasks" description="Work assigned to you, still open">
          <Metric value={myTasks.count ?? 0} label="open" />
          <Button variant="ghost" size="sm" className="mt-3 -ml-2" render={<Link href="/tasks?view=mine" />}>
              Open my tasks <ArrowRight className="size-3.5" />
            </Button>
        </Card>

        {/* Only shown when there is actually something to review. A permanent
            zero teaches people to stop looking at the card. */}
        {(myQa.count ?? 0) > 0 ? (
          <Card title="Waiting on my QA" description="Work that needs your review">
            <Metric value={myQa.count ?? 0} label="to review" />
            <Button variant="ghost" size="sm" className="mt-3 -ml-2" render={<Link href="/tasks?view=qa" />}>
                Open QA queue <ArrowRight className="size-3.5" />
              </Button>
          </Card>
        ) : null}

        <Card title="Inbox" description="Notifications about your work">
          <Metric value={unread.count ?? 0} label="unread" />
          <Button variant="ghost" size="sm" className="mt-3 -ml-2" render={<Link href="/inbox" />}>
              Open inbox <ArrowRight className="size-3.5" />
            </Button>
        </Card>
      </div>
    </div>
  );
}
