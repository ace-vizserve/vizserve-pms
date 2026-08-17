# Implementation Status

**As of 4 August 2026.** What is actually built, what is deliberately absent, and what is owed. Read this before assuming a feature exists or is missing.

The phase docs (`04`–`09`) remain the *specification*. This document is the *state*.

---

## Summary

| Phase | State |
|---|---|
| **0 — Foundation** | Done, bar two things only a human can do: a real Entra sign-in, and a test email confirmed in an inbox |
| **1 — Forms** | **Done.** All exit criteria asserted and green |
| **2 — Approval Engine + Gate 1** | **Done.** All exit criteria asserted and green |
| **3 — Tasks + QA (Gate 2)** | **Done.** All exit criteria asserted and green |
| **4 — Client Approval (Gate 3)** | **Code done, exit criteria green except deliverability** — see below |
| **5 — DTR + Internal Approvals** | **Done.** The three migrations are applied and `tests/db/phase5.test.ts` passes 20/20 — the "unverified" state recorded below was true on 4 Aug and no longer is |
| **6 — Timesheet, Reporting, Archive** | **Started.** The timesheet (P6-01/02/03) is built, applied and green — 13 db cases plus 19 unit. P6-04 onward not begun |

`npm run verify` is green: **235 tests, 0 failures**, of which 150 run against a live database as genuinely signed-in users.

---

## ⚠️ Outstanding — to follow

Three things nobody can assert for you. None blocks Phase 5.

| What | Why it matters | How |
|---|---|---|
| **Resend is not configured** | `RESEND_API_KEY` and `EMAIL_FROM` are absent from `.env`, so the whole system runs in **dry-run**: it renders every email, logs the subject, and sends nothing. Every notification, every Gate 1 decision email, and the entire Gate 3 client flow are silent. | Add both to `.env.local`. The sending domain needs SPF/DKIM/DMARC before P4-14 can pass. |
| **P4-14 deliverability unverified** | Phase 4 rests entirely on one email reaching one client's inbox. If it lands in spam, a ticket auto-completes three days later with nobody having looked — and the roadmap flags this as the one item where a late failure has no workaround. | `EMAIL_TEST_RECIPIENT=you@… npm run email:test`, then check Outlook/M365, Gmail **and the client's real domain**. |
| **Entra SSO never exercised** | The code path exists; no tenant has been pointed at it. Identity linking — one human, one profile — is a **project setting**, not something a migration can enforce. | Point a tenant at `/login`, sign in once, confirm it resolves to the same profile as the password path. |

The deliverability test is opt-in (it only runs with `EMAIL_TEST_RECIPIENT` set), so it does not fail `npm run verify` — and it refuses to report success in dry-run rather than claiming a send that never happened.

### Applying migrations

The Supabase CLI is not linked to this project and no database password is in the environment, so `npm run db:push` does not work here. Migrations are applied by pasting them into the dashboard SQL editor, in filename order, the same way `seed-dev.sql` is.

Every db suite **detects whether its migration has been applied** and skips with a printed reason rather than failing — a wall of red from an unapplied migration teaches you to ignore red. The detection is a top-level `await`, not a `beforeAll`: `it.skipIf(...)` is evaluated when vitest collects the file, so a flag set in a hook is still `false` at every skip decision, and the whole suite skips silently even once the migration is in. That went wrong once already.

---

## Phase 0

| ID | Item | State |
|----|------|-------|
| P0-01 | Repo + environments | ✅ Next 16.2, React 19, TS 5, Tailwind v4, shadcn, Supabase CLI |
| P0-02 | Base schema | ✅ departments, users, managed departments, role enum, seed |
| P0-03 | Auth | ✅ Entra SSO + email/password, callback, sign-out. ⚠️ **identity linking still unverified** |
| P0-04 | User management screens | ✅ `/admin/users` — list, create, edit, deactivate, password reset |
| P0-05 | Authorization layer | ✅ `lib/auth/authorization.ts` + SQL counterparts. Hierarchy split into `lib/auth/roles.ts` so the client can import it |
| P0-06 | RLS policies | ✅ …plus a follow-up grants migration, see *The grants incident* |
| P0-07 | App shell + role nav | ✅ Unbuilt modules render disabled with their phase |
| P0-08 | Dashboard | ✅ Pending-approvals and unread counts are real; tickets card is a placeholder until Phase 3 |
| P0-09 | Audit log | ✅ Table + `vizserve_pms_write_audit_log()`. Called on submission, user create/edit, and every Gate 1 decision |
| P0-10 | Notifications + inbox | ✅ Table, per-type `send_email` settings, `vizserve_pms_notify()`, `/inbox` |
| P0-11 | Transactional email | ✅ Outbox drain + cron + templates. ⚠️ **nobody has confirmed one landing in an inbox** |
| P0-12 | Seed + scope tests | ✅ 15 accounts seeded; the scope suite is written and green |

