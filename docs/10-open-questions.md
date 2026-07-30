# Open Questions and Risk Register

**Q1, Q2, Q3 and Q11 are answered** — recorded below with what was decided.

**Q12 and Q13 are answered. Q14 is partly answered** — the URL is settled for development, the Vercel plan and git repo are not.

**Q9 is answered — forms are dynamic, so nothing blocks Phase 1.**

**Q15–Q18 were raised during the build** (29 Jul 2026) and are listed below the later-phase questions. Q18 blocks Phase 2 as specified.

**Still needed before coding: email addresses and the member roster (Q13).** The GitHub repo half of Q14 is done; the Vercel plan is not. The rest affect later phases.

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

**The repo half is now done:** `github.com/ace-vizserve/vizserve-pms`, `main`, initialised. **Still needed:** the Vercel account and whether it is Pro. Note the same plan question applies to **Supabase** and is not asked anywhere in this document — free tier pauses a project after 7 days idle and caps Storage at 1 GB, which a collateral-heavy Phase 1 will reach.

---

### Q9 — Field lists for the two live forms → **FORMS ARE DYNAMIC; PLACEHOLDERS FOR NOW** ✅

The question was *what, exactly, must a client fill in before VizServe will accept a request?* — and the answer is that it is not a question the build has to settle. **VizServe builds the forms in the app and shares them by public URL, so the field list is configuration, not schema.** Phase 1 seeds two placeholders derived from the flow; staff edit them in the builder as real requirements emerge. `P1-16` stops being a joint decision item and becomes seed data proving the builder works.

**What this does not do is remove the underlying risk — it relocates it.** The "no incomplete requests" rule (the commercial heart of the build, per `01-updated-workflow.md` §4) is still only ever as strong as the field list. It is now a *configuration quality* problem rather than a spec problem, which means nobody is blocked, but also that nobody is forced to think about it. Ms. Apple's purchasing example — a task she could not start because quantity was never specified — is still exactly a missing field. **Do a deliberate review of required fields before the first real client URL goes out**, or the rule ships switched off.

**And it raises `R5` from hypothetical to near-certain.** Forms that are *designed* to evolve will have fields edited and deleted while historical requests hold `field_values` keyed to them. The mitigations — immutable `field_key`, soft-archive instead of delete — are a `P1-01` migration decision. Detail in `05-phase-1-forms.md`.

One placeholder field to keep through every revision: **"Approved by (client-side)"** on the Collateral form. One text box, and it makes the client's own internal sign-off a precondition of submitting rather than something VizServe absorbs later — the cheapest possible implementation of the argument Amier spent ten minutes on.

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

## Raised during the build (29 Jul 2026)

Questions the implementation surfaced that the specification did not anticipate. Full context in `13-implementation-status.md`.

### Q15 — Which primary colour wins? → **THE BRAND BLUE** ✅

`DESIGN.md` had been replaced three times (ClickUp → Pinterest → Shadcn Fintech), and `app/globals.css` followed the fintech template with a near-black `--primary`, so D11's `#4359A5` was not used anywhere in the running app.

**Answered by the user, 30 Jul 2026:** set `--primary: #4359A5`. D11 stands as written and the measured-contrast work in `12-ui-and-notifications.md` now describes the running app rather than an intention.

What changed in `globals.css`:

| Token | Light | Dark |
|---|---|---|
| `--primary` / `--sidebar-primary` | `#4359A5` on white text | `#8FA3E0` on `#1A2340` |
| `--accent` / `--sidebar-accent` | `#EEF1F9`, brand text at 5.79:1 | `#262E4A`, `#C9D4F2` at 9.02:1 |
| `--ring` | `#4359A5` | `#6B7FC4` |

`#4359A5` is too dark to carry on a dark surface, so the dark theme lightens primary to the same value `--brand` uses and flips its foreground dark — white on `#8FA3E0` would be ~2.2:1.

**Deliberately left neutral:** `--foreground`, `--muted-foreground`, `--border`. Those are body copy and structure, not identity. Tinting them puts a blue cast on every table row, which reads as a display fault rather than as branding.

`--brand-surface` remains separate from `--primary`: it is the one blue that must *not* flip with the theme, because it backs the white-only logo asset.

---

### Q16 — How do unauthenticated clients upload files? `blocks P1-09`

The last functional gap in Phase 1. A client has no session, so:

- **Proxying through a server action fails** — Vercel caps a serverless request body at ~4.5 MB, and collateral design files exceed that routinely.
- **A short-TTL signed upload URL**, issued by our server after checking MIME and declared size, is the workable shape. The file goes browser → Storage directly; our server never holds it.

Also needs deciding: bucket layout, retention, and the size cap. Supabase Storage's free tier is 1 GB, which a collateral-heavy month will reach — this pairs with the unanswered Supabase plan question in Q14.

---

### Q17 — When does the shared `<DataTable>` get extracted? `affects P2-10`

`11-stack-conventions.md` says all filterable lists use a shared `<DataTable>` shell and not to hand-roll tables. Two hand-rolled tables now exist (forms, requests), because extracting the abstraction from a single consumer guesses at it.

**Recommendation:** extract at `P2-10`, the third list view, informed by three real sets of requirements rather than one. Recorded so it is a decision rather than drift.

---

### Q18 — Phase 2 creates tasks in a table Phase 3 creates `blocks P2-07`

