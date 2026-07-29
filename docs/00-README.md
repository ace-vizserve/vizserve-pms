# VizServe Internal Ops Platform — Build Documentation

**Working name in the meeting:** "the approval system"
**Project name:** **VizServe PMS** — Project Management System. The approval flow is one module of six; the database prefix is `vizserve_pms_`.

**Source of truth for this doc set:** Fathom transcript + summary, *Impromptu Microsoft Teams Meeting, 22 July 2026* (Amier Ordonez, Kurt Steven Arciga, Ace Guevarra), and the Miro board *VizServe Approval Flow Chart* (6 frames: Overall Workflow, Request Submission, Request Approval, Ticket Processing, Completion Approval, Ticket Closure).

**A note on citations:** timestamps like `41:30` point at the Fathom transcript. Several of Amier's turns run 8–10 minutes without an intermediate marker, so timestamps inside those turns are approximate — the quoted words are exact, the minute may be off by a few. Where a quote sits inside a long turn it is marked with `~`. Speaker attribution follows Fathom's labels, which are occasionally wrong; the two places it looked wrong are noted inline.

**Status of the Miro board:** superseded in part. Ace's frames are structurally sound but were drawn *before* Amier's corrections in the 22 July call. `01-updated-workflow.md` contains the corrected flows and a line-by-line change log. Update Miro from that document, not the other way round.

---

## Documents in this set

| # | File | What it is | Who reads it |
|---|------|-----------|--------------|
| 01 | `01-updated-workflow.md` | Corrected end-to-end workflow, Mermaid diagrams per stage, change log vs Miro | Ace, Kurt, Amier |
| 02 | `02-data-model.md` | Postgres/Supabase schema, RLS strategy, status enums | Ace, Kurt |
| 03 | `03-roadmap.md` | Phase plan, dependency graph, exit criteria per phase | Amier, Ace, Kurt |
| 04 | `04-phase-0-foundation.md` | Auth, users, roles, departments, app shell, audit log | Ace, Kurt |
| 05 | `05-phase-1-forms.md` | Form builder + public client submission + request records | Ace, Kurt |
| 06 | `06-phase-2-request-approval.md` | Approval Gate #1 — Team Leader review, negotiate, assign, create task | Ace, Kurt |
| 07 | `07-phase-3-tasks-qa.md` | Task board, statuses, resolution capture, Approval Gate #2 (internal QA) | Ace, Kurt |
| 08 | `08-phase-4-client-approval.md` | Approval Gate #3 — email link, no login, auto-complete, feedback | Ace, Kurt |
| 09 | `09-later-phases.md` | DTR, internal approvals, timesheet, reporting/archive | Amier, Ace, Kurt |
| 10 | `10-open-questions.md` | Decisions Amier still owes the team, and flagged risks | **Amier first** |
| 11 | `11-stack-conventions.md` | Stack inherited from the SIS build, and what it changes in the backlog | Ace, Kurt |
| 12 | `12-ui-and-notifications.md` | Brand palette with measured contrast, what `DESIGN.md` is for, notification policy | **Kurt first** |
| 13 | `13-implementation-status.md` | **What is actually built** vs specified, decisions taken during the build, known traps | **Everyone, first** |

> **The app exists now.** Scaffolded 29 Jul 2026; Phase 0 and most of Phase 1 are implemented. Documents 01–12 remain the *specification*; document 13 is the *state*. Where they disagree, 13 describes reality and the gap is a bug in one of them.

---

## Decisions locked in this doc set

These came from the user (VizBytes) and are treated as settled:

