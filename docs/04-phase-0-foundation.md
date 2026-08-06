# Phase 0 — Foundation

**Goal:** a logged-in shell where role and department scoping demonstrably works, on a schema that will not need rewriting in Phase 5.

**Nothing user-facing ships here except a login and a dashboard.** That is fine. Amier called these the prerequisites at 58:20.

**Relative size:** medium. Mostly schema and plumbing; the scope test suite is the real work.

## Track split

| Ace | Kurt |
|---|---|
| P0-01 repo/env · P0-02 base schema · P0-05 authz layer · P0-06 RLS · P0-09 audit log · P0-10 notifications · P0-12 scope tests | P0-03 auth · P0-04 user management screens · P0-07 app shell + nav · P0-08 dashboard skeleton · P0-11 email verification |

**Contract, agreed before either track starts:** the `users` / `departments` zod schemas in `lib/schemas/`. Kurt builds the management screens against them while Ace lands the migration and RLS.

---

## Backlog

| ID | Item | Detail | Owner |
|----|------|--------|-------|
> **Read `11-stack-conventions.md` first.** The stack is inherited from the SIS build, and several items below are already solved there — `resend` for email, Vercel cron, the shared `<DataTable>` shell, `lib/query/fetcher.ts::apiFetch`. Reuse, don't rebuild.

| P0-01 | Repo + environments | Next.js 16.2 App Router, TS 5, **a new dedicated Supabase project**, Vercel, local + staging. Mirror the SIS repo layout. Commit conventions using `P<n>-<nn>` IDs | Ace |
| P0-02 | Base schema migration | `vizserve_pms_departments`, `vizserve_pms_users`, `vizserve_pms_user_managed_departments` per `02-data-model.md`. **Every table and enum type carries the `vizserve_pms_` prefix.** Single-tenant — no `organization_id` | Ace |
| P0-03 | Auth | Supabase Auth via `@supabase/ssr`, copying the SIS session/middleware pattern. **Both** Entra/Microsoft SSO and email + password. Includes password policy and reset flow, plus identity linking so one person never gets two profiles | Kurt |
| P0-04 | User management screens | Admin CRUD: email, full name, role (4 roles), primary department, managed departments (multi-select checkbox — Amier ~26:00), active flag | Kurt |
| P0-05 | Role + department authorization layer | A single server-side helper every query goes through. **Not** scattered `if (role === 'admin')` checks | Ace |
| P0-06 | RLS policies | Per `02-data-model.md`. Wrong-role queries return zero rows, not errors | Ace |
| P0-07 | App shell + role-based nav | Left nav renders per role. Modules not yet built render as disabled placeholders so the shape is visible. Theme shadcn with the brand palette in `app/globals.css` — see `12-ui-and-notifications.md` | Kurt |
| P0-08 | Dashboard skeleton | Placeholder cards: time in/out shortcut (disabled until Phase 5), pending approvals, my tickets, inbox | Kurt |
| P0-09 | `vizserve_pms_audit_logs` table + write helper | One function, called from every mutation. Wire it now or it never gets wired | Ace |
| P0-10 | `vizserve_pms_notifications` table + inbox list | Table, insert helper, and a plain list view. Include the per-type `send_email` flag (D12). ~~Unread badge deferred — Amier 21:20~~ **Badge built 6 Aug 2026** at Kurt's request, capped at `99+`; the inbox also gained search, type/read filters and pagination once a real account passed 1,600 notifications | Ace |
| P0-11 | Transactional email setup | `resend` (already in the SIS stack), sending from **vizserve.com**. Add SPF/DKIM/DMARC records for it. **Must land in Phase 0** — Phase 4 is entirely email-dependent and deliverability problems surface late | Kurt |
| P0-12 | Seed + scope test suite | Vitest 4, SIS test layout. **Seed test accounts only** (below) — no real users until go-live. Plus tests asserting each role sees exactly the right row set | Ace |

### Seeding

**Departments are real from day one; users are not.** The four departments — VizBytes, VizAssists, VizBooks, VizMedia — seed as production data. Everyone who logs in during the build is a test account.

Roles are inclusive (`admin` ⊇ `manager` ⊇ `team_leader` ⊇ `member`) — see `02-data-model.md` — so one role plus a managed-departments set covers every real arrangement, including an admin who is also a department's approver.

#### Test accounts — the only accounts Phase 0 seeds

