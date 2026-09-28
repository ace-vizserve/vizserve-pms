import type { Metadata } from "next";
import { Suspense } from "react";

import Loading from "./loading";
import { TeamPageView } from "./team-page-view";

export const metadata: Metadata = { title: "Team week" };

/** P12 Phase A — no server work; see `team-page-view.tsx`. */
export default function TeamWeekPage() {
  return (
    <Suspense fallback={<Loading />}>
      <TeamPageView />
    </Suspense>
  );
}
