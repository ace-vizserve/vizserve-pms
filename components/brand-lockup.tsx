import Image from "next/image";

import { cn } from "@/lib/utils";

/**
 * The VizServe identity lockup, for pages a CLIENT sees.
 *
 * Extracted because several surfaces need it — the public form, the approval
 * page and the feedback page — and all of them had been carrying a placeholder
 * "V" in a coloured square. On the two pages where a client decides whether to
 * approve work, a placeholder mark is the detail that makes the whole thing read
 * as a phishing attempt.
 *
 * The asset is WHITE-ONLY, so it sits on `--brand-surface` rather than directly
 * on the page. That token deliberately does not flip with the theme: `--brand`
 * lightens in dark mode to stay readable as text, which would drop white on it
 * to about 2.2:1. `--brand-surface` holds at #4359A5, where white is 6.54:1.
 */
export function BrandLockup({
  subtitle,
  /**
   * `inline` — mark beside the text. For a page header sitting in a row with
   * other things.
   *
   * `stacked` — mark above the text, everything centred. For the client-facing
   * pages, where the lockup is alone above a card and is the first thing the
   * reader sees. A left-aligned mark floating over a centred card reads as
   * misaligned even though nothing is.
   */
  align = "inline",
  className,
}: {
  subtitle?: string;
  align?: "inline" | "stacked";
  className?: string;
}) {
  const stacked = align === "stacked";

  return (
    <div
      className={cn(
        "flex",
        // Tighter gap stacked than inline. Vertically the mark and the wordmark
        // read as one object, so the same 10px that separates them side by side
        // leaves them looking like two unrelated things here.
        stacked ? "flex-col items-center gap-1.5 text-center" : "items-center gap-2.5",
        className,
      )}
    >
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md bg-brand-surface",
          // Larger when stacked: it is the focal point rather than an adornment
          // beside a name. Less inner padding too — the artwork already carries
          // its own margin, and p-2 on top of that left the mark looking marooned
          // in the middle of the tile.
          stacked ? "size-11 p-1.5" : "size-9 p-1.5",
        )}
      >
        <Image
          src="/assets/VizServeWhite.png"
          alt="VizServe"
          width={960}
          height={882}
          sizes={stacked ? "48px" : "36px"}
          priority
          className="h-full w-auto"
        />
      </span>

      {/* `min-w-0` + `truncate` only in the inline case. Centred text has the
          full width of its column and should wrap rather than clip. */}
      <span className={stacked ? undefined : "min-w-0"}>
        <span className="block text-sm font-semibold tracking-tight">VizServe</span>
        {subtitle ? (
          <span className={cn("block text-xs text-muted-foreground", !stacked && "truncate")}>
            {subtitle}
          </span>
        ) : null}
      </span>
    </div>
  );
}
