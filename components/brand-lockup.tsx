import Image from "next/image";

/**
 * The VizServe identity lockup, for pages a CLIENT sees.
 *
 * Extracted because three surfaces need it — the public form, the approval page
 * and the feedback page — and all three had been carrying a placeholder "V" in a
 * coloured square. On the two pages where a client decides whether to approve
 * work, a placeholder mark is the detail that makes the whole thing read as a
 * phishing attempt.
 *
 * The asset is WHITE-ONLY, so it sits on `--brand-surface` rather than directly
 * on the page. That token deliberately does not flip with the theme: `--brand`
 * lightens in dark mode to stay readable as text, which would drop white on it
 * to about 2.2:1. `--brand-surface` holds at #4359A5, where white is 6.54:1.
 */
export function BrandLockup({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-sm bg-brand-surface p-1.5">
        <Image
          src="/assets/VizServeWhite.png"
          alt="VizServe"
          width={960}
          height={882}
          sizes="36px"
          priority
          className="h-full w-auto"
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold tracking-tight">VizServe</span>
        {subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">{subtitle}</span>
        ) : null}
      </span>
    </div>
  );
}
