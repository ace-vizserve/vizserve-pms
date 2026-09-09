import type { Metadata } from "next";
import { Figtree, Geist_Mono, Plus_Jakarta_Sans } from "next/font/google";
import NextTopLoader from "nextjs-toploader";
import { Toaster } from "@/components/ui/toast";

import { ThemeProvider } from "@/components/theme-provider";
import { QueryProvider } from "@/lib/query/provider";
import "./globals.css";

// The design refresh: Figtree.
//
// No `weight` on purpose. Figtree is a variable font, and listing static
// cuts would make next/font ship those only — globals.css sets the body to
// weight 450, which is not one of them, so every screen would silently snap to
// 400 or 500. Omitting it loads the axis and 450 is real.
//
// The variable name is what globals.css maps --font-sans and --font-heading to;
// no component ever names a family.
const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// docs/12 §2 — Plus Jakarta Sans for headings. Declared here because next/font
// only hoists at module scope, but applied nowhere except the marketing and
// sign-in pages’ `font-display` utility — neither of which the refresh
// restructures — so the app UI is untouched.
const plusJakarta = Plus_Jakarta_Sans({
  variable: "--font-plus-jakarta",
  subsets: ["latin"],
  weight: ["600", "700", "800"],
});

export const metadata: Metadata = {
  title: {
    default: "VizServe Team Portal",
    template: "%s · VizServe Team Portal",
  },
  description: "VizServe internal operations platform.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${figtree.variable} ${geistMono.variable} ${plusJakarta.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          {/*
            ⚠️ THE QUERY CACHE LIVES AT THE ROOT, NOT IN `app/(app)/layout.tsx`,
            AND IT HAD TO MOVE. Ace hit `Error: No QueryClient set` on the index
            page in a production build.

            `app/page.tsx` is at the ROOT — it is not inside the `(app)` route
            group — so the provider that used to sit in `(app)`'s layout never
            wrapped it. P12-23 converted `PunchPanel` to `useQuery` and the index
            page renders one, which is the crash. `/forms/[id]` had the same hole
            from the other direction: the `(builder)` group unmounted the
            provider on every visit and threw the whole cache away, rebuilding
            the rail, every reference entry and every task view from nothing on
            the way back. One provider fixes both.

            ⚠️ THE COST, STATED RATHER THAN HIDDEN: this layout also covers the
            pages with NO SESSION — `/request/[slug]`, `/approve/[token]`,
            `/status/[token]`, `/feedback/[token]` and `/login` — so the TanStack
            runtime is now in their bundles. None of them runs a query and none
            ever should: `anon` holds no table privileges at all and those pages
            reach the database only through `SECURITY DEFINER` functions. It buys
            a client with no cache entries, which is cheap but not free. If the
            public form's bundle ever matters, the answer is a second provider
            scoped to the authenticated groups — NOT moving this one back, which
            re-breaks the index page.
          */}
          <QueryProvider>
            <NextTopLoader color="#4359A5" height={2} showSpinner={false} />
            {children}
            {/* Position, theme and every visual decision live in the wrapper —
                see `components/ui/toast.tsx`. Nothing in the app imports the
                toast library directly, so replacing it costs that one file. */}
            <Toaster />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
