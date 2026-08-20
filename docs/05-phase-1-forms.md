# Phase 1 — Forms

**Goal:** a client with no account can submit a complete, validated request from a public URL, and it lands in the right Team Leader's queue.

**Depends on:** Phase 0. **Relative size:** large — the form builder plus a public, unauthenticated surface that must be hardened.

## Track split

| Ace | Kurt |
|---|---|
| P1-01/02 migrations · P1-07 submission endpoint · P1-08 identity capture · P1-09 attachments · P1-10 reference numbers · P1-11 SLA timer · P1-15 abuse controls | P1-03 form builder UI · P1-04 form settings · P1-05 forms list · P1-06 public form page · P1-12 notifications · P1-13 requests list · P1-14 request detail |

**Contract, agreed before either track starts:** the runtime zod schema generated from `form_fields`. It is the single contract shared by the public form renderer (Kurt) and the server-side validator (Ace) — which is how the completeness rule gets enforced on both sides without being written twice.

**P1-16 seeds two placeholder forms** through the builder, not a fixed spec. See below.

---

## The one rule that matters

> *"pagpasok pa lang ng request, dapat kumpleto na"* — Amier, 48:25
> *"Hindi tayo gagalaw hanggang hindi kumpleto yun"* — Amier, ~55:30

Every other feature in this phase is scaffolding for that sentence. Amier's purchasing example (46:00 — Ms. Apple holding a task she cannot start because quantity was never specified) is the failure this phase exists to prevent.

Enforcement lives in three places, per `02-data-model.md`. Client-side validation alone does not count as done.

---

## Backlog

| ID | Item | Detail | Owner |
|----|------|--------|-------|
| P1-01 | `vizserve_pms_forms` + `vizserve_pms_form_fields` migration | Per `02-data-model.md`. `is_required` defaults **true**; `field_key` immutable after first submission; `is_active` for soft-archive — forms are dynamic (D20), so these are migration-time decisions, not later cleanup | Ace |
| P1-02 | `vizserve_pms_requests` + `vizserve_pms_request_attachments` migration | Include both `target_date` and `approved_target_date` from the start | Ace |
| P1-03 | Form builder UI | Add/remove/reorder fields, set type, required toggle, options for selects. Keep it plain — this is not the product's differentiator | Kurt |
| P1-04 | Form settings | Name, slug, description, owning department, default task list, public flag, `requires_attachment`, `sla_minutes`, active flag | Kurt |
| P1-05 | Forms list view | Staff-facing list of forms with status and public URL, per Amier 29:57 | Kurt |
| P1-06 | Public form page | `/request/[slug]` (was `/f/[slug]`, which now 308s — P7-29). No session. Renders fields, client-side validation for UX only | Kurt |
| P1-07 | Submission endpoint | `SECURITY DEFINER` function or server action. **Server-side required-field validation. Rejects partial submissions.** Returns field-level errors | Ace |
| P1-08 | Requester identity capture | Name, email, organization. Email is mandatory on every public form and is not editable by staff afterwards | Ace |
| P1-09 | Attachment upload | Supabase Storage. Size and MIME allowlist. Required when `requires_attachment` is true | Ace |
| P1-10 | Reference number generator | `<FORMPREFIX>-<YEAR>-<SEQ>`, e.g. `COL-2026-0142`. Clients will quote this in email | Ace |
| P1-11 | SLA timer start | Set `sla_started_at` on successful submission | Ace |
| P1-12 | TL notification on submission | `notifications` row + email to the department's TL(s) | Kurt |
| P1-13 | Requests list view (staff) | Department-scoped. Filters: status, form, date range. This is the TL's queue that Phase 2 acts on | Kurt |
| P1-14 | Request detail view (read-only) | Full field values, attachments, audit trail. Approval actions come in Phase 2 | Kurt |
| P1-15 | Abuse controls | Rate limit per IP and per email on the public endpoint; honeypot field; max attachment size. **Do not skip** — `[RISK] R1` | Ace |
| P1-16 | Seed two placeholder forms | **Collateral Request Form** and **User Support Form**, built *through the builder* as exercise data. Field lists are placeholders, editable in-app — see below | Kurt |