Development runs on test accounts alone. **No real person is created, and no real address is stored, until production onboarding** (below). This removes a whole class of accident: nobody gets an unexpected email from a half-built system, and the developers' build permissions never have to be reconciled with their real job permissions.

**Two safety rules before the addresses.** Both matter more than they look, because this system's whole purpose in Phase 4 is sending real email to real clients.

1. **Test addresses use `@example.com`** — an IANA-reserved domain that can never route to a real person. Do **not** use plausible `@vizserve.com` or `@hfse.edu.sg` addresses for test data. A seeded "test" address one typo away from a real colleague's is how a QA run emails an actual client.
2. **Dev and staging never deliver real mail.** Use Resend's test mode or a mail sink (Mailtrap, Inbucket). Seed users via the Supabase admin API with `email_confirm: true` so no confirmation mail is needed at all. Only production sends.

| Email | Role | Primary dept | Manages | Exists to test |
|---|---|---|---|---|
| `test.admin@example.com` | `admin` | — | — | Sees everything; the developers' working account |
| `test.manager@example.com` | `manager` | — | VizAssists, VizBooks | Mirrors Joel — multi-department oversight |
| `test.manager.all@example.com` | `manager` | — | all four | The multi-select checkbox at full width |
| `test.tl.vizbytes@example.com` | `team_leader` | VizBytes | VizBytes | Gate 1 approver |
| `test.tl.vizassists@example.com` | `team_leader` | VizAssists | VizAssists | Gate 1 approver |
| `test.tl.vizbooks@example.com` | `team_leader` | VizBooks | VizBooks | Gate 1 approver |
| `test.tl.vizmedia@example.com` | `team_leader` | VizMedia | VizMedia | Gate 1 approver |
| `test.member1.vizbytes@example.com` | `member` | VizBytes | — | PIC |
| `test.member2.vizbytes@example.com` | `member` | VizBytes | — | QA — **needed so PIC ≠ QA can be tested** |
| `test.member1.vizassists@example.com` | `member` | VizAssists | — | PIC |
| `test.member2.vizassists@example.com` | `member` | VizAssists | — | QA |
| `test.member1.vizbooks@example.com` | `member` | VizBooks | — | PIC |
| `test.member2.vizbooks@example.com` | `member` | VizBooks | — | QA |
| `test.member1.vizmedia@example.com` | `member` | VizMedia | — | PIC |
| `test.member2.vizmedia@example.com` | `member` | VizMedia | — | QA |
| `test.client@example.com` | *no account* | — | — | Public form submission and the Phase 4 approval token — **never a real user row** |

**Why two members per department.** Phase 2 sets both a PIC and a QA, and Phase 3's QA gate is only meaningfully tested when they are different people. One member per department makes the whole QA path untestable.

**Why a client address with no account.** The Phase 4 approval flow is session-less by design. `test.client@example.com` exists only as a `requester_email` value on seeded requests — if it ever gets a `vizserve_pms_users` row, the test is no longer testing the thing that ships.

**Every seeded account — test and production — also gets `app_access` and `role` in `raw_user_meta_data`:**

```sql
update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
    || '{"app_access": ["vizserve-pms"], "role": "team_leader"}'::jsonb
where email = 'test.tl.vizbytes@example.com';
```

**These claims are for display and routing only.** `user_metadata` is user-writable through Supabase's own auth endpoint, so nothing in the authorization path may read it — RLS and every server action read `vizserve_pms_users.role` instead. Full reasoning and the two cheap defences are in `02-data-model.md` §Auth metadata.

**Tear-down.** Every test account is prefixed `test.` and on `@example.com`. Both make them trivially selectable for deletion, and a production smoke check should assert that **zero** `@example.com` rows exist. Add that assertion in `P0-12` — it costs one line and it is the thing that stops test data quietly reaching production.

---

#### Production onboarding — NOT Phase 0

Real accounts get created at go-live, not during the build. Recorded here so the data is not lost.

| User | Email | Role | Primary dept | Managed departments |
|---|---|---|---|---|
| Amier Ordonez | `amier.ordonez@vizserve.com` | `admin` | VizBytes | VizBytes |
| Joel Castro | `joel.castro@vizserve.com` | `manager` | — | VizAssists, VizBooks |
| John Lloyd Tulang | `johnlloyd.tulang@vizserve.com` | `team_leader` | VizMedia | VizMedia |
| Ace Guevarra | `ace.guevarra@vizserve.com` | `member` | VizBytes | — |
| Kurt Steven Arciga | `kurtsteven.arciga@vizserve.com` | `member` | VizBytes | — |
| Raiza Mondina | `raiza.mondina@vizserve.com` | `member` | VizBytes | — |