### Exit criteria

- [x] A user can log in and land on a dashboard
- [x] All four roles exist and the nav renders differently for each
- [ ] Both auth paths work and resolve to one profile — **email/password verified; Entra untested**
- [x] Scope proven **by test** — `tests/db/scope.test.ts`, green against a live database
- [x] Every table and enum carries the prefix; RLS on; wrong-role queries return zero rows
- [x] An audit row is written on user create/edit
- [ ] A test email lands in an inbox — **`npm run email:test` sends it; someone has to look**

---

## Phase 1

| ID | Item | State |
|----|------|-------|
| P1-01 | forms + form_fields migration | ✅ Includes `reference_prefix`, `is_active`, and the R5 guard triggers |
| P1-02 | requests + attachments migration | ✅ Both `target_date` and `approved_target_date` from the start |
| P1-03 | Form builder UI | ✅ Add/edit/reorder/archive. Reorder is up/down buttons, not drag |
| P1-04 | Form settings | ✅ Publishing blocked without a department (UI + DB `CHECK`) |
| P1-05 | Forms list | ✅ |
| P1-06 | Public form page | ✅ `/f/[slug]`, no session |
| P1-07 | Submission endpoint | ✅ `SECURITY DEFINER`, server-side validation, structured field errors |
| P1-08 | Requester identity capture | ✅ Email mandatory, not staff-editable |
| P1-09 | Attachment upload | ✅ Two-step receipt handshake — see below |
| P1-10 | Reference numbers | ✅ `COL-2026-0142`, gapless per form per year |
| P1-11 | SLA timer | ✅ `sla_started_at` set on submission. Nothing consumes it yet |
| P1-12 | TL notification | ✅ Notification row **and** email, now that P0-11 is wired |
| P1-13 | Requests list | ✅ URL-based filters, server-side, sorted by target date |
| P1-14 | Request detail | ✅ Renders archived fields with their labels; attachments download via signed URL |
| P1-15 | Abuse controls | ✅ Rate limit, honeypot, plus the P1-09 size/MIME/magic-number checks |
| P1-16 | Placeholder forms | 🟡 `seed-dev.sql` seeds one. Exit criterion needs one built **through the builder** |

### Exit criteria

- [x] A form can be built, published, and reached at a public URL with no session
- [x] A `curl` missing a required field is rejected — asserted in `tests/db/submission.test.ts`
- [x] A complete submission creates a request, gets a reference number, starts the SLA timer
- [x] The request appears in exactly one TL queue — asserted at the API layer
- [ ] Two placeholder forms exist *(one seeded; the builder path is still unproven)*
- [x] Two forms cannot mint the same reference number — `P1-10` collision, found and fixed
- [x] Rate limiting demonstrably blocks a flood — asserted for both the IP and email ceilings
- [x] A field can be renamed without breaking existing requests; a field with data cannot be hard-deleted

---

## Phase 2

| ID | Item | State |
|----|------|-------|
| P2-00 | Generic approval engine | ✅ `vizserve_pms_record_decision` + `vizserve_pms_approvals` |
| P2-01 | TL review screen | ✅ On the request detail page, only while `PENDING_REVIEW` |
| P2-02 | Capacity panel | ✅ Query + UI. Leads with "due before this date", not raw open count |
| P2-03 | Edit-before-approve | ✅ Date, title and description, all audited with before/after |
| P2-04/05 | PIC + QA selectors | ✅ QA defaults to the approving TL, overridable |
| P2-06 | Target list selection | ✅ Landed once `vizserve_pms_lists` existed. Resolves `Q18` |
| P2-07 | Approve action | ✅ One plpgsql function, one transaction |
| P2-08/09 | Return + reject | ✅ Reason enforced in engine, in a table constraint, and in the zod contract |
| P2-10 | Pending approvals queue | ✅ `/requests?status=PENDING_REVIEW`, sorted by target date, overdue distinct |
| P2-11 | Dashboard shortcut | ✅ Already linked there |
| P2-12 | Notifications | ✅ PIC on assignment, QA at assignment time, requester emailed on any decision |
| P2-13 | Authorization tests | ✅ Green |

