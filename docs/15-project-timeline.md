# Project Timeline — VizServe PMS

Sprint-by-sprint, for the ClickUp Gantt. Every row is a task you can paste in with a name that says what was actually done, its dependency, its owner and its state as of **4 August 2026**.

**A warning about the dates.** [03-roadmap.md](03-roadmap.md) is the plan of record and it deliberately has **no dates** — phases are ordered and sized against each other with binary exit criteria, because velocity was genuinely unknown with Kurt splitting time on GHL. So:

- **Sprints 1–5 are a record.** Those dates happened.
- **Sprints 6 onward are estimates** added for the chart. If one slips, move the bar — do not start the next in parallel to catch up (`R7`).

Sprints 1–5 ran hot because the build was AI-assisted. **Do not use them to size Sprints 7–10.** Forward sprints are planned at one week, which is the honest number for two people already carrying GHL, SIS and HFSE delivery work.

**Owner column:** Ace owns everything from the API contract down — migrations, RLS, Postgres functions, state machines, server actions, cron, tests. Kurt owns everything above it — screens, components, email templates, navigation.

---

## Milestones

| # | Milestone | What it means in practice | Status |
|---|---|---|---|
| M1 | Foundation | Anyone can log in; roles and scope proven by test | ✅ 3 Aug |
| M2 | Client intake live | A client submits a request with no account | ✅ 3 Aug |
| M3 | Gate 1 live | Work is assessed for load before anyone starts it | ✅ 4 Aug |
| M4 | Work is trackable | Tasks, QA hand-off, the resolution gate | ✅ 4 Aug |
| M5 | Gate 3 built | Client approves by email link, no login | ✅ 4 Aug |
| **M6** | **First real client request** | Deliverability verified; one live request end to end | ⛔ blocked on B1 |
| M7 | Teams Approvals retired | DTR + internal approvals in production | Sprint 8 |
| M8 | ClickUp cancelled | Timesheet, reporting, cutover complete | Sprint 10 |

> **M6 is the commercial line.** Everything before it reorganises internal work. M6 is the first point the platform does something the team was paying another vendor for.

---

## Sprint 1 — Foundation · ✅ *29 Jul – 1 Aug*

*Nothing else can be scoped or tested without this. Amier, 58:20: "prerequisite nyan, yung login, yung role, yung user."*

| Task | Depends on | Owner | Est. | Status |
|---|---|---|---|---|
| Scaffold Next.js 16 + Supabase, agree the `vizserve_pms_` prefix rule | — | Ace | 1d | ✅ |
| Build department, user and role schema with the inclusive hierarchy | Scaffold | Ace | 1d | ✅ |
| Wire Entra SSO and email/password to one profile | Schema | Kurt | 2d | ⚠️ built, **Entra never exercised** |
| Write the single authorization layer (`lib/auth/authorization.ts`) | Schema | Ace | 1d | ✅ |
| Turn on RLS for every table and add the explicit GRANTs | Authz layer | Ace | 2d | ✅ |
| Build the app shell and role-filtered navigation | SSO | Kurt | 1d | ✅ |
| Build the dashboard skeleton with real pending counts | App shell | Kurt | 1d | ✅ |
| Add the audit log primitive and call it on every mutation | Schema | Ace | 0.5d | ✅ |
| Add notifications, the per-type email switch and the inbox | Schema | Ace | 1d | ✅ |
| Build the admin user management screens | RLS | Kurt | 1d | ✅ |
| Seed 15 test accounts and write the scope test suite | RLS | Ace | 2d | ✅ |

**Sprint outcome.** Four roles exist, the nav differs per role, and scope is proven by test rather than by clicking. The headline assertion: a member who rewrites their own `user_metadata.role` to `admin` still sees exactly one row.

---

## Sprint 2 — Client intake · ✅ *29 Jul – 4 Aug*

*The public, unauthenticated surface. Amier, 48:25: "pagpasok pa lang ng request, dapat kumpleto na."*

