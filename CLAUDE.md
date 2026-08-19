# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

**VizServe PMS** — an internal ops platform for VizServe, replacing ClickUp and Microsoft Teams Approvals. Next.js app at the repo root, Supabase behind it, planning docs in [docs/](docs/).

The app was scaffolded on 29 Jul 2026. **Phase 0 and most of Phase 1 are built** — see [docs/13-implementation-status.md](docs/13-implementation-status.md) for exactly what exists, what is stubbed, and what is still owed. Read that before assuming a feature is missing or present.

## Commands

```bash
npm run dev              # next dev --turbopack  — SEE PORT WARNING BELOW
npm run build            # production build
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
npm run test             # vitest run
npm run test -- <file>   # single test file
npm run verify           # metadata guard + typecheck + lint + test

npm run check:metadata   # CI guard: fails if user_metadata is read in the auth path
npm run seed             # create the 16 test accounts (needs SUPABASE_SECRET_KEY)
npm run diagnose:login   # separates the 4 "cannot log in" failure modes

npm run db:push          # apply migrations to the linked project
npm run db:types         # regenerate lib/database.types.ts (needs db:start + Docker)
```

**Port 3000 is occupied by the HFSE SIS app on this machine.** Use `PORT=3177 npm run dev`. This bites silently — a request to `localhost:3000` returns SIS's login page, which also says "Welcome back", so a smoke test can appear to pass while testing the wrong application entirely.

**The repo lives in a OneDrive-synced folder and OneDrive corrupts `node_modules`.** It has produced a stub `supabase.exe` (`EFTYPE`) and a truncated file *inside* `next` that failed the build. If an install behaves impossibly, reinstall the package before debugging your own code. Moving the repo out of OneDrive is the real fix.

## Two gates guard every table: GRANTs and RLS

This caused a whole-app outage and is the single most useful thing to know here.

- A failing **policy** returns **zero rows**.
- A missing **GRANT** returns **`permission denied for table …`**.

The service role bypasses *policies* but still needs *privileges*. Supabase's default privileges did **not** apply to tables created by these migrations, so `20260729110000_p0_06_grants.sql` grants explicitly and sets `ALTER DEFAULT PRIVILEGES` so future migrations inherit it. If you see `permission denied`, it is grants — never RLS.

`anon` holds **no table privileges at all**. The public form and the Phase 4 approval page reach the database only through `SECURITY DEFINER` functions.

## Where things live

| Path | What |
|---|---|
| `app/(app)/` | Authenticated area — layout enforces auth, renders shell + role nav |
| `app/request/[slug]/` | **Public form. No session, by design.** `app/f/[slug]/` is a permanent 308 to it — an old link lives in client inboxes, so it stays |
| `app/login/`, `app/auth/callback/` | Entra SSO + email/password |
| `lib/auth/authorization.ts` | **P0-05 — the single authorization layer.** Every scope decision |
| `lib/schemas/` | zod contracts — the handoff artefact between tracks (D3a) |
| `lib/dates.ts` | Date helpers. **No date library** (`dayjs`/`date-fns`/`moment` banned) |
| `proxy.ts` | Root auth gate. **Next 16 renamed `middleware.ts` → `proxy.ts`** with the export renamed to `proxy`. There is no `middleware.ts` |
| `utils/supabase/` | `client` (browser) · `server` (RSC/actions) · `middleware` (session refresh, called by `proxy.ts`) · `admin` (service role, bypasses RLS) |
| `supabase/migrations/` | Ordered SQL. `supabase/seed-dev.sql` is a dashboard-paste fallback |
| `scripts/` | `seed.mjs`, `check-user-metadata.mjs`, `diagnose-login.mjs` |

**Ignore `supabase/client.ts`, `supabase/server.ts`, `supabase/middleware.ts`** — orphaned boilerplate in what is now the Supabase CLI directory. Nothing imports them, and `supabase/middleware.ts` never calls `getUser()` so it refreshes nothing. The real clients are in `utils/supabase/`.

## Architecture, in one pass

Six modules behind one login: Dashboard, DTR, Internal Approvals, Client Forms, Tasks/Tickets, Timesheet. The spine is a client request lifecycle crossing **three approval gates**:

```
public form (no login) → GATE 1 Team Leader → Task → GATE 2 internal QA → GATE 3 client (email, no login) → completed
```

Three structural points that are easy to get wrong:

- **The approval engine is built once, generically** (Phase 2, `P2-00`), and the client Gate 1 is its *first consumer*, not its implementation. Phase 5's internal HR approvals reuse it with zero engine changes. The acceptance test is a throwaway second request type routing end to end without touching engine code.
- **Internal Approvals and Client Forms stay separate tables.** They look mergeable — both are "a form that gets approved" — but internal types are a fixed list behind auth, client forms are user-built and public. Different auth models, different lifecycles. Explicitly decided; don't unify them behind a flag.
- **Roles are inclusive**: `admin` ⊇ `manager` ⊇ `team_leader` ⊇ `member`. A user holds one role (the highest); `vizserve_pms_user_managed_departments` decides *which* departments they lead. Authorization checks `role >= required`, never `role == required` — encoded as the Postgres enum's declaration order, so `>=` works directly in SQL.

