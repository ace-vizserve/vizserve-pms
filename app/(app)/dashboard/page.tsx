import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Bell, ClipboardCheck, ListChecks, ShieldCheck } from "lucide-react";

import { requireAuthContext, roleAtLeast } from "@/lib/auth/authorization";
import { loadPunchState } from "@/lib/dtr-server";
import { PageShell } from "@/components/page-shell";
import { StatTile } from "@/components/stat-tile";
import { PunchPanel } from "../dtr/punch-panel";
import { createClient } from "@/utils/supabase/server";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
 *
 * The page-local `Card`/`Metric` this used to carry are gone: the counts are
 * `StatTile`s and the punch shortcut is a `Card`. A dashboard growing its own
 * private card component is how the app ended up with six of them.
 */
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

  const showQa = (myQa.count ?? 0) > 0;

  return (
    <PageShell>
      {/* The one heading in the app that is not the breadcrumb. It is a greeting,
          not a page label — the crumb already says "Dashboard". */}
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Hello, {firstName}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {isApprover
            ? "Requests waiting on you appear here first."
            : "Work assigned to you appears here."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {isApprover ? (
          <StatTile
            label="Pending approvals"
            value={pending.count ?? 0}
            hint="Requests awaiting your decision"
            icon={<ClipboardCheck />}
            tone="warning"
            href="/requests?status=PENDING_REVIEW"
            linkLabel="Open queue"
          />
        ) : null}

        <StatTile
          label="My tasks"
          value={myTasks.count ?? 0}
          hint="Assigned to you, still open"
          icon={<ListChecks />}
          tone="info"
          href="/tasks?view=mine"
          linkLabel="Open my tasks"
        />

        {/* Only shown when there is actually something to review. A permanent
            zero teaches people to stop looking at the tile. */}
        {showQa ? (
          <StatTile
            label="Waiting on my QA"
            value={myQa.count ?? 0}
            hint="Work that needs your review"
            icon={<ShieldCheck />}
            tone="info"
            href="/tasks?view=qa"
            linkLabel="Open QA queue"
          />
        ) : null}

        <StatTile
          label="Inbox"
          value={unread.count ?? 0}
          hint="Unread notifications about your work"
          icon={<Bell />}
          href="/inbox"
          linkLabel="Open inbox"
        />
      </div>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle>Time in / out</CardTitle>
          <CardDescription className="text-xs">
            Punch without leaving the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <PunchPanel initial={punchState} compact />
          <Button variant="ghost" size="sm" className="-ml-2" render={<Link href="/dtr" />}>
            Open my DTR <ArrowRight className="size-3.5" />
          </Button>
        </CardContent>
      </Card>
    </PageShell>
  );
}
