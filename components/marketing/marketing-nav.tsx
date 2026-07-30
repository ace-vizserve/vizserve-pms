"use client";

import { useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ScrollLink } from "./scroll-link";

const SECTIONS = [
  { label: "Platform", href: "#platform" },
  { label: "How it works", href: "#lifecycle" },
  { label: "Modules", href: "#modules" },
  { label: "FAQ", href: "#faq" },
] as const;

/**
 * Marketing header — a solid brand-blue bar carrying the white logo.
 *
 * The bar is 64px rather than the app shell's 56px: VizServeWhite.png is a
 * stacked lockup (mark over "SERVE"), so it needs vertical room that a wordmark
 * would not. It is also why the wordmark beside it reads "PMS" alone — the
 * logo already says VizServe, and "VizServe SERVE PMS" is what you get
 * otherwise.
 *
 * `signedIn` is resolved on the server and passed down — the page is public and
 * must render identically for anonymous visitors, so a session changes only
 * which label the CTA carries.
 */
export function MarketingNav({ signedIn }: { signedIn: boolean }) {
  const [open, setOpen] = useState(false);

  const ctaHref = signedIn ? "/dashboard" : "/login";
  const ctaLabel = signedIn ? "Open dashboard" : "Sign in";

  return (
    <header className="sticky top-0 z-40 bg-brand-surface text-brand-surface-foreground">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-6">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
        >
          <Image
            src="/assets/VizServeWhite.png"
            alt="VizServe"
            width={960}
            height={882}
            priority
            // Without this the browser assumes full viewport width and pulls
            // the 1920px variant for a 39px-wide mark — on a preloaded,
            // above-the-fold image that is pure LCP cost.
            sizes="40px"
            className="h-9 w-auto"
          />
          <span className="border-l border-white/25 pl-2.5 text-sm font-semibold tracking-tight">
            PMS
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Sections">
          {SECTIONS.map((section) => (
            <ScrollLink
              key={section.href}
              href={section.href}
              className="rounded-sm px-3 py-1.5 text-sm text-white/80 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              {section.label}
            </ScrollLink>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* White on brand blue is the same 6.54:1 pair as brand-on-white,
              just inverted — the only CTA treatment that stays legible here. */}
          <Button
            asChild
            size="sm"
            className="rounded-full bg-white text-brand-surface hover:bg-white/90 active:bg-white/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <Link href={ctaHref}>{ctaLabel}</Link>
          </Button>

          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="-mr-2 text-white hover:bg-white/10 hover:text-white md:hidden"
              >
                <Menu className="size-5" />
                <span className="sr-only">Open menu</span>
              </Button>
            </SheetTrigger>

            <SheetContent side="right" className="w-64 p-3 pt-12">
              <SheetTitle className="sr-only">Menu</SheetTitle>
              <nav className="flex flex-col gap-0.5" aria-label="Sections">
                {SECTIONS.map((section) => (
                  <ScrollLink
                    key={section.href}
                    href={section.href}
                    onNavigate={() => setOpen(false)}
                    className="rounded-sm px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    {section.label}
                  </ScrollLink>
                ))}
              </nav>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