## Document map

[docs/00-README.md](docs/00-README.md) is the index and carries decisions **D1–D21**, settled and not to be relitigated.

**`D21`: ClickUp is a feature reference, not a system to exchange data with.** No sync, no export/import, no migration — nothing here reads from or writes to ClickUp. What carries over is the *shape* of features the team already knows (the timesheet week grid is the first). This app is the internal ClickUp. `P6-10` is withdrawn.

| Doc | Why you'd open it |
|---|---|
| [13-implementation-status.md](docs/13-implementation-status.md) | **What is actually built.** Read first |
| [00-README.md](docs/00-README.md) | Decision register D1–D21 |
| [01-updated-workflow.md](docs/01-updated-workflow.md) | Canonical flow, six modules, **canonical status enums** |
| [02-data-model.md](docs/02-data-model.md) | Tables, RLS strategy, auth-metadata security rule |
| [03-roadmap.md](docs/03-roadmap.md) | **Plan of record.** Phase order, track split, exit criteria |
| [04](docs/04-phase-0-foundation.md)–[08](docs/08-phase-4-client-approval.md) | One doc per phase |
| [09-later-phases.md](docs/09-later-phases.md) | Phases 5–6 |
| [10-open-questions.md](docs/10-open-questions.md) | Open questions + risk register |
| [11-stack-conventions.md](docs/11-stack-conventions.md) | The stack, inherited from the HFSE SIS build |
| [12-ui-and-notifications.md](docs/12-ui-and-notifications.md) | Brand palette with measured contrast; email-vs-inbox policy |

**`DESIGN.md` has been replaced three times** (ClickUp → Pinterest → Shadcn Fintech) and may change again. It is a *style reference*, not the design system of record. Re-read it before applying it, and never assume the version you remember. Its palette does **not** apply: `Q15` was answered on 30 Jul 2026 in favour of D11, so `--primary` is the brand blue `#4359A5`, not the template's near-black. See `Q15` in [10-open-questions.md](docs/10-open-questions.md) for the full token table.

## Non-negotiable conventions

- **Every table and enum type is prefixed `vizserve_pms_`.** Columns are not.
- **Nothing in the authorization path may read `user_metadata`.** It is user-writable through Supabase's own GoTrue endpoint. RLS and server actions read `vizserve_pms_users.role`. `npm run check:metadata` enforces this and runs in `verify`.
- **All role/department scoping goes through `lib/auth/authorization.ts`**, never scattered `if (role === 'admin')`. Also the hedge that makes deferred multi-tenancy affordable.
- **RLS is the enforcement layer.** List queries carry no department filter — the policy does it. Restating the filter in the query implies the policy is optional.
- **Rules live in the database, not just the UI.** Required-fields validation, the resolution gate, `field_key` immutability and the no-hard-delete guard are all constraints or triggers. The front end will be bypassed.
- **Client forms are dynamic** (`D20`). `form_fields.field_key` is immutable once a form has submissions; fields are soft-archived via `is_active`, never deleted — historical `field_values` are keyed to them (`R5`).
- **Status strings are canonical** — [01-updated-workflow.md §3](docs/01-updated-workflow.md), with the legal-transition table in [07-phase-3-tasks-qa.md](docs/07-phase-3-tasks-qa.md). `COMPLETED` and `COMPLETED_NO_RESPONSE` are deliberately distinct.
- **No date library.** Use `lib/dates.ts`. It parses bare `YYYY-MM-DD` as **midday UTC** — midnight lands on the previous day in any negative offset. Phases 4–5 need business-day math added; raise it rather than importing one.
- **No `tailwind.config.*`** — Tailwind v4, tokens in `app/globals.css`.
- **Single-tenant.** No `organization_id`. `forms.slug` and `requests.reference_no` are globally unique and would need to become per-tenant later.
- **Test accounts use `@example.com` only**, all prefixed `test.`. Dev/staging never deliver real mail. A production smoke check asserts zero `@example.com` rows.
- **State is never conveyed by colour alone.** Every status pill carries its label.

## How work is organised

Two parallel tracks with a hard seam at the API contract: **Ace owns contract-and-below** (migrations, RLS, Postgres functions, state machines, server actions, cron, tests); **Kurt owns contract-and-above** (screens, components, email templates). The handoff artefact is a zod schema in `lib/schemas/` agreed at the *start* of each phase — skipping it is risk `R11`.

Phases are strictly ordered 0→6, no dates, binary exit criteria. If a phase runs long, cut scope *inside* it — never start the next in parallel (`R7`). Tests are written inside the phase alongside migrations.

Use backlog IDs (`P2-04`) in commit messages.