### Exit criteria — all green

- [x] The engine is generic — a throwaway `rehearsal_widget` routes through it end to end, gets audited, and inherits the reason rule and department scope, with no engine change
- [x] The capacity panel shows live per-assignee load on the review screen
- [x] Approving with an adjusted date stores both dates and creates a task due on the adjusted one
- [x] Return and reject refuse to submit without a reason; the reason reaches the requester
- [x] Approval is atomic — asserted by forcing a failure at the LAST check, after the engine has written an approval row and the status update would have run
- [x] PIC and QA are both set and both notified
- [x] Cross-department authorization tests green

---

## Phase 3

| ID | Item | State |
|----|------|-------|
| P3-01 | Lists + CRUD | ✅ Department-scoped, managed at `/tasks/lists`. Resolves `Q18`, unblocks `P2-06` |
| P3-02 | tasks + status history migration | ✅ |
| P3-03 | Task list view | ✅ URL filters, plus Mine and Waiting-on-my-QA views |
| P3-04 | Board view | ✅ `/tasks/board`. **No drag-and-drop** — see decision 14 |
| P3-05 | Task detail | ✅ Also serves as the QA screen (`P3-08`) |
| P3-06 | Status machine | ✅ `status` is not an updatable column — see decision 13 |
| P3-07 | Resolution gate | ✅ Enforced in the transition function; no path skips it |
| P3-09/10 | QA pass + reject | ✅ Reject requires a comment; it reaches the PIC |
| P3-11 | `WAITING_FOR_INFO` | ✅ Duration derived from history, never stored (`R4`) |
| P3-12 | Manual task creation | ✅ |
| P3-13 | Task attachments | ✅ No receipt handshake — see decision 15 |
| P3-14 | My tasks + dashboard card | ✅ |
| P3-15 | Scope tests | ✅ 41 tests green |

### Exit criteria — all green

- [x] Every legal transition works; every illegal one is rejected server-side
- [x] A direct API call cannot reach `FOR_QA` with an empty resolution
- [x] QA rejection returns to `ONGOING` with the comment visible to the PIC
- [x] Task list columns reflect the originating form's fields
- [x] Tasks can be created manually, without a request
- [x] `WAITING_FOR_INFO` duration is queryable per task

---

## Phase 4

| ID | Item | State |
|----|------|-------|
| P4-01 | Token + decisions migration | ✅ Hash-only storage, bound email, expiry, `consumed_at` |
| P4-02 | Token issuance | ✅ Hangs off the `QA_IN_PROGRESS → FOR_CLIENT_APPROVAL` transition |
| P4-03 | Approval email | ✅ Deadline stated prominently, per Amier 54:00 |
| P4-04 | Public approval page | ✅ `/approve/[token]`, no session. Original specs shown alongside the output |
| P4-05/06/07 | Decision handler + paths | ✅ |
| P4-08 | Reminder emails | ✅ Two, sent before anything auto-completes, in the same cron pass |
| P4-09 | Auto-complete job | ✅ Hourly. `COMPLETED_NO_RESPONSE`, never `COMPLETED` |
| P4-10 | Feedback request | ✅ On every completion, including auto-completed ones |
| P4-11 | Feedback storage | ✅ One per task, readable by the department's lead |
| P4-12 | Archive + final audit | ✅ Every decision writes an audit row with before/after |
| P4-13 | Security tests | ✅ 31 tests green |
| P4-14 | Deliverability check | ❌ **Outstanding** — see the table at the top |

### Exit criteria

