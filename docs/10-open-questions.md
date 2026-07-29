# Open Questions and Risk Register

**Q1, Q2, Q3 and Q11 are answered** — recorded below with what was decided.

**Q12 and Q13 are answered. Q14 is partly answered** — the URL is settled for development, the Vercel plan and git repo are not.

**Still needed before coding: email addresses and the member roster (Q13), and the GitHub repo (Q14).** **Q9 blocks Phase 1** and is the highest-leverage answer in this document. The rest affect later phases.

---

## Answered

### Q1 — Three roles or four? → **FOUR** ✅

`member` · `team_leader` · `manager` · `admin`.

The duties described for a Team Leader — assess assignee load, negotiate target dates, assign PIC, set QA — are operationally distinct from a department manager's oversight, so they stay separate roles.

---

### Q2 — Microsoft SSO or email/password? → **BOTH** ✅

Entra/Microsoft SSO **and** email + password, both enabled on Supabase Auth.

Two things this obliges, easy to defer into a bug (see `04-phase-0-foundation.md`):

- **Identity linking.** Entra on Monday, email/password on Tuesday can create two `auth.users` rows for one person. Match on verified email; never let a duplicate profile appear.
- **Password policy and reset flow** are now owned by the team. Entra does not absorb them.

---

### Q3 — Is the "sell it to other schools" ambition real? → **REAL, BUT DEFERRED** ✅

Build single-tenant. No `organization_id`. Revisit once the platform is built and in use.

Defensible — the ambition is worth nothing if the thing never ships. But name the debt honestly: **adding a tenant dimension later means touching every query and every RLS policy against live data, and the bill arrives all at once.**

Three hedges that cost nothing now and cut that bill substantially. Full detail in `02-data-model.md` §Deferred multi-tenancy:

1. Keep all scoping in the single authorization helper (`P0-05`).
2. Write down which unique constraints are global today and would need to become per-tenant — `vizserve_pms_forms.slug` and `vizserve_pms_requests.reference_no`.
3. Shape RLS policies so they could take one more `WHERE` condition.

**Revisit trigger:** the moment a second organization is a real conversation rather than a hypothetical, this becomes scheduled work — not something squeezed into a phase.

---

### Q11 — Same Supabase project as the SIS, or a new one? → **NEW PROJECT** ✅

A dedicated Supabase project, separate from the SIS/admissions one. No shared blast radius with student data; separate keys, backups and restore timeline.

**Plus:** every table and enum type carries the prefix **`vizserve_pms_`** (PMS = Project Management System).

A note on the prefix: in a dedicated project it does less work than it would in a shared one — that is what the separate project already buys. It is still fine to have, and it makes table names unambiguous in logs and the Supabase dashboard. Two consistency rules: **prefix the enum types too** (they share the schema namespace), and **do not prefix columns**.

---

## Blocking — answer before coding starts

### Q12 — Client-facing email sending domain → **vizserve.com** ✅

`resend` sends from **vizserve.com**. Add SPF, DKIM and DMARC records for it in Phase 0 (`P0-11`), separate from the SIS sending domain so a deliverability problem in one system cannot poison the other. Test-send to Outlook/M365, Gmail and HFSE's real domain before Phase 4 depends on it.

---

### Q13 — Departments and Team Leaders → **ANSWERED** ✅

| Department | Team Leader |
|---|---|
| VizBytes | Amier Ordonez |
| VizAssists | Joel Castro |
| VizBooks | Joel Castro |
| VizMedia | John Lloyd Tulang |

Overall Team Manager: **Joel Castro**.

**Two consequences worth naming.**

**1. A single exclusive role per user does not fit this roster.** Amier is an admin *and* VizBytes' TL. Joel is Team Manager *and* TL of two departments. Fixed by making roles inclusive — `admin` ⊇ `manager` ⊇ `team_leader` ⊇ `member`, with `vizserve_pms_user_managed_departments` deciding which departments a person actually leads. Recorded in `02-data-model.md`. The four-role decision (D6) survives unchanged; the authorization helper just checks `role >= required`, not `role ==`.

**2. Three leaders cover four departments, and one person covers two of them.** Joel Castro is TL for VizAssists and VizBooks *and* the overall Team Manager. Gate 1 exists to stop work being accepted without someone checking capacity — but the person doing that checking for half the departments is also the person with the most other responsibilities. Worth asking honestly: **does Joel have the bandwidth to review every VizAssists and VizBooks request?** If not, Gate 1 becomes a queue that stalls, which is worse than no gate at all. Options: name a deputy TL per department, or accept a slower review and set client expectations accordingly.

