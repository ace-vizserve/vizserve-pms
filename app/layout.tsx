import type { Metadata } from "next";
import { Figtree, Geist_Mono, Plus_Jakarta_Sans } from "next/font/google";
import NextTopLoader from "nextjs-toploader";
import { Toaster } from "@/components/ui/toast";

import { ThemeProvider } from "@/components/theme-provider";
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
    default: "VizServe PMS",
    template: "%s · VizServe PMS",
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
          <NextTopLoader color="#4359A5" height={2} showSpinner={false} />
          {children}
          {/* Position, theme and every visual decision live in the wrapper —
              see `components/ui/toast.tsx`. Nothing in the app imports the
              toast library directly, so replacing it costs that one file. */}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