`P2-07`'s approval transaction inserts a `vizserve_pms_tasks` row and Phase 2's exit criteria require it — but `vizserve_pms_tasks` and `vizserve_pms_lists` are `P3-02` and `P3-01`. **Phase 2 cannot pass its own exit criteria as written.**

`forms.default_list_id` was omitted from the Phase 1 migration for the same reason: it is an FK to a table that does not exist yet.

**Recommendation:** pull the `lists` and `tasks` migrations forward into Phase 2 — Ace's track, small — leaving the status machine, views and QA screens in Phase 3. The alternative, dropping list selection from Phases 1–2, is worse: the form's default list is what makes task creation automatic.

---

## Risk register

| ID | Risk | Impact | Mitigation | Phase |
|----|------|--------|-----------|-------|
| **R1** | Public form endpoint abused — spam, oversized uploads, enumeration | Storage cost, junk queue, TL fatigue | Rate limit per IP and per email, honeypot, MIME + size allowlist, no direct `anon` table access | P1-15 |
| **R2** | Approval token leaked, guessed, replayed, or reused across tasks | Unauthorised approval of client work | ≥256-bit random, store hash only, bind to task + email, expiry, single-use, rate limit, log IP/UA | P4-01, P4-13 |
| **R3** | DTR rules as stated are uncorrectable and backdatable | Payroll disputes, no trust in the record | Q4 constraints; corrections via approval forms | P5-02 |
| **R4** | `WAITING_FOR_INFO` used to hide SLA breaches | Turnaround metrics become meaningless | Note required on entry, duration logged and reported separately | P3-11, P6-04 |
| **R5** | Editing a live form's fields orphans `field_values` on existing requests | Silent data loss on historical requests | **Raised by D20** — dynamic forms make this near-certain, not hypothetical. Immutable `field_key`, soft-archive via `form_fields.is_active`, never hard-delete a field with data | P1-01 |
| **R6** | Auto-complete disputed by a client who never saw the email | Relationship damage, exactly the opposite of the intent | Deadline stated in the email body, two reminders, deliverability verified, distinct `COMPLETED_NO_RESPONSE` state | P4-08, P4-09, P4-14 |
| **R7** | Scope creep — "sabay-sabay" (57:32) | Six half-built modules, nothing usable, team demoralised | Strict phase gating; cut scope *inside* a phase, never start the next in parallel | All |
| **R8** | Two developers already loaded with GHL, SIS, HFSE delivery | Phases stretch indefinitely and the ClickUp bill keeps arriving through Phase 6 | Amier to state explicitly what GHL/SIS work is being deprioritised. **This has not been said out loud.** Also: find out when the ClickUp renewal lands | All |
| **R11** | Parallel tracks block on each other because the API contract is not agreed up front | Kurt idles waiting on Ace in every phase, and with no dates nobody notices | Zod schema handoff at phase start is a hard gate, not a nicety — see `03-roadmap.md` | All |
| **R12** | Phase 3 is the largest in the set and stalls half-built | Worst possible place to stall — Phase 4 depends on it entirely | Pre-planned 3a/3b split, called as soon as the shape of the work is clear | P3 |
| **R13** | **No dates means no early warning.** With time-boxing dropped, nothing forces a stalled phase to declare itself | A phase drifts for months while feeling productive | Exit criteria are binary and must be reviewed at a regular checkpoint. Criteria nobody looks at are decoration | All |
| **R9** | Non-atomic approval leaves half-created state | Trust collapses; team reverts to ClickUp | Single Postgres function for the approval transaction | P2-07 |
| **R10** | Email deliverability to M365 tenants | The whole client approval gate silently fails | SPF/DKIM/DMARC in Phase 0, tested against the client's real domain | P0-11, P4-14 |
| **R14** | **GRANTs and RLS are two separate gates, and only one was written.** Supabase's default privileges did not apply to these migrations, so every table was unreachable by every role — the app was broken for all signed-in users, not just tooling | Total outage, and the error (`permission denied`) reads like an RLS problem, sending you to the wrong layer | Fixed in `20260729110000_p0_06_grants.sql`, which grants explicitly and sets `ALTER DEFAULT PRIVILEGES` so later migrations inherit it. **Diagnostic: a failing policy returns zero rows; a missing grant says `permission denied`** | P0-06 |
| **R15** | Exit criteria are met in behaviour but unproven by test. Six of eleven across Phases 0–1 are unmet only because nothing asserts them | A later feature silently breaks scoping and nothing catches it — the exact failure `P0-12` exists to prevent | Write the `P0-12` suite before Phase 2 starts, not after | P0-12 |

---

## The one I would push hardest on

**R8.** Everything else in this document is a solvable engineering problem.

The plan assumes Ace and Kurt build six modules while Kurt is also running GHL automations, GHL training for two separate audiences, coordinating with Ms. Wine, and Ace is carrying the SIS build. In the same call, Kurt's laptop died mid-demo and Ace was described as having "kompleto na" GHL work — the capacity conversation never happened.

The irony is sharp: this platform exists to stop the team accepting work without checking load. It is being planned without checking the team's own load.

Before Phase 0 starts, someone should say out loud which existing commitments slip. If the answer is "none," the honest projection is that Phase 4 does not ship this year, and the ClickUp subscription stays.
