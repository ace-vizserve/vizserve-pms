import type { Metadata } from "next";

/**
 * P12 Phase A — holds this segment's metadata, which moved off `page.tsx` when
 * the page became a client component. It renders nothing of its own.
 */
export const metadata: Metadata = { title: "Board" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