- [x] A client receives an email, clicks, and approves without logging in *(verified end to end in dry-run; the send itself waits on Resend)*
- [x] Security tests green — cross-task reuse, replay, expiry, forged tokens, purpose confusion
- [x] Reject returns the task to `ONGOING` with the comment reaching the PIC
- [x] Reminders fire before auto-complete; auto-complete fires on schedule; the deadline is in the email body
- [x] `COMPLETED` and `COMPLETED_NO_RESPONSE` are distinguishable
- [x] Feedback goes out on every completion and results are queryable
- [ ] **Deliverability verified against the client's real mail domain**

---

## Phase 5 — DTR and Internal Approvals

**Done and verified.** *Corrected 17 Aug 2026: the three migrations are applied and `tests/db/phase5.test.ts` passes 20/20. The paragraph below described the state on 4 August.* ~~Code complete; NOT verified against a database. The three migrations below have not been applied to any project, so five of the six exit criteria are written and asserted but currently skipped.~~

| ID | Item | State |
|----|------|-------|
| P5-01 | `vizserve_pms_dtr_entries` migration | ✅ `UNIQUE (user_id, work_date)`, RLS, no INSERT/UPDATE policy |
| P5-02 | Punch endpoint | ✅ `vizserve_pms_punch` — earliest-in / latest-out, plus the Q4 guards |
| P5-03 | Dashboard punch shortcut | ✅ The Phase 0 placeholder is real now |
| P5-04 | DTR list view | ✅ `/dtr`, scoped by RLS, with a date-range filter |
| P5-05 | `vizserve_pms_internal_requests` migration | ✅ Four types, per-type CHECK constraints |
| P5-06 | Four request forms | ✅ One dialog, discriminated union |
| P5-07 | Approval routing | ✅ Department snapshotted from the requester at submission |
| P5-08 | Approve / reject | ✅ Straight onto the P2-00 engine, unchanged |
| P5-09 | Correction writes into the DTR | ✅ The only path allowed to overwrite an earliest-in |
| P5-10 | Approvals list view | ✅ `/approvals` — mine, and pending my approval |
| P5-11 | Payroll export | ✅ CSV, not `xlsx` — see below |
| P5-12 | `lib/dates.ts` work dates | ✅ Plus 17 unit tests. No date library added |

### The engine was not touched

The Phase 2 acceptance test was "a throwaway second request type routing end to end without touching engine code". Phase 5 is that test with real stakes: `vizserve_pms_decide_internal_request` calls `vizserve_pms_record_decision` exactly the way Gate 1 does, and **no line of the P2-00 engine section changed**. Scope, the mandatory reason on reject, the approval row and its audit entry all came for free.

### Exit criteria

- [x] Double punch-in does not change time-in; double punch-out does update it
- [x] An OT shift ending 01:00 lands on the prior work date
- [x] All four internal request types submit and route correctly
- [x] An approved No Time-In actually corrects the DTR record
- [x] No leave-balance logic exists anywhere — asserted by `tests/unit/no-leave-balance.test.ts`
- [x] Payroll can export a month of DTR as CSV

All six green as of 17 Aug 2026: `tests/db/phase5.test.ts` runs its 20 cases against the live project rather than skipping.

### Open questions this phase built past

- **Q4 is still unanswered.** The punch rules implement the *recommendation* in docs/09 — server timestamp authoritative, time-in always today, time-out today or yesterday-if-open, an 18-hour cut-off. Amier has confirmed none of it. Changing the answer means changing `vizserve_pms_punch` and nothing else.
- **Q8 is still unanswered.** What is built handles OT that runs late, which is the rule as stated. A *scheduled* 22:00–06:00 shift is a different model and would need the work-date rule revisited.

### Deviations worth knowing

1. **CSV, not `xlsx`.** P5-11 suggests SheetJS "same as the SIS masterfile export", but the binding exit criterion says CSV, `xlsx` is not a dependency here, and payroll opens either one in Excel. Revisit if formatting or multiple sheets are actually wanted.
2. **A new notification type needed its own migration file.** Postgres forbids *using* an enum value in the transaction that adds it, and each migration file is applied as one transaction — so `internal_decision` is added alone in `20260804151000` and first used in `20260804152000`.
3. **`internal_decision` ships email-off.** The requester is staff with an inbox, and docs/12 reserves email for people who have no other channel.