| # | Decision | Source |
|---|----------|--------|
| D1 | Stack: **same as the HFSE SIS build** — Next.js 16.2 App Router, React 19, TypeScript 5, Supabase (Postgres + Auth) via `@supabase/ssr`, Vercel incl. cron. Full conventions in `11-stack-conventions.md` | User, 29 Jul |
| D2 | Phase order: **Foundation → Forms/Tickets/Tasks first**; DTR and internal approvals ride on Teams Approvals a while longer | User, 29 Jul — matches the call: Kurt at 57:47 *"yung sa forms muna... Yan yung pinaka-critical"*, Amier agreeing at 58:02 *"Yan yung pinaka-kailangan ng team ngayon"* |
| D3 | **Phases only — no sprints, no cadence, no dates.** `03-roadmap.md` is the plan of record: dependency-ordered phases with binary exit criteria and relative sizing | User, 29 Jul |
| D3a | **Two parallel tracks.** Ace owns everything from the API contract down (migrations, RLS, Postgres functions, state machines, tests); Kurt owns everything from the contract up (screens, components, email templates). Handoff artefact is a zod schema agreed at the start of each phase, before either track writes code | User, 29 Jul |
| D4 | Standalone web app. Not a Teams app, not a ClickUp add-on | Amier, 48:00 — "Hindi na, dyan na sa web app nyo. Stand alone na yan" |
| D5 | Target end state: retire the ClickUp subscription | Amier, 56:30 |
| D6 | **Four roles**: `member`, `team_leader`, `manager`, `admin` (Q1) | User, 29 Jul |
| D7 | **Microsoft/Entra SSO *and* email + password** auth, both enabled (Q2) | User, 29 Jul |
| D8 | **Single-tenant.** The product ambition is real but deferred until the platform is built and in use (Q3). Zero-cost hedges recorded in `02-data-model.md` | User, 29 Jul |
| D9 | **A new, dedicated Supabase project** — not the SIS one (Q11) | User, 29 Jul |
| D10 | **Table prefix `vizserve_pms_`** on every table and enum type. PMS = Project Management System | User, 29 Jul |
| D11 | **Brand palette**: primary `#4359A5`, secondary `#5BC0DE`. shadcn/Radix stays the component base, themed in `globals.css`. `DESIGN.md` is loose inspiration only | User, 29 Jul |
| D12 | **In-app inbox by default; email only at boundaries** (client-facing, assignment, approval-needed, client decision) | User, 29 Jul |
| D13 | **HFSE is the only client at launch** — `requester_org` stays plain text | User, 29 Jul |
| D14 | **Four departments**: VizBytes (TL Amier Ordonez), VizAssists + VizBooks (TL Joel Castro), VizMedia (TL John Lloyd Tulang). Overall Team Manager: Joel Castro | User, 29 Jul |
| D15 | **Roles are inclusive**: `admin` ⊇ `manager` ⊇ `team_leader` ⊇ `member`. Managed-departments decides who leads what — required because Amier is admin *and* a TL, and Joel is manager *and* a TL | Derived from D14 |
| D16 | Client-facing email sends from **vizserve.com** | User, 29 Jul |
| D17 | `vizserve-pms.vercel.app` for development. A real domain (e.g. `pms.vizserve.com`) is needed before Phase 4 ships client approval links | User, 29 Jul |
| D18 | Every user carries `{"app_access": ["vizserve-pms"], "role": …}` in **`raw_user_meta_data`**, for display and app routing only. Because that field is user-writable via Supabase's auth endpoint, **nothing in the authorization path reads it** — RLS and server actions read `vizserve_pms_users.role`. Enforced by a CI grep. See `02-data-model.md` §Auth metadata | User, 29 Jul |
| D19 | Repo: `vizserve-pms`, already initialised at `github.com/ace-vizserve/vizserve-pms`. Docs live in `docs/` | User, 29 Jul |
| D20 | **Forms are dynamic.** VizServe builds them in the app and shares them by public URL — the field list is *configuration*, not schema, and no field list is agreed up front. Phase 1 seeds placeholders derived from the flow. Consequence: `field_key` is immutable and fields are soft-archived, never hard-deleted (`R5`) | User, 29 Jul (answers Q9) |

### A note on "starting with the approval module"

Two different things were called "approval" in the meeting, and the confirmed order is **client chain first, internal after**:

- **Phases 1–4** — the client request approval chain: Forms → Team Leader review → Tasks/QA → Client email sign-off. Three gates. This is the module the team is bleeding from.
- **Phase 5** — the internal HR approval set: leave, no time-in, no time-out, reimbursement. Deferred because Teams Approvals already covers it today.

**Phase 2 builds the approval engine generically**, then wires the client Team Leader gate onto it as its first consumer. Phase 5's internal approvals plug into the same engine with no new engine work — only a new request type and a new form. `internal_requests` stays a separate table with a separate auth model (see `01-updated-workflow.md` §0), but the approve/return/reject/notify machinery is shared. Do not write it twice.

The acceptance test for that genericity is in `06-phase-2-request-approval.md`: a throwaway second request type must route through the engine without touching engine code.

---

## How to use this with Claude for mockups

Amier's instruction at 58:30 was: finalise the workflow, then hand it to Claude for front-end mockups, design first, wiring later.

The order that works:

1. Read `01-updated-workflow.md` and confirm every flow with Amier. **Do not skip this.** A mockup built on a wrong flow is worse than no mockup, because it makes the wrong flow look decided.
2. Hand Claude `01` + `02` + the specific phase doc, and ask for **front-end only, static data, one screen at a time**.
3. Screens to mock first, in this order: Login → Dashboard → Forms list → Public form (client view) → Request detail (TL approval view) → Task board → Task detail → Client approval page (email link view).
4. Only then wire Supabase.

---

## Conventions used in the phase docs

- **Backlog IDs** are `P<phase>-<n>` (e.g. `P2-04`). Use them in commits and in the Tasks module once it exists — dogfood it.
- **`[NEW]`** = not in the Miro board at all.
- **`[CHANGED]`** = in Miro but contradicted by the meeting.
- **`[RISK]`** = a design decision that can bite; see `10-open-questions.md`.
- **Owner** column is a suggestion based on who was doing what in the call, not an assignment. Ace and Kurt to agree.
