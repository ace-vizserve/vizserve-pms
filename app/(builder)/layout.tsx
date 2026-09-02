import { requireAuthContext } from "@/lib/auth/authorization";

/**
 * P7-66 Phase 4a — THE BUILDER LIVES OUTSIDE THE APP SHELL.
 *
 * `/forms/[id]` used to sit in `(app)`, inside the 304px sidebar. The Elementor
 * rework puts a palette column and an edit panel either side of the canvas, and
 * a sidebar beside those is a third column of chrome competing for the same
 * screen — three rails and one form. So the route moved into its own group.
 *
 * ⚠️ A ROUTE GROUP, SO THE URL IS UNCHANGED. `(builder)` is excluded from the
 * path exactly as `(app)` is, and `/forms/[id]` is byte-identical to what it was
 * — every existing link, redirect and `router.push` still lands here. `/forms`
 * and `/forms/new` stay in `(app)`; they are different paths, so there is no
 * parallel-route collision between the two groups.
 *
 * ⚠️ AUTH IS ENFORCED HERE, because `app/(app)/layout.tsx` is what did it
 * before and this route no longer passes through it. `proxy.ts` still gates the
 * route at the edge, and the page itself still calls `requireRole("team_leader")`
 * — this is the layer that was lost in the move, restated where it belongs.
 * `app/page.tsx` is the precedent: a page outside the shell carrying its own
 * auth and its own header.
 *
 * WHAT THE SHELL PROVIDED AND WHERE IT NOW COMES FROM:
 *   - `ThemeProvider`, `Toaster` (sonner) and `NextTopLoader` are in the ROOT
 *     layout, not the shell, so they are untouched by the move. The builder
 *     calls `toast` on every save and would have gone silent otherwise.
 *   - The sidebar, its unread/awaiting-review badges and the project tree are
 *     deliberately gone. That is the point of the route group.
 *   - `TooltipProvider` is not needed: Base UI's tooltip works without one (the
 *     provider only groups open delays), which is why `app/page.tsx` renders a
 *     tooltip outside the shell already.
 *   - `BreadcrumbLabelProvider`/`DynamicBreadcrumb` are gone with the shell, so
 *     the page's `BreadcrumbLabel` went with them rather than being left
 *     pointing at a breadcrumb that no longer renders. The page's own header
 *     carries the form name instead.
 *
 * The wrapper is the same object `app/page.tsx` uses: `min-h-svh`, the one
 * ambient wash the product UI has, and a real background token so the page has
 * something to sit on in both themes.
 */
export default async function BuilderLayout({ children }: { children: React.ReactNode }) {
  await requireAuthContext();

  return (
    <div className="flex min-h-svh flex-col grade-ambient bg-background bg-no-repeat">
      {children}
    </div>
  );
}
