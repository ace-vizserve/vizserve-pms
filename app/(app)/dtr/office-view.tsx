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
import { roleAtLeast } from "@/lib/auth/roles";
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
 * Everyone gets it (P17-07): team leader and above see every room; anybody
 * else sees their own department's room, the all-hands room and the shared
 * spaces. The scope is decided in the database, by `vizserve_pms_office_presence()`.
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

  const office = useQuery({
    queryKey: qk.dtrOffice(),
    queryFn: () => fetchOfficeToday(browserClient()),
    refetchInterval: 60_000,
  });
  // Only needed when the presence function is not there yet (P17-07 unpasted):
  // then the office falls back to the directory and the DTR's own policies.
  const fallback = office.data?.source === "policies";
  const directory = useQuery({
    queryKey: qk.ref("users"),
    queryFn: () => fetchDirectory(browserClient()),
    enabled: fallback,
  });
  const departments = useQuery({
    queryKey: qk.ref("departments"),
    queryFn: () => fetchActiveDepartments(browserClient()),
    enabled: fallback,
  });

  // P17-07. Team leader and above see the whole office and can open anybody's
  // DTR from it. Everybody else sees their own department, and can open only
  // their own — a colleague's DTR is not theirs to read.
  const seesAll = roleAtLeast(auth.role, "team_leader");
  const canOpen = (id: string) => seesAll || id === auth.userId;

  function select(person: OfficePerson) {
    if (!canOpen(person.id)) return;
    const params = new URLSearchParams(search.toString());
    params.set("user", person.id);
    router.push(`/dtr?${params.toString()}`);
  }

  const header = (
    <div>
      <h2 className="text-[15px] leading-snug">
        <span className="font-semibold">{seesAll ? "The office" : "Your department"}</span>
        <span className="text-muted-foreground"> · right now</span>
      </h2>
      <p className="text-xs text-muted-foreground">
        Everyone timed in is at their desk — including anyone who forgot to time out. Hover a desk for
        details{seesAll ? "; click it to open their DTR" : ""}.
      </p>
    </div>
  );

  const failed = office.error ?? (fallback ? (directory.error ?? departments.error) : null);
  if (failed) {
    return (
      <>
        {header}
        <QueryError what="the office" message={failed.message} />
      </>
    );
  }

  if (!office.data || (fallback && (!directory.data || !departments.data))) {
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

  // Who is drawn: the presence function's answer, already scoped by role; or,
  // before it exists, the directory narrowed the way the DTR page narrows it.
  const roster =
    office.data.people ??
    (directory.data ?? []).filter(
      (person) =>
        person.is_active &&
        (scope === null ||
          person.id === auth.userId ||
          (person.primary_department_id !== null && scope.includes(person.primary_department_id))),
    );
  const people = roster.map((person) => ({
    ...officeStatus({ person, punches, onLeave: leave.has(person.id), today, yesterday, now }),
    hidden: "hidden" in person ? person.hidden : false,
  }));
  // The counts are of the people the viewer can actually see.
  const shown = people.filter((person) => !person.hidden);

  const layout = layoutOffice(
    office.data.departments ?? (departments.data ?? []).filter((dept) => !dept.is_shared),
    people,
  );

  const count = (status: OfficePerson["status"]) => shown.filter((person) => person.status === status).length;
  const late = shown.filter((person) => person.longShift).length;

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
        {fallback && !seesAll ? (
          <span className="text-muted-foreground">Only you are shown until the office update is applied.</span>
        ) : null}
        <span className="ml-auto text-muted-foreground">
          Updated {formatAppTime(now)} · refreshes every minute
        </span>
      </div>

      {layout.rooms.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Nobody to show yet.</p>
      ) : (
        <div className="overflow-hidden rounded-lg border">
          <Office3D layout={layout} activity={activity} onSelect={select} canOpen={canOpen} />
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
