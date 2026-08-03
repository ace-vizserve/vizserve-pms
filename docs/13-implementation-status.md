# Implementation Status

**As of 3 August 2026.** What is actually built, what is deliberately absent, and what is owed. Read this before assuming a feature exists or is missing.

The phase docs (`04`–`09`) remain the *specification*. This document is the *state*.

---

## Summary

| Phase | State |
|---|---|
| **0 — Foundation** | Code complete. Two exit criteria need a human: a real Entra sign-in, and a test email confirmed in an inbox |
| **1 — Forms** | Code complete, including attachments. **Migration pending application** |
| **2 — Approval Engine + Gate 1** | Code complete. **Migration pending application** |
| **3–6** | Not started |

### ⚠️ Two migrations are written but not applied

```
supabase/migrations/20260803100000_p1_09_attachments.sql
supabase/migrations/20260803110000_p2_00_approval_engine.sql
```

The Supabase CLI is not linked to this project and no database password is available in the environment, so `npm run db:push` cannot run. Apply them **in that order** through the dashboard SQL editor, the same way `seed-dev.sql` is applied.

Until then, 31 tests **skip with a printed reason** rather than failing — `tests/db/attachments.test.ts` and `tests/db/approval-engine.test.ts` both detect the missing tables and say so. A skipped security suite reporting green is the failure mode that matters here, so they announce themselves.

**Phases 3–6 all extend `vizserve_pms_tasks`, which the Phase 2 migration creates.** Apply and verify before building on it.

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
| P1-09 | Attachment upload | ✅ Two-step receipt handshake — see below. ⚠️ **migration pending** |
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
| P2-06 | Target list selection | ❌ **Deferred to Phase 3**, which creates `vizserve_pms_lists` (`P3-01`). Resolves `Q18` |
| P2-07 | Approve action | ✅ One plpgsql function, one transaction |
| P2-08/09 | Return + reject | ✅ Reason enforced in engine, in a table constraint, and in the zod contract |
| P2-10 | Pending approvals queue | ✅ `/requests?status=PENDING_REVIEW`, sorted by target date, overdue distinct |
| P2-11 | Dashboard shortcut | ✅ Already linked there |
| P2-12 | Notifications | ✅ PIC on assignment, QA at assignment time, requester emailed on any decision |
| P2-13 | Authorization tests | ✅ Written, skipping until the migration is applied |

### Exit criteria — all written, all pending the migration

- [ ] The engine is generic — a throwaway second request type routes through it without engine changes
- [ ] The capacity panel shows live per-assignee load on the review screen
- [ ] Approving with an adjusted date stores both dates and creates a task due on the adjusted one
- [ ] Return and reject refuse to submit without a reason; the reason reaches the requester
- [ ] Approval is atomic — a forced mid-transaction failure leaves no partial state
- [ ] PIC and QA are both set and both notified
- [ ] Cross-department authorization tests green

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

## The grants incident — worth not repeating

Sign-in and seeding both failed with `permission denied for table vizserve_pms_users`, *after* RLS had been written and applied.

**Two independent gates guard a Supabase table: privileges, then row policies.** The service role bypasses *policies* but still needs *privileges*. The original `P0-06` migration revoked from `anon` and assumed Supabase's defaults covered `authenticated` and `service_role`. They did not apply — so no role could reach any table.

Fixed by `20260729110000_p0_06_grants.sql`, which grants explicitly and sets `ALTER DEFAULT PRIVILEGES` so later migrations inherit it.

**The diagnostic to remember:** a failing policy returns **zero rows**; a missing grant says **`permission denied`**. The scope suite now asserts on that distinction directly, so a regression names itself.

---

## Known gaps and traps

- **Two migrations are unapplied.** See the top of this document. Everything else here assumes they land.
- **Entra SSO is untested.** The code path exists; no Entra tenant has been pointed at it, and identity linking is a **project setting**, not something a migration can enforce.
- **Nobody has confirmed an email arriving.** `EMAIL_TEST_RECIPIENT=you@… npm run email:test` sends one through the real template. P4-14 repeats it against a client-domain address early in Phase 4 — that is the one item where a late failure has no workaround.
- **`lib/database.types.ts` is hand-written**, not generated. It has now drifted-and-been-corrected twice (the P1-15 tables, then the P1-09 and P2 tables), each time caught by `tsc` rather than at runtime. Regenerate with `npm run db:types` once Docker is available and treat the generated file as authoritative.
- **`npm run seed` creates 15 accounts, not 16.** Earlier docs said 16. The scope suite checks for the accounts it needs **by name** rather than by count, so adding one does not fail a test for no reason.
- **Port 3000 is the HFSE SIS app** on this machine. Use `PORT=3177`. A smoke test against 3000 hits SIS, whose login page also says "Welcome back".
- **OneDrive corrupts `node_modules`** — it produced a stub `supabase.exe` and a truncated file inside `next` that failed the build.
- **`supabase/{client,server,middleware}.ts`** are orphaned boilerplate. Nothing imports them. The real clients are in `utils/supabase/`.
- **The auth gate is `proxy.ts`, not `middleware.ts`.** Next 16 renamed the convention and the export is `proxy`.
- **`server-only` is stubbed under vitest** (`tests/stubs/`). It has no runtime module — it is a build-time poison pill. `next build` still enforces it for real.

---

## Recommended next step

**Apply the two pending migrations, then run `npm run test`.**

Phase 2's seven exit criteria are all written as assertions and none of them have been allowed to run. Phase 3 extends `vizserve_pms_tasks`, which those migrations create — so any error in them propagates into every later migration, and the further the build goes the more expensive that is to unpick.
