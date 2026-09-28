import type { Metadata } from "next";
import { Suspense } from "react";

import Loading from "./loading";
import { DtrPageView } from "./dtr-page-view";

export const metadata: Metadata = { title: "DTR" };

/** P12 Phase A — no server work; see `dtr-page-view.tsx`. */
export default function DtrPage() {
  return (
    <Suspense fallback={<Loading />}>
      <DtrPageView />
    </Suspense>
  );
}