### ⚠️ Every db suite has been skipping silently

`console.warn` at module scope is **swallowed by vitest 4** — verified with a probe on both a skipped and a passing file. Every suite in `tests/db/` announces its skip reason that way, so none of those reasons has ever been printed: the suites report "skipped" with no explanation, which is the exact failure this document warns about elsewhere.

`process.stderr.write` survives. `tests/db/phase5.test.ts` uses it and prints properly; **the other eight db suites still need the same one-line change.**

---

## Phase 6 — Timesheet, Reporting, Archive

**The timesheet is built and VERIFIED against the linked project.** `tests/db/timesheet.test.ts` — 13 cases, run as genuinely signed-in users through RLS — passes, as do the 19 unit cases in `tests/unit/timesheet.test.ts` covering the week maths and the schema.

| ID | Item | State |
|----|------|-------|
| P6-01 | `vizserve_pms_timesheet_entries` migration, `task_id NOT NULL` | ✅ Plus RLS, grants, the day-total trigger |
| P6-02 | Timesheet entry UI, task picker scoped to assigned tasks | ✅ `/timesheet` — select only, no free text |
| P6-03 | Timesheet table / week view | ✅ Monday-start, week in the URL, edit in place |
| P6-04 | Turnaround time reporting | ⛔ Not started |
| P6-05 | Status/volume dashboards per department | ⛔ Not started |
| P6-06 | Negotiation and auto-complete split reports | ⛔ Not started |
| P6-07 | Feedback results report | ⛔ Not started |
| P6-08 | Archive | ⛔ Not started |
| P6-09 | CSV export across reports | ⛔ Not started |
| P6-10 | ClickUp migration + cutover | ⛔ Not started |

**This migration does not depend on Phase 5.** It references `vizserve_pms_tasks`, `vizserve_pms_users`, `vizserve_pms_manages_department` and `vizserve_pms_set_updated_at` — all Phase 0–3.

### ⚠️ The table was applied by paste, so `db:push` and the database disagree

`vizserve_pms_timesheet_entries` is live in the project and the suite passes against it, but the migration went in through the dashboard SQL editor (§ *Applying migrations*), which does not write to `supabase_migrations.schema_migrations`. A future `npm run db:push` will therefore try to `create table` something that already exists and stop on it — the same trap applies to the Phase 5 three, which are also live and also unrecorded. Either record them as applied (`supabase migration repair --status applied <version>`) or expect to skip past them by hand. **Do not "fix" this by adding `if not exists`**: that turns a loud, correct failure into a migration that silently does nothing when the shapes have drifted.

### The one constraint that is the feature

`task_id NOT NULL` is the rule (Amier 33:20, *"hindi ka rin pwede-pwede mag-log ng gusto mo"*), and it is enforced three deep on purpose:

1. **The column.** No default, not nullable.
2. **`vizserve_pms_may_log_time(task_id, auth.uid())` inside the INSERT and UPDATE policies.** Not just "a task" — a task you are the PIC or the QA reviewer on. A lead who did not do the work cannot book hours to it; if they did do the work, the fix is to assign it to them, which is worth recording anyway.
3. **The zod type is non-optional**, so logging without a task fails to compile rather than at runtime.

### Deviations worth knowing

1. **Durations, not intervals.** An entry is "90 minutes on this task on this day", not a start and an end. The DTR already owns when somebody was at work; two tables both claiming to know that is two tables that will disagree. This one answers where the day went.
2. **Minutes, not decimal hours.** 7.4 hours is ambiguous between 7h24 and 7h40, and rounding it through a week's totals is how a timesheet stops adding up. The UI takes hours and minutes as two fields for the same reason.
3. **Several entries per task per day are allowed** — no unique key. An hour before lunch and two after is two facts with two notes, and the notes are the part a reviewer reads.
4. **The 24-hour day cap is a trigger, not a CHECK.** The rule spans rows: a CHECK sees only the row in front of it, and the way this goes wrong is six plausible entries totalling thirty hours. The trigger locks the day's rows before summing — without `FOR UPDATE` two concurrent inserts each read a total excluding the other and both pass.
5. **First person only.** A department lead can READ their team's entries and cannot write them. Hours somebody else entered under your name are not your hours.
6. **No person picker on `/timesheet`.** RLS would allow a lead to read a team member's week, but reading a team's week is a reporting question (P6-05). Answering half of it inside the entry screen produces a report nobody trusts because it is also an editor.

