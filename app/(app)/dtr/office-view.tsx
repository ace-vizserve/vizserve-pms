"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Building2, Table2 } from "lucide-react";

import { QueryError } from "@/components/query-error";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth/client-auth";
import { departmentScopeFilter } from "@/lib/auth/rules";
import { formatAppTime } from "@/lib/dates";
import { layoutOffice, officeActivity, officeStatus, type OfficePerson } from "@/lib/office";
import { browserClient } from "@/lib/query/browser-client";
import { fetchOfficeToday } from "@/lib/query/fetchers/dtr";
import { fetchActiveDepartments, fetchDirectory } from "@/lib/query/fetchers/task";
import { qk } from "@/lib/query/keys";

/*
 * three.js is heavy, so it is fetched only when the office opens, and never on
 * the server (WebGL has no server). The skeleton holds its place meanwhile.
 */
const Office3D = dynamic(() => import("./office-3d").then((mod) => mod.Office3D), {
  ssr: false,
  loading: () => <Skeleton className="h-[58svh] min-h-[440px] w-full" aria-hidden />,
});

/**
 * The office, drawn above the DTR table whenever a lead is looking at everyone
 * in scope: one room per department, a figure at the desk of everyone timed in
 * right now. Always open — it is the view, not a detail behind a button.
 *
 * Leads only, by the caller — the DTR policy shows a member nobody's punches
 * but their own, so their office would be empty desks and one person. Picking
 * one person in the filter swaps this for that person's year heat map.
 *
 * The punches refresh every minute, so somebody timing in appears without a
 * reload. A punch on this page refreshes it at once (it sits under ["dtr"]).
 */
export function OfficeView() {
  return (
    <section className="relative space-y-3 rounded-xl border bg-card grade-surface p-4 shadow-raised-lg lg:h-full lg:min-h-0 lg:overflow-y-auto">
      <div className="absolute top-3 right-3">
        <OfficeToggle open />
      </div>
      <Office />
    </section>
  );
}

/**
 * The switch between the DTR table and the office. `?view=office` in the URL,
 * so the view survives a reload and a shared link, and the range, person and
 * sort ride along untouched.
 */
export function OfficeToggle({ open }: { open: boolean }) {
  const search = useSearchParams();
  const params = new URLSearchParams(search.toString());
  if (open) params.delete("view");
  else params.set("view", "office");
  const query = params.toString();

  return (
    <Link
      href={`/dtr${query ? `?${query}` : ""}`}
      scroll={false}
      className={buttonVariants({ variant: "outline", size: "sm" })}
    >
      {open ? <Table2 /> : <Building2 />}
      {open ? "Back to table" : "Virtual office"}
    </Link>
  );
}

function Office() {
  const auth = useAuth();
  const scope = departmentScopeFilter(auth);
  const router = useRouter();
  const search = useSearchParams();

  const directory = useQuery({ queryKey: qk.ref("users"), queryFn: () => fetchDirectory(browserClient()) });
  const departments = useQuery({
    queryKey: qk.ref("departments"),
    queryFn: () => fetchActiveDepartments(browserClient()),
  });
  const office = useQuery({
    queryKey: qk.dtrOffice(),
    queryFn: () => fetchOfficeToday(browserClient()),
    refetchInterval: 60_000,
  });

  function select(person: OfficePerson) {
    const params = new URLSearchParams(search.toString());
    params.set("user", person.id);
    router.push(`/dtr?${params.toString()}`);
  }

  const header = (
    <div>
      <h2 className="text-[15px] leading-snug">
        <span className="font-semibold">The office</span>
        <span className="text-muted-foreground"> · right now</span>
      </h2>
      <p className="text-xs text-muted-foreground">
        Everyone timed in is at their desk — including anyone who forgot to time out. Hover a desk for
        details; click it to open their DTR.
      </p>
    </div>
  );

  const failed = directory.error ?? departments.error ?? office.error;
  if (failed) {
    return (
      <>
        {header}
        <QueryError what="the office" message={failed.message} />
      </>
    );
  }

  if (!directory.data || !departments.data || !office.data) {
    return (
      <>
        {header}
        <div role="status" aria-busy="true" className="space-y-3">
          <span className="sr-only">Loading the office…</span>
          <Skeleton className="h-[40svh] w-full" aria-hidden />
        </div>
      </>
    );
  }

  const { today, yesterday, punches, onLeave } = office.data;
  const leave = new Set(onLeave);
  const now = new Date(office.dataUpdatedAt);
  // Re-read every minute with the punches, so lunch and the all-hands start on time.
  const activity = officeActivity(now);

  const people = directory.data
    .filter(
      (person) =>
        person.is_active &&
        (scope === null ||
          person.id === auth.userId ||
          (person.primary_department_id !== null && scope.includes(person.primary_department_id))),
    )
    .map((person) =>
      officeStatus({ person, punches, onLeave: leave.has(person.id), today, yesterday, now }),
    );

  const layout = layoutOffice(
    departments.data.filter((dept) => !dept.is_shared),
    people,
  );

  const count = (status: OfficePerson["status"]) => people.filter((person) => person.status === status).length;
  const late = people.filter((person) => person.longShift).length;

  return (
    <>
      {header}

      {/* The counts, each with its label — never colour alone. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <Legend color="bg-success" label={`${count("working")} working`} />
        <Legend color="bg-muted-foreground" label={`${count("gone")} gone home`} />
        <Legend color="bg-warning" label={`${count("leave")} on leave`} />
        <Legend color="bg-border" label={`${count("out")} not in`} />
        {late > 0 ? <span className="text-warning">{late} still timed in after 10 hours</span> : null}
        {activity === "lunch" ? <span className="font-medium">Lunch time — everyone is in the canteen</span> : null}
        {activity === "allhands" ? <span className="font-medium">Friday all-hands — everyone is in the all-hands room until 5 PM</span> : null}
        <span className="ml-auto text-muted-foreground">
          Updated {formatAppTime(now)} · refreshes every minute
        </span>
      </div>

      {layout.rooms.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Nobody in your departments yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Office3D layout={layout} activity={activity} onSelect={select} />
        </div>
      )}
    </>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`size-2 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}
