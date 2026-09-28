import type { Metadata } from "next";
import { Suspense } from "react";

import Loading from "./loading";
import { BoardPageView } from "./board-page-view";

export const metadata: Metadata = { title: "Board" };

/** P12 Phase A — no server work; see `board-page-view.tsx`. */
export default function TaskBoardPage() {
  return (
    <Suspense fallback={<Loading />}>
      <BoardPageView />
    </Suspense>
  );
}