### Exit criteria

- [x] Time cannot be logged without a task — asserted in `tests/unit/timesheet.test.ts` and, against the live database, in `tests/db/timesheet.test.ts`
- [ ] All seven metrics reportable with a date range — P6-04/06/07 not started
- [ ] Archived requests remain queryable — P6-08 not started
- [ ] A written cutover plan exists — P6-10 not started

### `lib/database.types.ts` was hand-edited

The table was added by hand, in the same style as the note at the top of that file: hand-written until a database is reachable. **Re-run `npm run db:types` once the migration is applied** and treat the generated file as authoritative from that point.

---

## Decisions taken during the build

Recorded here because they are not in the phase docs and would otherwise look arbitrary.

1. **`forms.reference_prefix` added.** `P1-10` specifies `COL-2026-0142` but the data model had no column to hold `COL`.
2. **Rate limiting is Postgres-backed**, not Redis/Upstash. Adds no vendor, no key to rotate, nothing extra to be down.
3. **Reference numbers use a counter table, not a sequence.** A sequence leaves gaps on rollback, and a client quoting `COL-2026-0142` to a colleague who sees `0141` then `0143` asks why.
4. **`forms.default_list_id` omitted**, and `P2-06` deferred with it. Both wait on `vizserve_pms_lists` in Phase 3. See `Q18`.
5. **Request status starts at `PENDING_REVIEW`.** `DRAFT` and `SUBMITTED` are unreachable in Phase 1 and stay in the enum because the canonical set is fixed.
6. **`Date` parsing uses midday UTC** for bare `YYYY-MM-DD`. Midnight lands on the previous calendar day in any negative offset.
7. **No shared `<DataTable>` yet.** Three list views are now hand-rolled. Still owed; extracting it from one consumer guesses at the abstraction.
8. **Email is an outbox, not a send-at-write-time call.** The Phase 1 submission path runs inside Postgres and cannot call Resend, so a notification written there could never be emailed by code above it. `emailed_at` doubles as the claim, so overlapping cron runs cannot double-send.
9. **Attachments use a two-step receipt handshake.** The old `attachmentRefSchema` carried a client-supplied `storage_path`, which on a session-less public form would let a submission attach any object in the bucket. Uploads now go to a server action that measures the real bytes and writes a pending row; the submission sends only that row's id. A fabricated path is unrepresentable rather than merely rejected.
10. **`image/svg+xml` is not in the upload allowlist.** An SVG is a script container; one served inline from the storage origin is stored XSS against that origin.
11. **The tasks table is created in Phase 2, not Phase 3.** `P2-07` has nothing to approve into otherwise. Phase 2 only ever creates rows in `OPEN`; Phase 3 owns the transition machine and the screens.
12. **`lib/auth/roles.ts` split out of `authorization.ts`.** The latter is `server-only`, but a role selector and a zod schema need the ordering on the client, and a second hand-written copy of the list is how the TS `>=` and the Postgres `>=` drift into disagreeing.

---

13. **`vizserve_pms_tasks.status` is not an updatable column.** RLS lets the PIC update their own task and cannot express "but not that column"; column privileges can. The table-level UPDATE grant is revoked and replaced with per-column grants that omit `status`, so the only path is `vizserve_pms_transition_task`. Without it the whole state machine is one `PATCH` away from irrelevant.
14. **The board has no drag-and-drop.** A card dragged between columns *is* a status transition, and half of them need a comment or a resolution first — so a drag would either pop a modal, which is worse than a button, or fail silently against the state machine, which is worse still.
15. **Task attachments use no receipt handshake, unlike request attachments.** The public form needs one because a session-less caller must be *told* which file their earlier upload produced, and anything it is told can be forged. A staff upload is authenticated and the upload *is* the commit — there is no gap for a forged path to live in.
16. **Q6 answered: business days.** On calendar days a ticket sent Friday 5pm closes Monday 5pm, having given the client roughly one working day. The database computes the deadline the cron enforces; `lib/dates.ts` mirrors it for display and a test asserts the holiday lists agree.
17. **Q7 answered: accept the forwarding limit, plus a typed name.** Email forwarding defeats email-based identity and no amount of code changes that. A one-time code was rejected — it adds friction to the exact step the gate exists to make frictionless, and should wait for a dispute that actually happens.

