import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A single number with a label — the dashboard's KPI unit.
 *
 * Deliberately NOT a `Card`. A stat row is a grid of small, dense tiles; a Card
 * brings header/content/footer scaffolding and vertical rhythm that fights that.
 * The template makes the same distinction: its summary rows are raw divs with
 * the card ring, and Cards are reserved for things with a title and a body.
 *
 * `value` is `number | null`. Null renders an em dash rather than a zero,
 * because "not built yet" and "genuinely zero" are different facts and a
 * placeholder zero is a lie people act on.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  href,
  linkLabel,
  tone = "neutral",
  className,
}: {
  label: string;
  value: number | string | null;
  hint?: string;
  icon?: React.ReactNode;
  href?: string;
  linkLabel?: string;
  tone?: "neutral" | "info" | "success" | "warning" | "danger";
  className?: string;
}) {
  const toneClass = {
    neutral: "bg-muted text-muted-foreground",
    info: "bg-info-subtle text-info",
    success: "bg-success-subtle text-success",
    warning: "bg-warning-subtle text-warning",
    danger: "bg-destructive/10 text-destructive",
  }[tone];

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl bg-card p-3 ring-1 ring-foreground/10",
        className,
      )}
    >
      {icon ? (
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full [&_svg]:size-4",
            toneClass,
          )}
          aria-hidden
        >
          {icon}
        </span>
      ) : null}

      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-muted-foreground">{label}</p>
        {/* tabular-nums so a column of figures lines up as it changes. */}
        <p
          className={cn(
            "text-2xl font-bold tracking-tight tabular-nums",
            value === null && "text-muted-foreground/40",
          )}
        >
          {value === null ? "—" : value}
        </p>
        {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}

        {href ? (
          <Link
            href={href}
            className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {linkLabel ?? "Open"}
            <ArrowRight className="size-3" />
          </Link>
        ) : null}
      </div>
    </div>
  );
}
