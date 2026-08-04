import { cn } from "@/lib/utils";

/**
 * The standard page wrapper.
 *
 * `pt-0` is deliberate, not an oversight: the shell header is `h-16` and its
 * own bottom spacing supplies the top gap. Adding padding here would double it.
 *
 * Fluid full width — there is no `max-w-*`. Pages that genuinely need a reading
 * measure (a single form, a detail page) constrain their own inner column
 * rather than the shell doing it for everything.
 *
 * This exists as a component rather than a repeated class string because the
 * repeated-string version is what left us with six different page widths and
 * two different vertical rhythms across ~20 files.
 */
export function PageShell({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-1 flex-col gap-4 p-4 pt-0", className)} {...props} />;
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
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
