import { cn } from "@/lib/utils";

/**
 * Empty state.
 *
 * The upstream template's version is ~470 lines: twelve domain variants driving
 * seven hand-animated SVG illustrations. We take its layout and skip that —
 * partly because the variants are fintech-specific, mostly because animated
 * illustrations are decoration on a screen someone stares at all day.
 *
 * The body copy matters more than the picture. An empty queue should say why it
 * is empty and what to do next, not just "no results" — most of ours are
 * reachable because a filter is too narrow or a form is unpublished, and saying
 * so is the difference between a dead end and a next step.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex flex-col items-center gap-3.5 py-14 text-center", className)}
      // Not `role="status"`: this is static page content, not a live region.
      // Announcing it on every render would interrupt a screen reader mid-task.
    >
      {icon ? (
        <span
          className="flex size-12 items-center justify-center rounded-lg border bg-card grade-raised text-muted-foreground shadow-raised [&_svg]:size-6"
          aria-hidden
        >
          {icon}
        </span>
      ) : null}

      <div className="max-w-xs space-y-1">
        <p className="text-base font-semibold tracking-[-0.014em]">{title}</p>
        {description ? (
          <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>

      {action}
    </div>
  );
}