| Task | Depends on | Owner | Est. | Status |
|---|---|---|---|---|
| Build the forms and form_fields schema with the immutability guards | RLS | Ace | 1d | ✅ |
| Build the requests and attachments schema, both dates from day one | Forms schema | Ace | 1d | ✅ |
| Build the drag-free form builder with archive-not-delete | Forms schema | Kurt | 3d | ✅ |
| Build form settings and block publishing without a department | Builder | Kurt | 1d | ✅ |
| Build the forms list | Builder | Kurt | 0.5d | ✅ |
| Build the public form page at `/f/[slug]`, no session | Requests schema | Kurt | 2d | ✅ |
| Write the submission function that re-derives required fields server-side | Requests schema | Ace | 2d | ✅ |
| Make requester email mandatory and not staff-editable | Submission | Ace | 0.5d | ✅ |
| Build attachment upload with the two-step receipt handshake | Submission | Ace | 2d | ✅ |
| Generate gapless reference numbers per form per year | Requests schema | Ace | 1d | ✅ |
| Start the SLA clock on submission | Submission | Ace | 0.5d | ✅ |
| Notify the owning department's Team Leaders | Notifications | Kurt | 0.5d | ✅ |
| Build the requests list with URL-driven filters | Requests schema | Kurt | 1d | ✅ |
| Build request detail, rendering archived fields with their labels | Requests list | Kurt | 1d | ✅ |
| Add rate limiting, honeypot and the file allowlist | Submission | Ace | 1d | ✅ |
| **Build two placeholder forms through the builder** | Form settings | Kurt | 0.5d | ⏳ **step 2 of the smoke test** |

**Sprint outcome.** A `curl` missing a required field is rejected by the database, proven by test. Attachments cannot name a file they did not upload.

---

## Sprint 3 — Gate 1, the Team Leader review · ✅ *3 – 4 Aug*

*Amier, 37:00: "tanggap lang ng tanggap yung mga members natin. Walang validation… kaya pa ba? Para hindi ma-burn out yung tao."*

| Task | Depends on | Owner | Est. | Status |
|---|---|---|---|---|
| **Build the generic approval engine, reusable by Phase 5** | Requests schema | Ace | 2d | ✅ |
| Build the TL review screen | Engine | Kurt | 2d | ✅ |
| **Build the capacity query and panel — load visible at decision time** | Engine | Ace + Kurt | 2d | ✅ |
| Allow the TL to adjust the date and fix typos, all audited | Review screen | Ace | 1d | ✅ |
| Add PIC and QA selectors, QA defaulting to the approving TL | Review screen | Kurt | 1d | ✅ |
| Add target list selection | Lists (Sprint 4) | Ace | 0.5d | ✅ *(waited on lists — Q18)* |
| **Write the atomic approve transaction — request, task, audit, notify** | Engine | Ace | 2d | ✅ |
| Build return and reject with a mandatory reason emailed to the client | Engine | Ace | 1d | ✅ |
| Sort the pending queue by target date, overdue distinct | Requests list | Kurt | 0.5d | ✅ |
| Point the dashboard card at the queue | Dashboard | Kurt | 0.5d | ✅ |
| Notify PIC and QA on assignment | Notifications | Kurt | 0.5d | ✅ |
| Write the cross-department authorization tests | Approve transaction | Ace | 1d | ✅ |

**Sprint outcome.** The engine is generic — a throwaway entity type routes through it end to end with no engine change, which is what makes Sprint 8 a new form rather than a new engine. Approving with an adjusted date keeps both, and that delta is the only evidence the gate negotiates rather than rubber-stamps.

---

## Sprint 4 — Tasks and internal QA · ✅ *3 – 4 Aug*

*The largest phase in the plan. Amier corrected the Miro board live at 42:20 — `Completed` comes after the client signs off, not before.*

| Task | Depends on | Owner | Est. | Status |
|---|---|---|---|---|
| Build department-scoped lists and their management screen | RLS | Ace + Kurt | 1.5d | ✅ |
| Build the tasks and status-history schema | Approve transaction | Ace | 1.5d | ✅ |
| **Build the status machine and revoke UPDATE on the status column** | Tasks schema | Ace | 2d | ✅ |
| **Gate `FOR_QA` on a non-empty resolution, in the database** | Status machine | Ace | 0.5d | ✅ |
| Build the task list with Mine and Waiting-on-my-QA views | Tasks schema | Kurt | 2d | ✅ |
| Build task detail, showing the client's specs beside the work | Task list | Kurt | 2d | ✅ |
| Serve the QA screen from the task detail page | Task detail | Kurt | 1d | ✅ |
| Build QA pass and QA reject with a mandatory comment | Status machine | Ace | 1d | ✅ |
| Add `WAITING_FOR_INFO` and derive its duration from history | Status machine | Ace | 1d | ✅ |
| Allow manual task creation with no request behind it | Tasks schema | Kurt | 1d | ✅ |
| Add task output files for the PIC | Attachments | Ace | 1d | ✅ |
| Add My Tasks to the dashboard | Task list | Kurt | 0.5d | ✅ |
| Build the board view, deliberately without drag-and-drop | Task list | Kurt | 1.5d | ✅ |
| Write the task scope tests | Status machine | Ace | 1.5d | ✅ |

