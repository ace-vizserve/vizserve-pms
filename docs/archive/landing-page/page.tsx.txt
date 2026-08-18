import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  FileText,
  LayoutDashboard,
  ListChecks,
  Send,
  ShieldCheck,
} from "lucide-react";

import Image from "next/image";

import { cn } from "@/lib/utils";
import { buttonVariants } from "@/components/ui/button";
import { MarketingNav } from "@/components/marketing/marketing-nav";
import { ScrollLink } from "@/components/marketing/scroll-link";
import { createClient } from "@/utils/supabase/server";

export const metadata: Metadata = {
  title: "VizServe PMS — one platform for every request",
  description:
    "The internal operations platform for VizServe. Client intake, team-leader review, QA, and client sign-off — tracked end to end, behind one login.",
};

/**
 * Public landing page (`/`).
 *
 * Deliberately the only route rooted at "/" that anonymous visitors can reach —
 * see PUBLIC_EXACT in utils/supabase/middleware.ts for why it could not simply
 * be added to the prefix list.
 *
 * Design: VizServe brand (D11 #4359A5 / #5BC0DE) over the shadcn base, with
 * ClickUp's density instinct and pill CTAs — the two borrowings
 * docs/12-ui-and-notifications.md §2 explicitly sanctions. Nothing here repaints
 * the product UI; the brand tokens are additive while Q15 is open.
 *
 * Every phase label below is honest against docs/13-implementation-status.md. A
 * landing page that claims a module works before it does is a support ticket.
 */

const SERVICE_LINES = ["VizAssists", "VizBooks", "VizBytes", "VizMedia"];

const VALUE_PROPS = [
  {
    icon: Send,
    title: "Clients never sign in",
    body: "Requests arrive through a public form link. Approvals go out as an emailed link. No account, no password reset, no chasing.",
  },
  {
    icon: ShieldCheck,
    title: "Rules live in the database",
    body: "Required fields, the resolution gate, and every status transition are enforced as constraints and triggers — not as front-end validation somebody can bypass.",
  },
  {
    icon: ClipboardCheck,
    title: "Scope is automatic",
    body: "What you see is decided by your role and the departments you lead, applied at the row level. Nobody has to remember to filter a list.",
  },
];

const LIFECYCLE = [
  {
    step: "01",
    title: "Client submits",
    body: "A public form, built in the app and shared by URL. No login by design.",
  },
  {
    step: "02",
    title: "Gate 1 — Team Leader",
    body: "Review, request more information, return, or reject. Nothing becomes work until someone owns it.",
    gate: true,
  },
  {
    step: "03",
    title: "Task created",
    body: "PIC and QA assigned, target date negotiated against real workload.",
  },
  {
    step: "04",
    title: "Gate 2 — Internal QA",
    body: "Work is checked before it ever reaches the client.",
    gate: true,
  },
  {
    step: "05",
    title: "Gate 3 — Client sign-off",
    body: "An emailed approval link, two reminders, and a decision on the record.",
    gate: true,
  },
  {
    step: "06",
    title: "Completed",
    body: "Approved, or auto-completed when the reminders run out — the two stay distinct.",
  },
];

const MODULES = [
  {
    icon: LayoutDashboard,
    title: "Dashboard",
    body: "What is waiting on you, first.",
    status: "Live",
  },
  {
    icon: FileText,
    title: "Client Forms",
    body: "Build a form, share the link, triage what comes back.",
    status: "Live",
  },
  {
    icon: ListChecks,
    title: "Tasks & Tickets",
    body: "PIC, QA, target dates, and the eight-status board.",
    status: "Phase 3",
  },
  {
    icon: CheckCircle2,
    title: "Internal Approvals",
    body: "Leave, purchases, and HR requests on the same engine.",
    status: "Phase 5",
  },
  {
    icon: Clock,
    title: "DTR",
    body: "Time in and out, without leaving the dashboard.",
    status: "Phase 5",
  },
  {
    icon: CalendarClock,
    title: "Timesheet",
    body: "Hours rolled up from work that already happened.",
    status: "Phase 6",
  },
];

