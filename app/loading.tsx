import { Skeleton } from "@/components/ui/skeleton";

/**
 * THE ROOT LOADING STATE, and until now there was none anywhere under `app/`.
 *
 * `/` is the staff home and the heaviest route in the product — around nineteen
 * queries, including a three-month leave-calendar RPC — and it showed a blank
 * screen for all of it. Every public client route below it was the same.
 *
 * ⚠️ DELIBERATELY SHAPELESS, WHICH IS NOT LAZINESS. Next inherits this file
 * down the whole tree, and the segments beneath it do not look alike:
 *
 *   `/`                       a `PageShell` bento at `max-w-7xl`, no sidebar
 *   `/login`                  a full-bleed brand gradient
 *   `/request/[slug]`         a centred card on `client-surface`, seen by
 *   `/approve/[token]`        CLIENTS with no account and no idea what this
 *   `/feedback/[token]`       app is
 *   `/status/[token]`
 *
 * A skeleton shaped like the home page would flash staff furniture at a client
 * opening a form link, which is worse than the blank screen it replaces —
 * `components/skeletons.tsx` opens with exactly that warning, that a skeleton
 * which no longer matches what replaces it is worse than none.
 *
 * So this is a neutral placeholder that is wrong on no surface: it inherits
 * whatever background it lands on and occupies the space without predicting the
 * layout. The routes worth a SHAPED fallback should get their own `loading.tsx`
 * beside their `page.tsx`, which overrides this one — that is how every route
 * inside `(app)` already works.
 *
 * `aria-hidden` matching the rest of the repo's loading files: the router
 * announces the navigation, and a second announcement here interrupts it.
 */
export default function Loading() {
  return (
    <div
      aria-hidden
      className="flex min-h-svh w-full flex-col items-center justify-center gap-3 p-6"
    >
      <Skeleton className="h-8 w-48 rounded-lg" />
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-4 w-40" />
    </div>
  );
}