**Still needed before go-live:** members for VizAssists, VizBooks and VizMedia. Not a blocker now — the test accounts cover all four departments — but Gate 1 cannot go live outside VizBytes without real people to assign work to.

Note that Ace and Kurt are `member` in production. Their build access lives entirely in `test.admin@example.com`, so production permissions reflect their actual job.

### One useful consequence of the email domain

Staff identities and the client-facing sending domain are **both `vizserve.com`** (D16). That is a cleaner setup than it looks:

- **Deliverability.** SPF/DKIM/DMARC get configured once, on one domain, and the `From:` on client emails aligns with the organisation actually sending them. No cross-domain alignment problems in Phase 4, which is the phase that cannot afford them.
- **Reply-to has an obvious home.** Client replies to an approval email land on a real `@vizserve.com` mailbox. Decide which one — a shared inbox beats an individual, since the individual eventually leaves or goes on leave.
- **VizServe controls its own identity.** The Entra tenant behind SSO is VizServe's own, so staff access to VizServe's operations tool is not governed by the client's IT. Worth having.

**One thing to confirm for `P0-03`:** is `vizserve.com` on its own Microsoft 365 / Entra tenant, and who can create the app registration? If `vizserve.com` is mail-only and identities actually live elsewhere, SSO points at a different tenant than expected — better to check than to discover it mid-implementation. Email/password (D7) covers anyone outside the tenant either way.

---

## P0-12 deserves emphasis

The scope test suite is the deliverable that makes every later phase safe. Amier's role model (24:00–26:30) is the thing most likely to be quietly broken by a later feature, and manual clicking will not catch it.

Minimum assertions:

- A member queries `vizserve_pms_requests` → sees only their own.
- A member queries `vizserve_pms_tasks` → sees only where they are PIC or QA.
- A TL managing VizBytes only → sees VizBytes rows, zero VizBooks rows.
- A TL managing VizBytes + VizBooks → sees both, zero VizAssist rows.
- An admin → sees all.
- Every one of the above run **against the API with that user's token**, not against a mocked helper.
- **A production smoke check asserting zero `@example.com` rows exist.** One line; stops test data quietly reaching production.
- **A test that a member who rewrites their own `user_metadata.role` to `admin` still sees only their own rows.** Do it for real — call `updateUser({data:{role:'admin'}})` with a member's token, then re-run the scope assertions. This is the single highest-value security test in Phase 0.
- **A CI grep that fails the build if `user_metadata` is referenced outside presentation code.** Five minutes, and it is what keeps the test above true a year from now.

---

## Explicitly out of scope for Phase 0

- Any form, request, or task functionality
- Time in/out (button renders, does nothing)
- Anything multi-tenant. Single-tenant by decision (D8); hedges are in `02-data-model.md`, not code
- Unread notification counts

---

## Exit criteria

- [ ] Login works end to end on staging.
- [ ] All four roles exist and drive nav rendering.
- [ ] Both auth paths work, and signing in via each with the same email resolves to **one** user profile.
- [ ] `P0-12` suite is green.
- [ ] Every table and enum type carries the `vizserve_pms_` prefix; RLS enabled on every table.
- [ ] A test email sends and lands in an inbox, not spam.
- [ ] An audit log row is written when a user is created or edited.

---

## Decisions this phase forces

**All four blockers are now answered** (see `10-open-questions.md`):

- **Q1** → four roles: `member`, `team_leader`, `manager`, `admin`
- **Q2** → Entra SSO **and** email + password, both enabled
- **Q3** → single-tenant; multi-tenancy deferred, hedges in `02-data-model.md`
- **Q11** → a new, dedicated Supabase project; all tables prefixed `vizserve_pms_`

**Nothing blocks Phase 0 now.** The remaining open questions (Q4–Q10) affect later phases and can be answered as those phases approach.

## Two things `P0-03` must not skip

Dual auth is more work than either provider alone, and both of these are easy to defer into a bug:

1. **Identity linking.** Sign in with Entra on Monday and email/password on Tuesday and Supabase can create two `auth.users` rows for the same human. Match on verified email; never let a duplicate `vizserve_pms_users` profile appear.
2. **Password policy and reset flow.** Enabling email/password means owning these. Entra does not absorb them.
