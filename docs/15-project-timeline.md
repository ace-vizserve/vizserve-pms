# Project Timeline — VizServe PMS

For the ClickUp Gantt. Every row is a task you can paste in, with its dependency and its state as of **4 August 2026**.

**A warning about the dates.** [03-roadmap.md](03-roadmap.md) is the plan of record and it deliberately has **no dates** — phases are ordered and sized relative to each other, with binary exit criteria, because velocity was genuinely unknown with Kurt splitting time on GHL. The durations below are *estimates added for the Gantt*, not commitments made in the call. Two things follow:

1. **The order is real. The dates are not.** If a phase slips, move the bar; do not start the next one in parallel to catch up (`R7`).
2. **Phases 0–4 already have actual durations**, because they are built. Those are facts. Everything from Phase 5 on is a guess.

Relative sizing from the roadmap, which is the honest signal: Phase 3 is the largest, roughly twice Phase 0. Phases 1 and 4 are large. Phases 0, 2, 5 and 6 are medium.

---

## Milestones

| Milestone | Meaning | Status |
|---|---|---|
| **M1 — Foundation** | Anyone can log in; roles and scope proven by test | ✅ 3 Aug 2026 |
| **M2 — Client intake live** | A client can submit without an account | ✅ 3 Aug 2026 |
| **M3 — Gate 1 live** | Requests are assessed before work starts | ✅ 3 Aug 2026 |
| **M4 — Work is trackable** | Tasks, QA, the resolution gate | ✅ 4 Aug 2026 |
| **M5 — Gate 3 built** | Client approval by email link, no login | ✅ 4 Aug 2026 |
| **M6 — First real client request** | Deliverability verified, one live request end to end | ⏳ blocked on Resend |
| **M7 — Teams Approvals retired** | DTR + internal approvals in production | Phase 5 |
| **M8 — ClickUp cancelled** | Timesheet, reporting, cutover | Phase 6 |

> **M6 is the one that matters commercially.** Everything before it reorganises internal work. M6 is the point the platform starts doing something the team was paying for elsewhere.

---

## Phase 0 — Foundation ✅

*Actual: 29 Jul – 3 Aug 2026 · Size ▓▓ medium*

| Task | Depends on | Est. | Status |
|---|---|---|---|
| P0-01 Repo, environments, stack | — | 1d | ✅ |
| P0-02 Base schema: departments, users, roles | P0-01 | 1d | ✅ |
| P0-03 Auth — Entra SSO + email/password | P0-02 | 2d | ⚠️ built, **Entra untested** |
| P0-05 Authorization layer | P0-02 | 1d | ✅ |
| P0-06 RLS policies + grants | P0-05 | 2d | ✅ |
| P0-07 App shell + role nav | P0-03 | 1d | ✅ |
| P0-08 Dashboard skeleton | P0-07 | 1d | ✅ |
| P0-09 Audit log primitive | P0-02 | 0.5d | ✅ |
| P0-10 Notifications + inbox | P0-02 | 1d | ✅ |
| P0-04 User management screens | P0-06 | 1d | ✅ |
| P0-11 Transactional email (outbox + cron) | P0-10 | 1d | ✅ code; ⏳ needs API key |
| P0-12 Seed + scope test suite | P0-06 | 2d | ✅ |

---

## Phase 1 — Forms ✅

*Actual: 29 Jul – 4 Aug 2026 · Size ▓▓▓ large*

| Task | Depends on | Est. | Status |
|---|---|---|---|
| P1-01 forms + form_fields migration | P0-06 | 1d | ✅ |
| P1-02 requests + attachments migration | P1-01 | 1d | ✅ |
| P1-03 Form builder UI | P1-01 | 3d | ✅ |
| P1-04 Form settings | P1-03 | 1d | ✅ |
| P1-05 Forms list | P1-03 | 0.5d | ✅ |
| P1-06 Public form page | P1-02 | 2d | ✅ |
| P1-07 Submission endpoint | P1-02 | 2d | ✅ |
| P1-08 Requester identity capture | P1-07 | 0.5d | ✅ |
| P1-09 Attachment upload | P1-07 | 2d | ✅ |
| P1-10 Reference numbers | P1-02 | 1d | ✅ + uniqueness fix |
| P1-11 SLA timer | P1-07 | 0.5d | ✅ |
| P1-12 TL notification | P0-10 | 0.5d | ✅ |
| P1-13 Requests list | P1-02 | 1d | ✅ |
| P1-14 Request detail | P1-13 | 1d | ✅ |
| P1-15 Abuse controls | P1-07 | 1d | ✅ |
| **P1-16 Two forms built through the builder** | P1-04 | 0.5d | ⏳ **step 2 of the smoke test** |

