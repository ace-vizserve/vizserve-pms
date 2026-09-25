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
import { QueryClientProvider } from "@tanstack/react-query";

import { makeQueryClient } from "./client";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(makeQueryClient);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