const STATS = [
  { value: "6", label: "modules, one login" },
  { value: "3", label: "approval gates" },
  { value: "2", label: "tools replaced" },
  { value: "0", label: "client accounts needed" },
];

const FAQ = [
  {
    q: "Do clients need an account?",
    a: "No. Requests come in through a public form link, and the final approval is an emailed link that carries its own token. A client never creates a password.",
  },
  {
    q: "Who can see which requests?",
    a: "Roles are inclusive — admin covers manager, which covers team leader, which covers member — and a separate list decides which departments you lead. Both are enforced at the row level in the database, not just hidden in the UI.",
  },
  {
    q: "Is the whole platform live?",
    a: "Not yet, and the navigation says so. Dashboard and Client Forms are built. Tasks, Internal Approvals, DTR, and Timesheet are labelled with the phase that delivers them, so the shape of the product is visible before it is finished.",
  },
  {
    q: "What is it replacing?",
    a: "ClickUp and Microsoft Teams Approvals. One system means a request stops being re-keyed between a board, a chat thread, and an inbox.",
  },
  {
    q: "How do I get access?",
    a: "Ask your Team Leader or an admin to add you. Sign-in is your VizServe account through single sign-on.",
  },
];

export default async function LandingPage() {
  // Presentation only — this decides whether the CTA reads "Sign in" or "Open
  // dashboard", nothing more. Every real scope decision goes through
  // lib/auth/authorization.ts, and RLS re-checks under that.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const signedIn = Boolean(user);

  return (
    <div className="flex min-h-svh flex-col">
      <MarketingNav signedIn={signedIn} />

      <main className="flex-1">
        {/* ---------------------------------------------------------------- hero */}
        <section className="border-b">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:py-20">
            <div className="mx-auto max-w-3xl text-center">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-tint px-3 py-1 text-2xs font-semibold tracking-wide text-brand-ink uppercase">
                Internal operations platform
              </span>

              <h1 className="mt-5 font-display text-3xl leading-[1.1] font-extrabold tracking-tight text-balance sm:text-5xl">
                One platform for every <span className="text-brand">VizServe request</span>.
              </h1>

              <p className="mx-auto mt-4 max-w-2xl text-sm text-pretty text-muted-foreground sm:text-base">
                Client intake, team-leader review, internal QA, and client sign-off — tracked end to
                end, behind one login. Replacing ClickUp and Microsoft Teams Approvals.
              </p>

              <div className="mt-7 flex flex-col items-center justify-center gap-2.5 sm:flex-row">
                <Link
                  href={signedIn ? "/dashboard" : "/login"}
                  className={cn(
                    buttonVariants({ size: "lg" }),
                    "w-full rounded-full bg-brand text-brand-foreground hover:bg-brand/90 active:bg-brand/80 sm:w-auto",
                  )}
                >
                  {signedIn ? "Open dashboard" : "Sign in"}
                  <ArrowRight className="size-4" />
                </Link>
                <ScrollLink
                  href="#lifecycle"
                  className={cn(
                    buttonVariants({ size: "lg", variant: "outline" }),
                    "w-full rounded-full sm:w-auto",
                  )}
                >
                  See how it works
                </ScrollLink>
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                VizServe staff sign in with single sign-on. Clients never need an account.
              </p>
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------- service lines */}
        <section className="border-b bg-muted/40">
          <div className="mx-auto max-w-6xl px-4 py-6">
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center sm:gap-8">
              <p className="text-2xs font-semibold tracking-wider text-muted-foreground uppercase">
                Built for every service line
              </p>
              <ul className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2">
                {SERVICE_LINES.map((line) => (
                  <li key={line} className="text-sm font-semibold tracking-tight">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ----------------------------------------------------------- platform */}
        <section id="platform" tabIndex={-1} className="scroll-mt-16 border-b">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:py-20">
            <div className="max-w-2xl">
              <h2 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
                Built for the way requests actually move
              </h2>
              <p className="mt-3 text-sm text-pretty text-muted-foreground">
                Not a board someone remembers to update. A lifecycle with owners, gates, and a
                record of who decided what.
              </p>
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {VALUE_PROPS.map((prop) => (
                <div key={prop.title} className="rounded-lg border bg-card p-5 shadow-ring">
                  <span className="flex size-9 items-center justify-center rounded-sm bg-brand-tint text-brand-ink">
                    <prop.icon className="size-4.5" aria-hidden />
                  </span>
                  <h3 className="mt-4 text-sm font-semibold">{prop.title}</h3>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{prop.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------- lifecycle */}
        <section id="lifecycle" tabIndex={-1} className="scroll-mt-16 border-b bg-muted/40">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:py-20">
            <div className="max-w-2xl">
              <h2 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
                Three gates, from request to sign-off
              </h2>
              <p className="mt-3 text-sm text-pretty text-muted-foreground">
                Every client request crosses the same three approval gates. Nothing skips a gate,
                and every decision keeps its author and its timestamp.
              </p>
            </div>

            <ol className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {LIFECYCLE.map((stage) => (
                <li key={stage.step} className="relative rounded-lg border bg-card p-5 shadow-ring">
                  {/* The gate marker is a label as well as a colour — a bar alone
                      would convey state by colour only. */}
                  {stage.gate ? (
                    <span className="absolute top-0 right-5 -translate-y-1/2 rounded-full bg-brand px-2 py-0.5 text-2xs font-semibold tracking-wide text-brand-foreground uppercase">
                      Approval gate
                    </span>
                  ) : null}
                  <span className="font-mono text-2xs font-semibold tracking-widest text-muted-foreground">
                    {stage.step}
                  </span>
                  <h3 className="mt-2 text-sm font-semibold">{stage.title}</h3>
                  <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{stage.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ------------------------------------------------------------ modules */}
        <section id="modules" tabIndex={-1} className="scroll-mt-16 border-b">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:py-20">
            <div className="max-w-2xl">
              <h2 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
                Six modules behind one login
              </h2>
              <p className="mt-3 text-sm text-pretty text-muted-foreground">
                Modules that are not built yet are still listed, with the phase that delivers them.
                A tool that grows a new section every month reads as unfinished; one that shows the
                whole shape and fills it in reads as a plan.
              </p>
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {MODULES.map((module) => {
                const isLive = module.status === "Live";
                return (
                  <div key={module.title} className="rounded-lg border bg-card p-5 shadow-ring">
                    <div className="flex items-start justify-between gap-3">
                      <span className="flex size-9 items-center justify-center rounded-sm bg-muted text-foreground">
                        <module.icon className="size-4.5" aria-hidden />
                      </span>
                      <span
                        className={
                          isLive
                            ? "shrink-0 rounded-full bg-success-subtle px-2 py-0.5 text-2xs font-semibold text-success"
                            : "shrink-0 rounded-full bg-muted px-2 py-0.5 text-2xs font-medium text-muted-foreground"
                        }
                      >
                        {module.status}
                      </span>
                    </div>
                    <h3 className="mt-4 text-sm font-semibold">{module.title}</h3>
                    <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{module.body}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        {/* -------------------------------------------------------------- stats */}
        <section className="border-b bg-muted/40">
          <div className="mx-auto max-w-6xl px-4 py-10">
            <dl className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              {STATS.map((stat) => (
                <div key={stat.label}>
                  <dt className="sr-only">{stat.label}</dt>
                  <dd>
                    <span className="font-display block text-3xl font-extrabold tracking-tight tabular-nums text-brand">
                      {stat.value}
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">{stat.label}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* ---------------------------------------------------------------- faq */}
        <section id="faq" tabIndex={-1} className="scroll-mt-16 border-b">
          <div className="mx-auto max-w-3xl px-4 py-14 sm:py-20">
            <h2 className="font-display text-2xl font-bold tracking-tight text-balance sm:text-3xl">
              Questions
            </h2>

            {/* Native <details> — an accordion with no client JS, keyboard
                operable and expandable by find-in-page for free. */}
            <div className="mt-8 divide-y border-y">
              {FAQ.map((item) => (
                <details key={item.q} className="group py-4">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium">
                    {item.q}
                    <span
                      aria-hidden
                      className="shrink-0 text-muted-foreground transition-transform group-open:rotate-45"
                    >
                      +
                    </span>
                  </summary>
                  <p className="mt-2.5 text-xs leading-5 text-muted-foreground">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------- cta
            Switched from --brand to --brand-surface so it is the *same* blue as
            the footer directly beneath it. Two adjacent bands of near-but-not-
            quite-equal blue reads as a rendering fault, and --brand lightens in
            dark mode while --brand-surface does not — so they would visibly
            diverge there. */}
        <section className="bg-brand-surface">
          <div className="mx-auto max-w-6xl px-4 py-14 text-center sm:py-16">
            <h2 className="font-display text-2xl font-bold tracking-tight text-balance text-brand-surface-foreground sm:text-3xl">
              Be served with excellence.
            </h2>
            {/* white/80 is the floor on this blue — /75 measures 4.49:1, which
                misses the 4.5:1 normal-text threshold by a hundredth. */}
            <p className="mx-auto mt-3 max-w-xl text-sm text-pretty text-white/80">
              Sign in with your VizServe account to pick up what is waiting on you.
            </p>
            <Link
              href={signedIn ? "/dashboard" : "/login"}
              className={cn(
                buttonVariants({ size: "lg" }),
                "mt-6 rounded-full bg-background text-foreground hover:bg-background/90 active:bg-background/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
              )}
            >
              {signedIn ? "Open dashboard" : "Sign in"}
              <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>
      </main>

      {/* ------------------------------------------------------------- footer */}
      {/* The CTA above is the same blue, so a hairline is what keeps the two
          bands legible as separate things rather than one long slab. */}
      {/* The global focus ring is --ring, a mid grey that all but vanishes on
          this blue. Overridden once here rather than on twelve links. */}
      <footer className="border-t border-white/15 bg-brand-surface text-brand-surface-foreground [&_a:focus-visible]:outline-white">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <div className="flex flex-col gap-8 sm:flex-row sm:justify-between">
            <div className="max-w-xs">
              {/* Now that the footer is brand blue the white asset sits on it
                  directly — the tile it used to need is gone. */}
              <div className="flex items-center gap-2.5">
                <Image
                  src="/assets/VizServeWhite.png"
                  alt="VizServe"
                  width={960}
                  height={882}
                  sizes="40px"
                  className="h-9 w-auto"
                />
                <span className="border-l border-white/25 pl-2.5 text-sm font-semibold tracking-tight">
                  PMS
                </span>
              </div>
              <p className="mt-3 text-xs leading-5 text-white/80">
                The internal operations platform for VizServe. Remote outsourcing across assistance,
                books, bytes, and media.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-8 sm:gap-14">
              <div>
                <h3 className="text-2xs font-semibold tracking-wider text-white/80 uppercase">
                  Platform
                </h3>
                <ul className="mt-3 space-y-2 text-xs">
                  <li>
                    <ScrollLink
                      href="#lifecycle"
                      className="text-white/80 transition-colors hover:text-white"
                    >
                      How it works
                    </ScrollLink>
                  </li>
                  <li>
                    <ScrollLink
                      href="#modules"
                      className="text-white/80 transition-colors hover:text-white"
                    >
                      Modules
                    </ScrollLink>
                  </li>
                  <li>
                    <ScrollLink
                      href="#faq"
                      className="text-white/80 transition-colors hover:text-white"
                    >
                      FAQ
                    </ScrollLink>
                  </li>
                  <li>
                    <Link
                      href="/login"
                      className="text-white/80 transition-colors hover:text-white"
                    >
                      Sign in
                    </Link>
                  </li>
                </ul>
              </div>

              <div>
                <h3 className="text-2xs font-semibold tracking-wider text-white/80 uppercase">
                  VizServe
                </h3>
                <ul className="mt-3 space-y-2 text-xs">
                  <li>
                    <a
                      href="https://vizserve.com"
                      className="text-white/80 transition-colors hover:text-white"
                    >
                      vizserve.com
                    </a>
                  </li>
                  <li>
                    <a
                      href="https://careers.vizserve.com"
                      className="text-white/80 transition-colors hover:text-white"
                    >
                      Careers
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-8 border-t border-white/15 pt-6">
            <p className="text-2xs text-white/80">
              © {new Date().getFullYear()} VizServe. Internal platform — access is limited to
              authorised staff.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
