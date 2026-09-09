"use client";

/**
 * One QueryClient per tab, held across renders.
 *
 * ⚠️ `useState(makeQueryClient)` — THE INITIALISER IS PASSED, NOT CALLED.
 * `useState(makeQueryClient())` builds a fresh client on every render and throws
 * it away, which empties the cache continuously: every screen would refetch on
 * every keystroke and nothing would ever be shared between components. It fails
 * silently, as a mysteriously slow app rather than an error.
 */
import { useState } from "react";
import dynamic from "next/dynamic";
import { QueryClientProvider } from "@tanstack/react-query";

import { makeQueryClient } from "./client";

/**
 * ⚠️ THE DEVTOOLS ARE DYNAMIC AND DEV-ONLY, AND BOTH HALVES MATTER.
 *
 * A plain top-level import puts the whole panel in the production bundle — it is
 * a real UI, not a stub, and it is imported by the provider, which every
 * authenticated page renders. `process.env.NODE_ENV` is inlined at build time,
 * so the branch below is what actually lets the bundler drop it.
 *
 * `ssr: false` is legal here because this file is a client component. It is NOT
 * allowed in a Server Component in the App Router — the same rule
 * `components/ui/rich-text-editor.tsx` is already working within.
 */
const Devtools =
  process.env.NODE_ENV === "development"
    ? dynamic(
        () =>
          import("@tanstack/react-query-devtools").then((mod) => ({
            default: mod.ReactQueryDevtools,
          })),
        { ssr: false },
      )
    : () => null;

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={client}>
      {children}
      <Devtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}
