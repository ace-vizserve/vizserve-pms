# Stack and Conventions — Inherited from the HFSE SIS Build

The ops platform uses the **same stack as the SIS project**. This is not just a technology choice; it means Ace can carry patterns, shared components, and hard rules across, and Kurt only has one codebase idiom to learn.

Source: SIS `package.json` + `.claude/rules/tech-stack.md`.

---

## The stack

| Layer | Choice |
|---|---|
| Framework | **Next.js 16.2**, App Router, Turbopack — single deployable at repo root |
| Runtime | React 19.2 + TypeScript 5 |
| Backend | **Supabase** (Postgres + Auth) via `@supabase/ssr` + `@supabase/supabase-js` |
| Hosting | **Vercel**, including cron jobs |
| Styling | Tailwind v4 via `@tailwindcss/postcss` — **no JS config**; all tokens in `app/globals.css` |
| Components | shadcn/ui on Radix primitives, `class-variance-authority`, `clsx`, `tailwind-merge` |
| Icons / misc UI | `lucide-react`, `cmdk`, `react-day-picker`, `nextjs-toploader`, `@dnd-kit` |
| Toasts | `sileo`, aliased as `sonner` via a tsconfig path shim |
| Client data | `@tanstack/react-query` v5 — **every call goes through `lib/query/fetcher.ts::apiFetch`**. RSC-first; mutations still `router.refresh()` |
| Tables | `@tanstack/react-table` for all filterable lists, via the shared `<DataTable>` shell; `@tanstack/react-virtual` for drill sheets |
| Charts | `recharts` |
| Forms | `react-hook-form` + `zod` v4 + `@hookform/resolvers`; schemas in `lib/schemas/` |
| Spreadsheets | `xlsx` (SheetJS) |
| Email | **`resend`** |
| Testing | Vitest 4 under jsdom + Testing Library |
| Quality | ESLint 9 + `eslint-config-next`, Prettier, husky, lint-staged |

**Banned by existing rule:** no date library. `dayjs` / `date-fns` / `moment` are out; use `lib/dates.ts`. No `tailwind.config.*`. No server-side PDF service — browser print.

---

## As built — deviations from the table above

Recorded 29 Jul 2026, when the app was scaffolded. Each is a deliberate departure, not drift.

| Item | Deviation | Why |
|---|---|---|
| **Toasts** | `sonner` directly, **not** `sileo` aliased via a tsconfig shim | The alias is an SIS-local arrangement. Reinstating it is a one-line path mapping if pattern-parity matters more than directness |
| **Supabase CLI** | Run via `npx --yes supabase@latest`, not a pinned devDependency | The installed binary was a OneDrive Files-On-Demand stub (`EFTYPE`) and could not be fixed by reinstalling while the repo sits in OneDrive |
| **Added** | `tw-animate-css`, `shadcn` | Required by `app/globals.css`'s imports; without them the build fails outright |
| **`lib/dates.ts`** | Written from scratch here, not carried over from SIS | Only what Phase 1 needs. Business-day arithmetic and work-date normalisation are still owed for Phases 4–5 — the concern flagged below is real and unaddressed |
| **`<DataTable>`** | Not yet extracted; two list views are hand-rolled | Extracting from one consumer guesses at the abstraction. See `Q17` — planned for `P2-10` |
| **`apiFetch`** | Not yet used | Every read so far is a React Server Component talking to Supabase directly. The pattern lands when the first client-side fetch does |
| **Rate limiting** | Postgres tables, not Redis/Upstash | No new vendor, no key to rotate, nothing extra to be down. Volume is tens of submissions per day |

**One addition to the stack rules, learned the hard way:** GRANTs and RLS are two independent gates and both must be written. See `R14` in `10-open-questions.md`.

---

## What this changes in the phase docs

Good news mostly — several things I listed as work are already solved in SIS.

| Backlog item | Revision |
|---|---|
| **P0-03** Auth | Use `@supabase/ssr` with the SIS session/middleware pattern. Do not invent a second approach |
| **P0-11** Transactional email | **`resend` is already in the SIS stack.** Reuse the account and sending domain. SPF/DKIM/DMARC may already be done — verify, don't redo |
| **P0-12** Scope test suite | Vitest 4, matching SIS test layout |
| **P1-03/P1-06** Form builder + public form | `react-hook-form` + `zod` for the rendered form. Zod schema generated at runtime from `form_fields` |
| **P1-07** Submission validation | The zod schema is the **shared** contract — same schema validates client-side and server-side. This is how you get the completeness rule enforced twice without writing it twice |
| **P1-13 / P2-10 / P3-03 / P5-04** all list views | Shared `<DataTable>` shell on `@tanstack/react-table`. Do not hand-roll tables |
| **P3-04** Task board | `@dnd-kit` is already in the stack for drag-and-drop |
| **P4-09** Auto-complete job | **Vercel cron.** Already available, no new infrastructure |
| **P5-11 / P6-09** Exports | `xlsx` (SheetJS), same as the SIS masterfile export |
| **P6-05** Dashboards | `recharts` |
| **All data fetching** | Through `lib/query/fetcher.ts::apiFetch`. Copy the pattern, keep the discipline |

---

## The "no date library" rule is a real constraint here — flag it

Two features in this build are date-arithmetic heavy:

1. **DTR** (Phase 5) — work-date attachment, earliest-in/latest-out, overnight OT crossing midnight, timezone handling for Asia/Manila.
2. **The 3-day auto-complete** (Phase 4) — and if it becomes *business* days (Q6), that means weekend skipping and probably a holiday calendar.

`lib/dates.ts` was written for the SIS's needs, which are mostly academic terms and report-card dates. It will almost certainly need extending, not just importing.

**Recommendation:** budget explicit time in Phase 4 and Phase 5 to extend `lib/dates.ts` with business-day arithmetic and work-date normalisation, with its own Vitest coverage. Do not let this get discovered mid-phase — off-by-one date bugs in a DTR are the kind that quietly corrupt payroll for a month before anyone notices.

If business-day math turns out to be substantial, that is a legitimate reason to revisit the no-date-library rule for this repo specifically. Raise it with Ace rather than quietly importing `date-fns`.

---

## New decision this forces — see Q11

The SIS Supabase project is described as *"one shared project also hosts the admissions tables."* So: **do the ops platform tables go in that same Supabase project, or a new one?**

This is not a small call. It affects blast radius, RLS complexity, backup coupling, and the "sell it to other schools" ambition. Full argument in `10-open-questions.md` Q11 — it needs an answer before `P0-02`.