---

## The grants incident — worth not repeating

Sign-in and seeding both failed with `permission denied for table vizserve_pms_users`, *after* RLS had been written and applied.

**Two independent gates guard a Supabase table: privileges, then row policies.** The service role bypasses *policies* but still needs *privileges*. The original `P0-06` migration revoked from `anon` and assumed Supabase's defaults covered `authenticated` and `service_role`. They did not apply — so no role could reach any table.

Fixed by `20260729110000_p0_06_grants.sql`, which grants explicitly and sets `ALTER DEFAULT PRIVILEGES` so later migrations inherit it.

**The diagnostic to remember:** a failing policy returns **zero rows**; a missing grant says **`permission denied`**. The scope suite now asserts on that distinction directly, so a regression names itself.

---

## Known gaps and traps

- **Entra SSO is untested.** The code path exists; no Entra tenant has been pointed at it, and identity linking is a **project setting**, not something a migration can enforce.
- **Nobody has confirmed an email arriving.** `EMAIL_TEST_RECIPIENT=you@… npm run email:test` sends one through the real template. P4-14 repeats it against a client-domain address early in Phase 4 — that is the one item where a late failure has no workaround.
- **`lib/database.types.ts` is hand-written**, not generated. It has now drifted-and-been-corrected twice (the P1-15 tables, then the P1-09 and P2 tables), each time caught by `tsc` rather than at runtime. Regenerate with `npm run db:types` once Docker is available and treat the generated file as authoritative.
- **`npm run seed` creates 15 accounts, not 16.** Earlier docs said 16. The scope suite checks for the accounts it needs **by name** rather than by count, so adding one does not fail a test for no reason.
- **Nothing sends email yet.** `resend` is wired but `RESEND_API_KEY` is unset, so the whole system runs in dry-run. See *Outstanding* at the top.
- **Port 3000 is the HFSE SIS app** on this machine. Use `PORT=3177`. A smoke test against 3000 hits SIS, whose login page also says "Welcome back".
- **OneDrive corrupts `node_modules`** — it produced a stub `supabase.exe` and a truncated file inside `next` that failed the build.
- **`supabase/{client,server,middleware}.ts`** are orphaned boilerplate. Nothing imports them. The real clients are in `utils/supabase/`.
- **The auth gate is `proxy.ts`, not `middleware.ts`.** Next 16 renamed the convention and the export is `proxy`.
- **`server-only` is stubbed under vitest** (`tests/stubs/`). It has no runtime module — it is a build-time poison pill. `next build` still enforces it for real.

---

## Recommended next step

*Superseded 17 Aug 2026 — the Phase 5 migrations are applied and their 20
assertions pass. What follows was the next step on 4 August and is kept for the
record: paste them into the dashboard SQL editor in filename order, and note
that `20260804151000_p5_05_notification_type.sql` must be its own transaction
because it adds an enum value the third file uses.*

**Q4 needs Amier.** The punch rules are built to the recommendation,
not to a confirmed decision, and the correction path is the part he has not seen
— an accidental 06:00 punch is unfixable by the person it happened to, by
design, and only a No Time-In approval can undo it. If he wants that looser, it
is a change to one function.

**Phase 6 has started.** The timesheet is built and its migration —
`20260817090000_p6_01_timesheet.sql` — is unapplied like the Phase 5 three. It
does not depend on them, so it can go in the same paste or on its own; apply it
and 16 more assertions stop skipping. Reporting, archive and the ClickUp cutover
(P6-04 onward) are the rest of the phase and have not been started.

Two things still need a human and neither blocks Phase 6:

- **Point an Entra tenant at the login and sign in once.** Identity linking is a
  project setting, not something a migration can enforce.
- **`EMAIL_TEST_RECIPIENT=you@… npm run email:test`**, then check it landed in an
  inbox rather than spam. P4-14 repeats this against a client-domain address —
  deliverability is the one item where a late failure has no workaround.