---

## Phase 2 — Approval Engine + Gate 1 ✅

*Actual: 3–4 Aug 2026 · Size ▓▓ medium*

| Task | Depends on | Est. | Status |
|---|---|---|---|
| **P2-00 Generic approval engine** | P1-02 | 2d | ✅ reused by Phase 5 unchanged |
| P2-01 TL review screen | P2-00 | 2d | ✅ |
| P2-02 Capacity panel (query + UI) | P2-00 | 2d | ✅ |
| P2-03 Edit-before-approve | P2-01 | 1d | ✅ |
| P2-04/05 PIC + QA selectors | P2-01 | 1d | ✅ |
| P2-06 Target list selection | P3-01 | 0.5d | ✅ *(waited on lists — Q18)* |
| P2-07 Approve transaction | P2-00 | 2d | ✅ |
| P2-08/09 Return + reject | P2-00 | 1d | ✅ |
| P2-10 Pending approvals queue | P1-13 | 0.5d | ✅ |
| P2-11 Dashboard shortcut | P0-08 | 0.5d | ✅ |
| P2-12 Notification surfacing | P0-10 | 0.5d | ✅ |
| P2-13 Authorization tests | P2-07 | 1d | ✅ |

---

## Phase 3 — Tasks + Internal QA ✅

*Actual: 3–4 Aug 2026 · Size ▓▓▓▓ largest*

| Task | Depends on | Est. | Status |
|---|---|---|---|
| P3-01 Lists migration + CRUD | P0-06 | 1.5d | ✅ |
| P3-02 tasks + status history migration | P2-07 | 1.5d | ✅ |
| P3-06 Status transition engine | P3-02 | 2d | ✅ |
| P3-07 Resolution gate | P3-06 | 0.5d | ✅ |
| P3-03 Task list view | P3-02 | 2d | ✅ |
| P3-05 Task detail view | P3-03 | 2d | ✅ |
| P3-08 QA screen | P3-05 | 1d | ✅ *(the detail page, seen by the reviewer)* |
| P3-09/10 QA pass + reject | P3-06 | 1d | ✅ |
| P3-11 WAITING_FOR_INFO + duration | P3-06 | 1d | ✅ |
| P3-12 Manual task creation | P3-02 | 1d | ✅ |
| P3-13 Task attachments | P1-09 | 1d | ✅ |
| P3-14 My tasks + dashboard card | P3-03 | 0.5d | ✅ |
| P3-04 Board view | P3-03 | 1.5d | ✅ |
| P3-15 Scope tests | P3-06 | 1.5d | ✅ |

---

## Phase 4 — Client Approval ✅ *(code)*

*Actual: 4 Aug 2026 · Size ▓▓▓ large*

| Task | Depends on | Est. | Status |
|---|---|---|---|
| P4-01 Token + decisions migration | P3-02 | 1d | ✅ |
| P4-02 Token issuance | P4-01 | 0.5d | ✅ |
| P4-03 Approval email | P0-11 | 1d | ✅ |
| P4-04 Public approval page | P4-01 | 2d | ✅ |
| P4-05 Decision handler | P4-01 | 1.5d | ✅ |
| P4-06/07 Approve + reject paths | P4-05 | 1d | ✅ |
| P4-08 Reminder emails | P4-02 | 1d | ✅ |
| P4-09 Auto-complete cron | P4-02 | 1d | ✅ |
| P4-10 Feedback request | P4-06 | 0.5d | ✅ |
| P4-11 Feedback storage + results | P4-10 | 0.5d | ✅ |
| P4-12 Archive + final audit | P4-06 | 0.5d | ✅ |
| P4-13 Security tests | P4-05 | 2d | ✅ 31 tests |
| **P4-14 Deliverability check** | P0-11 | 1d | ⛔ **BLOCKED — no Resend key** |

---

## ⛔ Blockers — nothing below moves without these

| # | Blocker | Blocks | Owner |
|---|---|---|---|
| B1 | **Resend account + verified sending domain** (SPF/DKIM/DMARC) | P4-14, M6, every email in the system | Amier |
| B2 | **Entra tenant pointed at `/login`**, one sign-in confirmed | P0-03 exit criterion | Amier / IT |
| B3 | **Browser smoke test** — [14-smoke-test.md](14-smoke-test.md) | Confidence in Phases 0–4 | Ace + Kurt |