**Still needed before `P0-12` can seed:** email addresses for the three leaders, and the member roster — name, email, primary department. The Phase 2 capacity panel is meaningless without real members to assign work to.

---

### Q14 — Repo, Vercel account, and app URL → **PARTLY ANSWERED**

**On the URL: you're right, and I over-flagged it.** `vizserve-pms.vercel.app` is completely fine for development, and for Phases 0–3 nothing external ever sees it. The only real deadline is Phase 4, when approval links start going to HFSE staff — and since you now own `vizserve.com` for email, `pms.vizserve.com` is free and takes minutes. Not a decision needed now.

**On the Vercel account, the reason was not the URL — and it does hold. Three concrete things:**

1. **Hobby is licensed for non-commercial, personal use only.** Vercel's fair use guidelines state this explicitly. VizServe PMS is business software for a company, and D5 has it eventually replacing a paid ClickUp subscription — with the stated ambition of selling it. That is commercial use.
2. **Hobby cron jobs run once per day, with ±59 minutes of precision.** Any expression that would fire more often **fails at deploy time**. `P4-09` — the auto-complete job plus the two reminder emails — can be squeezed into one daily scan, but it means the 3-day deadline effectively resolves at an unpredictable hour. On Pro it is per-minute.
3. **Hobby has no team collaboration features.** Two developers cannot properly share a Hobby project.

So the question is not cosmetic: **whose Vercel account, and will it be Pro?** Pro is $20/seat/month — which is worth setting against the ClickUp bill this project is meant to eliminate. Not a Phase 0 blocker for building, but decide it before Phase 4.

**Still needed:** which GitHub org and repo name. The working folder is not a git repository yet.

---

### Q9 — Field lists for the two live forms `blocks P1-16`

**The plain version of the question:** *what, exactly, must a client fill in before VizServe will accept a request?*

That is a business decision, not a technical one, and it is the single highest-leverage answer in this whole document — because the "no incomplete requests" rule (the commercial heart of the build, per `01-updated-workflow.md` §4) is only ever as strong as this list. Ms. Apple's purchasing example from the call — a task she could not start because quantity was never specified — is exactly a missing field.

Draft lists are in `05-phase-1-forms.md`. What is needed back is: **strike anything unnecessary, add anything missing, confirm which are required, and say which department owns each form** — `forms.department_id` decides which Team Leader the request lands on, and it is currently unset for both. Every field marked required is a request that will be *refused* if the client leaves it blank — so the list is a promise about what the team will and will not chase.

One field to consider especially: **"Approved by (client-side)"** on the Collateral form. One text box, and it makes the client's own internal sign-off a precondition of submitting rather than something VizServe absorbs later. It is the cheapest possible implementation of the argument Amier spent ten minutes on.

---

## Later phases

### Q4 — DTR: confirm the correction and backdating constraints `blocks P5-02`

Your rules — earliest-in wins, latest-out wins, user picks the date — leave no way for a user to fix a mistaken early punch-in, and no guard against attaching a punch to a favourable past date.

**Recommendation:** server timestamp is authoritative; time-in always attaches to today with no picker; time-out attaches to today or yesterday only; corrections flow through the No Time-In / No Time-Out approval forms. That last part is what makes those two form types earn their existence.

---

### Q5 — Can a TL or admin force a status change? `affects P3-06`

Not discussed. Real systems need it (a ticket closed by mistake, a member who left mid-task). Unlogged, it destroys the audit trail that makes the rest of this credible.

**Recommendation:** allow for TL and admin, mandatory reason, flagged distinctly in `task_status_history` as an override.

---

### Q6 — Is "3 days" calendar days or business days? `affects P4-09`

Calendar days means a ticket sent Friday 5pm auto-completes Monday 5pm — roughly one working day of actual client attention. That is the scenario that produces the angry call.

**Recommendation:** business days, configurable per form rather than hardcoded. Different request types deserve different windows; a poster is not a support ticket.

**Cost note:** business days means weekend skipping and probably a PH holiday calendar, and the SIS repo bans date libraries (`lib/dates.ts` only). Budget the work rather than discovering it mid-phase — see `11-stack-conventions.md`.

---

### Q7 — How hard should "only the requestor can approve" be enforced? `affects P4-04`

Email-based identity is defeated by forwarding. Options and trade-offs are in `08-phase-4-client-approval.md`.

**Recommendation:** accept forwarding as the client's own accountability, and add a "your name" field on the approval page so the record shows who actually clicked. Do not add a one-time code unless a real dispute happens — it adds friction to the exact step you want frictionless.

