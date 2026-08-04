# Project Timeline — VizServe PMS

Formatted for the ClickUp Gantt, in the same shape as **01 Online Admission Plan**: one flat list, one task per line, one due date each.

**Dates before 4 Aug 2026 are a record.** They happened. **Dates after are estimates** — [03-roadmap.md](03-roadmap.md) deliberately carries none, because velocity was unknown with Kurt splitting time on GHL. The order is real; the dates are a projection.

**One caveat that will otherwise mislead the chart.** The first ten tasks closed in about a week because the build was AI-assisted. That is not a rate two people already carrying GHL, SIS and HFSE delivery work will sustain. Everything from *Email & Domain Configuration* onward is planned at roughly a fortnight per module, which is the honest number.

---

## 01 VizServe PMS Development Plan

| # | Task | Start | Due | Status |
|---|---|---|---|---|
| 1 | Touch base with Stakeholders | 28 Jul 2026 | 28 Jul 2026 | ✅ |
| 2 | Kickoff Meeting | 29 Jul 2026 | 29 Jul 2026 | ✅ |
| 3 | Create Project Timeline | 29 Jul 2026 | 29 Jul 2026 | ✅ |
| 4 | Workflow & Data Model Design | 29 Jul 2026 | 30 Jul 2026 | ✅ |
| 5 | Database Setup and Configuration | 29 Jul 2026 | 31 Jul 2026 | ✅ |
| 6 | Authentication & User Management | 30 Jul 2026 | 3 Aug 2026 | ✅ |
| 7 | Client Request Forms Module | 31 Jul 2026 | 4 Aug 2026 | ✅ |
| 8 | Approval Engine & Team Leader Review | 3 Aug 2026 | 4 Aug 2026 | ✅ |
| 9 | Task Management & QA Module | 3 Aug 2026 | 4 Aug 2026 | ✅ |
| 10 | Client Approval & Feedback Module | 4 Aug 2026 | 4 Aug 2026 | ✅ |
| 11 | UI/UX Design & Branding | 4 Aug 2026 | 4 Aug 2026 | ✅ |
| 12 | **Email & Domain Configuration** | 5 Aug 2026 | 7 Aug 2026 | ⛔ **blocker** |
| 13 | Testing and Bug Fixing | 5 Aug 2026 | 14 Aug 2026 | ⏳ |
| 14 | DTR Module | 17 Aug 2026 | 28 Aug 2026 | ⏳ |
| 15 | Internal Approvals Module | 31 Aug 2026 | 11 Sep 2026 | ⏳ |
| 16 | Timesheet & Reporting Module | 14 Sep 2026 | 25 Sep 2026 | ⏳ |
| 17 | ClickUp Data Migration | 28 Sep 2026 | 2 Oct 2026 | ⏳ |
| 18 | Web Hosting & DNS Configuration | 5 Oct 2026 | 7 Oct 2026 | ⏳ |
| 19 | Deployment of Live Environment | 8 Oct 2026 | 9 Oct 2026 | ⏳ |
| 20 | Parallel Run & Cutover | 12 Oct 2026 | 23 Oct 2026 | ⏳ |

**Target: ClickUp cancelled by end of October 2026.**

---

## What each task covers

Only worth reading when a bar needs breaking into subtasks.

| # | Task | What is inside it |
|---|---|---|
| 1 | Touch base with Stakeholders | The requirements call with Amier. Six modules, three approval gates, four roles |
| 2 | Kickoff Meeting | Scope agreed. Sabay-sabay ruled out — phases strictly ordered |
| 3 | Create Project Timeline | The roadmap, phase docs and decision register D1–D20 |
| 4 | Workflow & Data Model Design | Canonical status enums, the request lifecycle, the RLS strategy |
| 5 | Database Setup and Configuration | Supabase project, `vizserve_pms_` prefix rule, RLS and GRANTs on every table |
| 6 | Authentication & User Management | Entra SSO + email/password, four inclusive roles, admin user screens, app-access gate |
| 7 | Client Request Forms Module | Form builder, public form with no login, server-side validation, attachments, reference numbers |
| 8 | Approval Engine & Team Leader Review | The generic engine, the capacity panel, approve/return/reject, atomic task creation |
| 9 | Task Management & QA Module | Lists, task board and list views, the status machine, the resolution gate, QA hand-off |
| 10 | Client Approval & Feedback Module | Signed-token approval page, auto-complete, reminders, feedback |
| 11 | UI/UX Design & Branding | Brand palette, mobile responsive pass, client-facing pages |
| 12 | **Email & Domain Configuration** | Resend account, sending domain, SPF/DKIM/DMARC, deliverability to Outlook/Gmail |
| 13 | Testing and Bug Fixing | Browser smoke test ([14-smoke-test.md](14-smoke-test.md)), Entra verification, fixes |
| 14 | DTR Module | Punch in/out rules, DTR list view, payroll export |
| 15 | Internal Approvals Module | Leave, no time-in, no time-out, reimbursement — on the existing engine |
| 16 | Timesheet & Reporting Module | Time logged against tasks, turnaround and feedback reporting, dashboards |
| 17 | ClickUp Data Migration | Export, map and import live ClickUp data |
| 18 | Web Hosting & DNS Configuration | Vercel production, domain, cron schedules |
| 19 | Deployment of Live Environment | Production deploy, real accounts, first live request |
| 20 | Parallel Run & Cutover | Both systems for two weeks, then cancel ClickUp |

---

## The one blocker

**Task 12 — Email & Domain Configuration.** No `RESEND_API_KEY` exists, so the system runs in **dry-run**: it renders every email, logs the subject and sends nothing. Gate 1 decisions, client approvals, reminders and feedback are all silent.

It has an **external DNS dependency** — records have to be created and then propagate — so it is the task most likely to sit waiting on somebody else. It is drawn before Testing for that reason: start it now, and let it run while the smoke test proceeds in parallel.

Nothing in tasks 14–20 removes this. A client approval cannot work without a verified sending domain, no matter how much of the DTR module exists.

Two smaller items, neither blocking: **Entra SSO has never been exercised** (identity linking is a project setting, not something a migration can enforce), and **two placeholder forms** still need building through the builder — which is step 2 of the smoke test.

---

## Dependencies worth drawing as arrows

- **12 → 19.** No live deployment is meaningful without email working.
- **9 → 10.** Client approval sits entirely on the task status machine. Already satisfied, and it is why Task Management was the worst place in the plan to stall.
- **8 → 15.** Internal approvals reuse the Phase 2 engine unchanged. If task 15 finds itself rebuilding approve/reject, the abstraction failed and that is the bug to fix.
- **16 → 17 → 20.** Nothing can be migrated off ClickUp until reporting replaces what people currently read there.

---

## Reviewing progress

The roadmap drops time-boxing and puts the weight on **binary exit criteria** instead. At each task boundary, three questions and nothing else:

1. Does every exit criterion for that module pass? ([13-implementation-status.md](13-implementation-status.md) tracks them.)
2. Is `npm run verify` green? *(254 tests as of 4 Aug 2026.)*
3. Has task 12 moved?

A module whose tests are all still unwritten is not nearly done, however complete the screens look.