> B1 is the one to start now. It has an external dependency — DNS records and their propagation — so it is the item most likely to sit waiting on somebody else, and Phase 4 is inert until it lands.

---

## Phase 5 — DTR + Internal Approvals ⏳

*Not started · Size ▓▓ medium · ~10 working days*

Reuses the Phase 2 engine. If this phase finds itself rebuilding approve/return/reject, the abstraction failed and **that** is the bug to fix.

| Task | Depends on | Est. |
|---|---|---|
| P5-12 Extend `lib/dates.ts` — work-date normalisation | — | 1d |
| P5-01 dtr_entries migration, unique per (user, date) | P0-06 | 1d |
| P5-02 Punch logic — earliest in, latest out | P5-01 | 2d |
| P5-05 internal_requests migration | P2-00 | 1d |
| P5-07 Routing onto the existing engine | P5-05 | 1d |
| P5-08 Approve/reject decisions | P5-07 | 1d |
| P5-09 **Approved correction writes back to the DTR** | P5-08 | 1.5d |
| P5-03 Dashboard punch shortcut | P5-02 | 0.5d |
| P5-04 DTR list view | P5-02 | 1.5d |
| P5-06 The four request forms | P5-05 | 2d |
| P5-10 Approvals list view | P5-07 | 1d |
| P5-11 DTR export for payroll (xlsx) | P5-02 | 1d |

**Decide before starting:** Q4 (punch constraints — recommendation is in [09-later-phases.md](09-later-phases.md)) and Q8 (does anyone work a shift that crosses midnight?). **No leave-balance logic** — Amier waved it off explicitly and it is the single easiest place for scope to explode.

---

## Phase 6 — Timesheet + Reporting ⏳

*Not started · Size ▓▓ medium · ~9 working days*

**This is the phase that lets the ClickUp subscription be cancelled.**

| Task | Depends on | Est. |
|---|---|---|
| P6-01 timesheet_entries migration (`task_id NOT NULL`) | P3-02 | 0.5d |
| P6-02 Timesheet entry UI | P6-01 | 2d |
| P6-03 Week view | P6-02 | 1.5d |
| P6-04 Turnaround reporting | P4-06 | 1.5d |
| P6-06 Negotiation + auto-complete splits | P4-09 | 1d |
| P6-05 Dashboards | P6-04 | 2d |
| P6-07 Feedback report | P4-11 | 1d |
| P6-08 Archive | P4-12 | 1d |
| P6-09 Exports | P6-04 | 1d |
| **P6-10 ClickUp migration + cutover** | all | 3d |

> `task_id NOT NULL` is the whole timesheet feature. Amier at 33:20: time is logged against a task chosen from a list, never free text.

---

## Suggested Gantt shape

```
Phase 0  ▓▓▓▓▓▓            ✅ done
Phase 1  ▓▓▓▓▓▓▓▓▓         ✅ done
Phase 2      ▓▓▓▓▓▓        ✅ done
Phase 3         ▓▓▓▓▓▓▓▓▓▓ ✅ done
Phase 4              ▓▓▓▓▓ ✅ code · ⛔ P4-14
B1 Resend       ═══════════ START NOW — external dependency
B3 Smoke test        ▓▓     ← we are here
Phase 5                  ▓▓▓▓▓▓▓▓▓▓
Phase 6                            ▓▓▓▓▓▓▓▓▓
M6 First live request     ◆ (needs B1)
M8 ClickUp cancelled                      ◆
```

**Two dependencies worth drawing as arrows**, because they are the ones that bite:

- **B1 → M6.** No amount of Phase 5 or 6 progress produces a working client approval without a verified sending domain.
- **Phase 3 → Phase 4.** Already satisfied, but it is why Phase 3 was the worst place in the plan to stall.

---

## What to review at each checkpoint

The roadmap drops dates and puts the weight on **binary exit criteria** instead. Criteria nobody looks at are decoration, so review these and nothing else:

1. Does every exit criterion for the current phase pass? ([13-implementation-status.md](13-implementation-status.md) tracks them.)
2. Is `npm run verify` green? *(254 tests as of 4 Aug.)*
3. Has anything from the blocker table moved?

A phase whose tests are all still unwritten is not nearly done, however complete the screens look.