---

## P1-16: placeholder forms, not a fixed spec

**Decided (D20): forms are dynamic.** VizServe builds them in the app and shares them by public URL; the field list is *configuration*, not schema. So Phase 1 does not wait on a signed-off field list — it seeds two placeholders derived from the flow, and staff edit them in the builder as the real requirements settle.

What this changes:

- **`P1-16` is no longer a joint decision item.** It is seed data that proves the builder works end to end: build → publish → submit → land in a TL queue.
- **The completeness rule moves from a spec question to a configuration one.** It is still the commercial heart of the build ([§The one rule that matters](#the-one-rule-that-matters)), but its strength now depends on how carefully staff configure required fields at go-live, not on a list agreed up front. Worth a review pass before the first real client link goes out.
- **`R5` gets more likely, not less.** A form that is *meant* to evolve will have fields edited and deleted while historical requests hold `field_values` keyed to them. See the field-key rules below — they are a `P1-01` migration decision, not a later cleanup.

### Field keys and editing — get this right in the migration

Because forms change by design, `form_fields.field_key` is the stable contract behind task column mapping (`02-data-model.md`) and every historical `field_values` blob:

- **`field_key` is immutable once the form has a submission.** Labels stay freely editable; the key does not follow them.
- **Never hard-delete a field that has data.** Add `form_fields.is_active` and soft-archive instead, so historical requests keep rendering.
- **Adding a field does not retroactively invalidate old requests.** Required-ness applies at submission time only.

### Placeholder field lists

Derived from the flow and from the transcript at 40:30 (*"forget date, description, name, attachment, or kung may iba pang requirements per form"*). Treat every row as a starting point that staff will change.

**Collateral Request Form** — owning department **VizMedia** *(placeholder — set in form settings)* (attachment required)

| Field | Type | Required |
|---|---|---|
| Requester name | text | yes |
| Requester email | email | yes |
| Requesting school / department | select | yes |
| Collateral type | select | yes |
| Title / campaign name | text | yes |
| Description and specs | textarea | yes |
| Target release date | date | yes |
| Sizes / formats needed | multiselect | yes |
| Copy / content (final) | file | yes |
| Reference or brand assets | file | no |
| Approved by (client-side) | text | yes — *forces the client to have done their own approval first* |

**User Support Form** — owning department **VizBytes** *(placeholder — set in form settings)* (attachment optional)

| Field | Type | Required |
|---|---|---|
| Requester name | text | yes |
| Requester email | email | yes |
| Department | select | yes |
| System affected | select | yes |
| Issue description | textarea | yes |
| Steps already tried | textarea | yes |
| Urgency | select | yes |
| Screenshot | file | no |

> The **"Approved by (client-side)"** field on the collateral form is the cheapest possible implementation of Amier's central argument (43:00–47:00): make the client's own internal sign-off a precondition of submission rather than something VizServe absorbs later. One text field. Keep it in the placeholder even though everything around it is provisional — it is the one field that encodes the reason the system exists.

---

## Out of scope for Phase 1

- Approval actions — Phase 2
- Task creation — Phase 2
- Internal approval forms (leave, no-in/no-out) — Phase 5. **Different table, different auth model.** Do not generalise the client form builder to cover them.
- Conditional / branching form logic
- Form versioning — but note `[RISK] R5`: editing a live form's fields will orphan `field_values` keys on existing requests. At minimum, block deleting a field that has data.

---

## Exit criteria

- [ ] A form can be built, published, and reached at a public URL with no session.
- [ ] A `curl` request to the submission endpoint missing a required field is rejected. **Test this from outside the browser.**
- [ ] A complete submission creates a request, uploads its attachment, gets a reference number, starts the SLA timer.
- [ ] The request appears in exactly one TL queue and is invisible to other departments (assert at API level).
- [ ] Two placeholder forms exist, **built through the builder rather than seeded by SQL**, each routing to a department.
- [ ] A field can be renamed without breaking existing requests, and a field with data cannot be hard-deleted.
- [ ] Rate limiting demonstrably blocks a submission flood.