---

### Q8 — Are there staff whose whole shift crosses midnight? `affects P5-02`

Your DTR rule handles OT that runs late. A scheduled 22:00–06:00 shift is a different problem: which work_date does it belong to? If nobody at VizServe works nights, say so and we skip it.

---

### Q10 — Who owns the client-side conversation? `affects everything`

The technical build is straightforward. The hard part is what you described at ~46:30 — telling HFSE that their internal approval process has to happen *before* they submit to VizServe, not during.

The platform can enforce completeness, but it cannot make a client accept a new process. If that conversation does not happen, clients submit incomplete forms, get returned, and conclude the new system is worse than emailing Ace directly.

**Suggestion:** treat client onboarding as a Phase 4 deliverable with a named owner and a date, not as something that follows naturally from shipping.

---

## Risk register

| ID | Risk | Impact | Mitigation | Phase |
|----|------|--------|-----------|-------|
| **R1** | Public form endpoint abused — spam, oversized uploads, enumeration | Storage cost, junk queue, TL fatigue | Rate limit per IP and per email, honeypot, MIME + size allowlist, no direct `anon` table access | P1-15 |
| **R2** | Approval token leaked, guessed, replayed, or reused across tasks | Unauthorised approval of client work | ≥256-bit random, store hash only, bind to task + email, expiry, single-use, rate limit, log IP/UA | P4-01, P4-13 |
| **R3** | DTR rules as stated are uncorrectable and backdatable | Payroll disputes, no trust in the record | Q4 constraints; corrections via approval forms | P5-02 |
| **R4** | `WAITING_FOR_INFO` used to hide SLA breaches | Turnaround metrics become meaningless | Note required on entry, duration logged and reported separately | P3-11, P6-04 |
| **R5** | Editing a live form's fields orphans `field_values` on existing requests | Silent data loss on historical requests | Block deleting fields that have data; form versioning if it becomes a real problem | P1 |
| **R6** | Auto-complete disputed by a client who never saw the email | Relationship damage, exactly the opposite of the intent | Deadline stated in the email body, two reminders, deliverability verified, distinct `COMPLETED_NO_RESPONSE` state | P4-08, P4-09, P4-14 |
| **R7** | Scope creep — "sabay-sabay" (57:32) | Six half-built modules, nothing usable, team demoralised | Strict phase gating; cut scope *inside* a phase, never start the next in parallel | All |
| **R8** | Two developers already loaded with GHL, SIS, HFSE delivery | Phases stretch indefinitely and the ClickUp bill keeps arriving through Phase 6 | Amier to state explicitly what GHL/SIS work is being deprioritised. **This has not been said out loud.** Also: find out when the ClickUp renewal lands | All |
| **R11** | Parallel tracks block on each other because the API contract is not agreed up front | Kurt idles waiting on Ace in every phase, and with no dates nobody notices | Zod schema handoff at phase start is a hard gate, not a nicety — see `03-roadmap.md` | All |
| **R12** | Phase 3 is the largest in the set and stalls half-built | Worst possible place to stall — Phase 4 depends on it entirely | Pre-planned 3a/3b split, called as soon as the shape of the work is clear | P3 |
| **R13** | **No dates means no early warning.** With time-boxing dropped, nothing forces a stalled phase to declare itself | A phase drifts for months while feeling productive | Exit criteria are binary and must be reviewed at a regular checkpoint. Criteria nobody looks at are decoration | All |
| **R9** | Non-atomic approval leaves half-created state | Trust collapses; team reverts to ClickUp | Single Postgres function for the approval transaction | P2-07 |
| **R10** | Email deliverability to M365 tenants | The whole client approval gate silently fails | SPF/DKIM/DMARC in Phase 0, tested against the client's real domain | P0-11, P4-14 |

---

## The one I would push hardest on

**R8.** Everything else in this document is a solvable engineering problem.

The plan assumes Ace and Kurt build six modules while Kurt is also running GHL automations, GHL training for two separate audiences, coordinating with Ms. Wine, and Ace is carrying the SIS build. In the same call, Kurt's laptop died mid-demo and Ace was described as having "kompleto na" GHL work — the capacity conversation never happened.

The irony is sharp: this platform exists to stop the team accepting work without checking load. It is being planned without checking the team's own load.

Before Phase 0 starts, someone should say out loud which existing commitments slip. If the answer is "none," the honest projection is that Phase 4 does not ship this year, and the ClickUp subscription stays.
