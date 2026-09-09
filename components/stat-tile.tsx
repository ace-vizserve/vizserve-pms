import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A single number with a label — the dashboard's KPI unit.
 *
 * Deliberately NOT a `Card`. A stat row is a grid of small, dense tiles; a Card
 * brings header/content/footer scaffolding and vertical rhythm that fights that.
 *
 * The refresh restacks it. It used to be icon-left / value-right, which read as
 * a list item: the figure sat in a column beside two lines of grey and had to
 * compete with them. Now the icon and label are a header row and the figure is
 * alone on the line below it, at 26px — the largest thing in the tile, which is
 * what a tile whose whole job is one number should be.
 *
 * It is also the most-lifted surface on the page (`shadow-raised-lg`), because a
 * row of these is the first thing anyone looks at.
 *
 * `value` is `number | null`. Null renders an em dash rather than a zero,
 * because "not built yet" and "genuinely zero" are different facts and a
 * placeholder zero is a lie people act on.
 *
 * ⚠️ P12-01 GAVE NULL ITS SECOND MEANING: THE NUMBER COULD NOT BE READ. Same
 * dash, same reason — a count query that failed comes back `null`, and folding
 * it into a zero tells an approver with seven things waiting that they are
 * clear. The dash now carries `count unavailable` for a screen reader, because
 * a dash on its own is state conveyed by a glyph, which this app does not do.
 * The three-state rule is the one `FolderCounts` in
 * `components/app-shell/nav-projects.tsx` follows: null is UNKNOWN, 0 is
 * nothing, n is the number.
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
  // Each tone is a fill, its own border and a solid — the same three-part shape
  // as a status pill, so an icon tile and a chip read as the same system.
  const toneClass = {
    neutral: "border-border bg-muted text-foreground-muted",
    info: "border-info-border bg-info-subtle text-info",
    success: "border-success-border bg-success-subtle text-success",
    warning: "border-warning-border bg-warning-subtle text-warning",
    danger: "border-destructive-border bg-destructive-subtle text-destructive",
  }[tone];

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border bg-card grade-surface p-4 shadow-raised-lg",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {icon ? (
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-md border grade-chip shadow-raised [&_svg]:size-4.5",
              toneClass,
            )}
            aria-hidden
          >
            {icon}
          </span>
        ) : null}
        <p className="truncate text-xs font-semibold text-muted-foreground">{label}</p>
      </div>

      {/* tabular-nums so a column of figures lines up as it changes. */}
      <p
        className={cn(
          "text-2xl leading-none font-semibold tracking-[-0.032em] tabular-nums",
          value === null && "text-foreground-faint",
        )}
      >
        {value === null ? (
          <>
            <span aria-hidden>—</span>
            <span className="sr-only">count unavailable</span>
          </>
        ) : (
          value
        )}
      </p>

      {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}

      {href ? (
        <Link
          href={href}
          className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground hover:underline"
        >
          {linkLabel ?? "Open"}
          <ArrowRight className="size-3" />
        </Link>
      ) : null}
    </div>
  );
}
