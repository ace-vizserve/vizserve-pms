import { cn } from "@/lib/utils";

/**
 * The standard page wrapper.
 *
 * Full padding on all four sides, 18px, on the refresh rhythm. This used to
 * carry `pt-0` because the shell header was `h-16` and borderless, so its own
 * bottom spacing supplied the top gap. The header is now `h-14` with a hairline
 * and a shadow — it ends where it ends, and the page owes itself a top gap.
 *
 * FULL WIDTH. Two earlier attempts are worth not repeating: centring a 1440px
 * cap opened a void between the sidebar and the page while the top bar still ran
 * to the sidebar edge, and even left-aligned the cap left the page short of the
 * viewport on a wide screen, which reads as the app failing to fill its window.
 *
 * A table whose columns drift too far apart is a table problem — give that table
 * column widths — not a reason to shrink every page.
 *
 * A page that needs a narrower measure still sets its own: `cn` is tailwind-merge,
 * so a `max-w-3xl` passed in className replaces this rather than fighting it.
 *
 * This exists as a component rather than a repeated class string because the
 * repeated-string version is what left us with six different page widths and
 * two different vertical rhythms across ~20 files.
 */
export function PageShell({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("flex w-full flex-1 flex-col gap-4 p-5", className)} {...props} />;
}

/**
 * Optional page heading.
 *
 * Most pages should NOT use this — the shell breadcrumb is the page label. Keep
 * it for the few screens where the breadcrumb genuinely cannot carry the
 * meaning, and pair it with an action slot rather than floating a button.
 */
export function PageHeader({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-[-0.022em]">{title}</h1>
        {description ? <p className="text-sm text-foreground-muted">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
