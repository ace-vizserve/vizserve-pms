# Implementation Status

**As of 29 July 2026.** What is actually built, what is deliberately absent, and what is owed. Read this before assuming a feature exists or is missing.

The phase docs (`04`–`09`) remain the *specification*. This document is the *state*.

---

## Summary

| Phase | State |
|---|---|
| **0 — Foundation** | Built, except the `P0-12` scope test suite. **The phase cannot be called done without it** — that suite is the exit criterion |
| **1 — Forms** | Spine complete end to end. Attachments (`P1-09`) outstanding |
| **2–6** | Not started |

---

## Phase 0

| ID | Item | State |
|----|------|-------|
| P0-01 | Repo + environments | ✅ Next 16.2, React 19, TS 5, Tailwind v4, shadcn, Supabase CLI |
| P0-02 | Base schema | ✅ departments, users, managed departments, role enum, seed |
| P0-03 | Auth | ✅ Entra SSO + email/password, callback, sign-out. ⚠️ **identity linking unverified** — see below |
| P0-04 | User management screens | ❌ Not built. `/admin/users` is in the nav and **404s** |
| P0-05 | Authorization layer | ✅ `lib/auth/authorization.ts` + SQL counterparts |
| P0-06 | RLS policies | ✅ …plus a follow-up grants migration, see *The grants incident* |
| P0-07 | App shell + role nav | ✅ Unbuilt modules render disabled with their phase |
| P0-08 | Dashboard | ✅ Pending-approvals and unread counts are real; tickets card is a placeholder |
| P0-09 | Audit log | ✅ Table + `vizserve_pms_write_audit_log()`. Called on submission |
| P0-10 | Notifications + inbox | ✅ Table, per-type `send_email` settings table, `vizserve_pms_notify()`, `/inbox` |
| P0-11 | Transactional email | ❌ **Not wired.** `resend` is installed; nothing sends. Notification rows are written but no mail leaves |
| P0-12 | Seed + scope tests | 🟡 Seed done (`npm run seed`, 16 accounts). **Tests not written** |

### Exit criteria

- [x] A user can log in and land on a dashboard
- [x] All four roles exist and the nav renders differently for each
- [ ] Both auth paths work and resolve to one profile — **email/password verified; Entra untested**
- [ ] Scope proven **by test** — `P0-12` outstanding, so this is unproven
- [x] Every table and enum carries the prefix; RLS on; wrong-role queries return zero rows
- [x] An audit row is written on submission
- [ ] A test email lands in an inbox — **nothing sends yet**

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
| P1-09 | Attachment upload | ❌ **Not built.** File fields render a "not wired" placeholder |
| P1-10 | Reference numbers | ✅ `COL-2026-0142`, gapless per form per year |
| P1-11 | SLA timer | ✅ `sla_started_at` set on submission. Nothing consumes it yet |
| P1-12 | TL notification | 🟡 Notification rows written; **no email** (blocked on P0-11) |
| P1-13 | Requests list | ✅ URL-based filters, server-side |
| P1-14 | Request detail | ✅ Read-only. Renders archived fields with their labels |
| P1-15 | Abuse controls | ✅ Postgres-backed rate limit + honeypot. Size/MIME allowlist pending P1-09 |
| P1-16 | Placeholder forms | 🟡 `supabase/seed-dev.sql` seeds one. Exit criterion needs one built **through the builder** |

### Exit criteria

- [x] A form can be built, published, and reached at a public URL with no session
- [ ] A `curl` missing a required field is rejected — **the function does this; no test asserts it**
- [x] A complete submission creates a request, gets a reference number, starts the SLA timer
- [ ] The request appears in exactly one TL queue — **RLS does this; not asserted at API level**
- [x] Two placeholder forms exist *(one seeded; the builder path is unproven)*
- [ ] Rate limiting demonstrably blocks a flood — **implemented, undemonstrated**

**Pattern worth noticing:** most unmet criteria are unmet because nothing *asserts* them, not because the behaviour is absent. That is precisely what `P0-12` is for, and why it should come before Phase 2.

---

## Decisions taken during the build

Recorded here because they are not in the phase docs and would otherwise look arbitrary.