**Sprint outcome.** `status` is not an updatable column, so the state machine is the only door — a PIC updating it directly leaves the task where it was. Every illegal transition is refused server-side.

---

## Sprint 5 — Gate 3, client approval · ✅ *4 Aug*

*The riskiest surface in the build: a public URL that changes state with no session.*

| Task | Depends on | Owner | Est. | Status |
|---|---|---|---|---|
| Build the token and client-decision schema, storing only hashes | Tasks schema | Ace | 1d | ✅ |
| Issue a token when QA passes | Token schema | Ace | 0.5d | ✅ |
| Write the approval email with the deadline stated prominently | Email outbox | Kurt | 1d | ✅ |
| Build the public approval page showing work beside the original brief | Token schema | Kurt | 2d | ✅ |
| Write the decision handler — validate, record, transition, consume | Token schema | Ace | 1.5d | ✅ |
| Build the approve and request-changes paths | Decision handler | Ace | 1d | ✅ |
| Send two reminder emails before anything closes itself | Token issuance | Kurt | 1d | ✅ |
| Build the hourly auto-complete job | Token issuance | Ace | 1d | ✅ |
| Send a feedback request on every completion | Approve path | Kurt | 0.5d | ✅ |
| Store feedback and make it queryable per department | Feedback request | Ace | 0.5d | ✅ |
| Archive the request with a final audit entry | Approve path | Ace | 0.5d | ✅ |
| **Write the security tests — reuse, replay, expiry, forgery** | Decision handler | Ace | 2d | ✅ 31 tests |
| **Verify deliverability against real mail domains** | Resend account | Kurt | 1d | ⛔ **BLOCKED — B1** |

**Sprint outcome.** Only the hash is stored, so a database leak yields no working links. A staff member cannot mint a token, so nobody approves their own work as the client.

---

## Sprint 6 — Verification and launch prep · ⏳ **← we are here**

*No new features. This sprint exists because 254 automated tests prove the database is the enforcement layer and not one of them opens a browser.*

| Task | Depends on | Owner | Est. | Status |
|---|---|---|---|---|
| **B1 · Create the Resend account and verify the sending domain (SPF/DKIM/DMARC)** | — | Amier | 1d + DNS wait | ⛔ **start first** |
| **B3 · Walk the browser smoke test** ([14-smoke-test.md](14-smoke-test.md)) | — | Ace + Kurt | 1d | ⏳ |
| Build two placeholder forms through the builder | Smoke test | Kurt | 0.5d | ⏳ |
| **B2 · Point an Entra tenant at `/login` and confirm one sign-in** | — | Amier / IT | 0.5d | ⏳ |
| Send a test email and confirm it lands in an inbox, not spam | B1 | Kurt | 0.5d | ⏳ |
| Fix whatever the smoke test finds | B3 | Both | 1–2d | ⏳ |
| Run one live client request end to end → **M6** | B1, B3 | Both | 0.5d | ⏳ |

> **B1 has an external dependency.** DNS records have to be created and then propagate, so it is the item most likely to sit waiting on somebody else. Start it before the smoke test, not after.

---

## Sprint 7 — DTR · ⏳ *~1 week*

*Retires the timekeeping half of Teams. Amier, 19:10–21:00. The date logic is the hard part.*

| Task | Depends on | Owner | Est. |
|---|---|---|---|
| **Decide Q4 (punch constraints) and Q8 (does anyone work past midnight?)** | — | Amier | 0.5d |
| Extend `lib/dates.ts` for work-date normalisation, with tests | Q4/Q8 | Ace | 1d |
| Build the DTR schema, one row per person per work date | Q4/Q8 | Ace | 1d |
| Implement punch logic — earliest in wins, latest out wins | DTR schema | Ace | 2d |
| Add the dashboard punch shortcut | Punch logic | Kurt | 0.5d |
| Build the DTR list view, department- and role-scoped | Punch logic | Kurt | 1.5d |
| Build the payroll export as xlsx | Punch logic | Ace | 1d |

> **No date library.** `lib/dates.ts` only — house rule, and business-day maths already lives there from Sprint 5.

---

## Sprint 8 — Internal approvals · ⏳ *~1 week* → **M7**

*Four new request types on the Sprint 3 engine. If this sprint finds itself rebuilding approve/return/reject, the abstraction failed and that is the bug to fix.*

