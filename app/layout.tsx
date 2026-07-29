import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import NextTopLoader from "nextjs-toploader";
import { Toaster } from "sonner";
import "./globals.css";

// DESIGN.md: font.family.primary=Geist, font.family.stack="Geist, Geist Fallback".
// The variable names match what globals.css maps --font-sans/--font-mono to.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <NextTopLoader color="#4359A5" height={2} showSpinner={false} />
        {children}
        <Toaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