1. **`forms.reference_prefix` added.** `P1-10` specifies `COL-2026-0142` but the data model had no column to hold `COL`.
2. **Rate limiting is Postgres-backed**, not Redis/Upstash. Adds no vendor, no key to rotate, nothing extra to be down. Submission volume is tens per day. Tunable at runtime via `vizserve_pms_public_submission_limits`.
3. **Reference numbers use a counter table, not a sequence.** A sequence is concurrency-safe but leaves gaps on rollback, and a client quoting `COL-2026-0142` to a colleague who sees `0141` then `0143` asks why.
4. **`forms.default_list_id` omitted.** It is an FK to `vizserve_pms_lists`, which Phase 3 creates. See `Q18`.
5. **Request status starts at `PENDING_REVIEW`.** `DRAFT` and `SUBMITTED` are unreachable in Phase 1 — public submission is session-less, so there is nothing to draft against, and a request is pending review the instant it arrives. Both stay in the enum because the canonical set is fixed.
6. **`Date` parsing uses midday UTC** for bare `YYYY-MM-DD`. Midnight lands on the previous calendar day in any negative offset.
7. **No shared `<DataTable>` yet.** Two list views are hand-rolled. Extracting the shell from one consumer guesses at the abstraction; `P2-10` is the second and the right moment. Owed, not forgotten.
8. **Approve/Return/Reject deliberately not stubbed** on the request detail page. A disabled Approve invites someone to wire it up without the atomic task-creation transaction behind it (`R9`).

---

## The grants incident — worth not repeating

Sign-in and seeding both failed with `permission denied for table vizserve_pms_users`, *after* RLS had been written and applied.

**Two independent gates guard a Supabase table: privileges, then row policies.** The service role bypasses *policies* but still needs *privileges*. The original `P0-06` migration revoked from `anon` and assumed Supabase's default privileges covered `authenticated` and `service_role`. They did not apply — so no role could reach any table, and the app was broken for every signed-in user.

Fixed by `20260729110000_p0_06_grants.sql`, which grants explicitly and sets `ALTER DEFAULT PRIVILEGES` so later migrations inherit it.

**The diagnostic to remember:** a failing policy returns **zero rows**; a missing grant says **`permission denied`**. They are different failures and the message tells you which.

---

## Known gaps and traps

- **`/admin/users` 404s** — it is in the nav (`P0-04` unbuilt).
- **Nothing sends email.** `resend` is installed and unused.
- **Entra SSO is untested.** The code path exists; no Entra tenant has been pointed at it, and identity linking (one human, one profile) is a **project setting**, not something a migration can enforce. Verify before calling `P0-03` done.
- **`lib/database.types.ts` is hand-written**, not generated. Regenerate with `npm run db:types` once Docker is available, and treat the generated file as authoritative from then on.
- **Port 3000 is the HFSE SIS app** on this machine. Use `PORT=3177`. A smoke test against 3000 hits SIS, whose login page also says "Welcome back".
- **OneDrive corrupts `node_modules`** — it produced a stub `supabase.exe` and a truncated file inside `next` that failed the build.
- **`supabase/{client,server,middleware}.ts`** are orphaned boilerplate sitting in the Supabase CLI directory. Nothing imports them. The real clients are in `utils/supabase/`.
- **The auth gate is `proxy.ts`, not `middleware.ts`.** Next 16 renamed the convention and the export is `proxy`. Do not go looking for `middleware.ts` — it does not exist. `utils/supabase/middleware.ts` is a different thing: the session-refresh helper `proxy.ts` calls.
- **Nothing is committed yet.** The whole application is untracked in git; only the `docs/` edits show as modifications.

---

## Recommended next step

**`P0-12`, the scope test suite** — before any Phase 2 work.

Six of the eleven unmet exit criteria across Phases 0 and 1 are unmet only because nothing asserts them. The suite is also the thing most likely to be quietly broken by a later feature, and manual clicking will not catch it. Minimum assertions are listed in [04-phase-0-foundation.md](04-phase-0-foundation.md) — including the highest-value one: a member who rewrites their own `user_metadata.role` to `admin` still sees only their own rows.