| Task | Depends on | Owner | Est. |
|---|---|---|---|
| Build the internal requests schema | Approval engine | Ace | 1d |
| Route internal requests to the requester's department leads | Internal schema | Ace | 1d |
| Wire approve and reject onto the existing engine | Routing | Ace | 1d |
| **Write an approved No Time-In back into the DTR record** | Punch logic | Ace | 1.5d |
| Build the four request forms — leave, no time-in, no time-out, reimbursement | Internal schema | Kurt | 2d |
| Build the approvals list — mine, and pending my approval | Routing | Kurt | 1d |
| Write the internal approval scope tests | Routing | Ace | 1d |

> **No leave-balance logic.** Amier, 22:40 — HR counts manually for now, and this is the single easiest place for scope to explode. Keep it waved off.

---

## Sprint 9 — Timesheet and reporting · ⏳ *~1 week*

| Task | Depends on | Owner | Est. |
|---|---|---|---|
| Build the timesheet schema with `task_id NOT NULL` | Tasks schema | Ace | 0.5d |
| Build timesheet entry against a task chosen from a list | Timesheet schema | Kurt | 2d |
| Build the week view | Timesheet entry | Kurt | 1.5d |
| Report turnaround time per request | Archive | Ace | 1.5d |
| Report negotiated vs original dates, and approved vs auto-completed | Client decisions | Ace | 1d |
| Build the reporting dashboards | Turnaround | Kurt | 2d |
| Build the feedback report per form and department | Feedback storage | Kurt | 1d |

> `task_id NOT NULL` **is** the timesheet feature. Amier, 33:20: time is logged against a task from a list, never free text.

---

## Sprint 10 — Cutover · ⏳ *~1 week* → **M8**

| Task | Depends on | Owner | Est. |
|---|---|---|---|
| Make archived requests queryable | Archive | Ace | 1d |
| Build the exports | Reporting | Ace | 1d |
| **Write the ClickUp migration and cutover plan** | Reporting | Both | 1d |
| Migrate live ClickUp data | Cutover plan | Both | 2d |
| Run both systems in parallel for one week | Migration | Both | 1w |
| **Cancel the ClickUp subscription** | Parallel run | Amier | — |

---

## Blockers

| # | Blocker | Blocks | Owner |
|---|---|---|---|
| **B1** | Resend account + verified sending domain | Sprint 5's last task, **M6**, every email in the system | Amier |
| **B2** | Entra tenant pointed at `/login`, one sign-in confirmed | Sprint 1's SSO task | Amier / IT |
| **B3** | Browser smoke test walked | Confidence in Sprints 1–5 | Ace + Kurt |

Until B1 lands the system runs in **dry-run**: it renders every email, logs the subject and sends nothing. Gate 1 decisions, Gate 3 approvals, reminders and feedback are all silent.

---

## Gantt shape

```
Sprint 1  Foundation        ▓▓▓▓         ✅
Sprint 2  Client intake     ▓▓▓▓▓▓       ✅
Sprint 3  Gate 1                ▓▓▓      ✅
Sprint 4  Tasks + QA            ▓▓▓▓     ✅
Sprint 5  Gate 3                  ▓▓▓    ✅ (P4-14 outstanding)
B1 Resend                    ═══════════ START NOW — external DNS wait
Sprint 6  Verification              ▓▓▓  ← we are here
M6 First live request                  ◆
Sprint 7  DTR                          ▓▓▓▓▓
Sprint 8  Internal approvals                ▓▓▓▓▓  ◆ M7
Sprint 9  Timesheet + reporting                  ▓▓▓▓▓
Sprint 10 Cutover                                     ▓▓▓▓▓  ◆ M8
```

**Two arrows worth drawing**, because they are the ones that bite:

- **B1 → M6.** No amount of Sprint 7 or 8 progress produces a working client approval without a verified sending domain.
- **Sprint 4 → Sprint 5.** Already satisfied, but it is why Tasks was the worst place in the plan to stall.

---

## What to review at each sprint boundary

The roadmap drops dates and puts the weight on **binary exit criteria** instead. Criteria nobody looks at are decoration, so review these three and nothing else:

1. Does every exit criterion for the sprint's phase pass? ([13-implementation-status.md](13-implementation-status.md) tracks them.)
2. Is `npm run verify` green? *(254 tests as of 4 Aug.)*
3. Has anything in the blocker table moved?

A sprint whose tests are all still unwritten is not nearly done, however complete the screens look.
