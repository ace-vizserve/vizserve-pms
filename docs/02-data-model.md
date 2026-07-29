# Data Model — Postgres / Supabase

**Project:** VizServe PMS (Project Management System)
**Stack:** same as the HFSE SIS build — Next.js 16.2 App Router + Supabase (Postgres, Auth, Storage, RLS) via `@supabase/ssr`, on Vercel. See `11-stack-conventions.md`.

---

## Settled decisions

| # | Decision | Consequence |
|---|---|---|
| **Q11** | **A new, dedicated Supabase project.** Not the SIS project | No shared blast radius with student and admissions data. Separate keys, separate backups, separate restore timeline |
| **Naming** | Every table is prefixed **`vizserve_pms_`** | e.g. `vizserve_pms_requests`. Applies to enum types too — see below |
| **Q1** | **Four roles**: `member`, `team_leader`, `manager`, `admin` | The TL role has a real job description from the meeting; manager is visibility |
| **Q2** | **Microsoft/Entra SSO *and* email + password** | Both providers enabled. See §Auth |
| **Q3** | **No `organization_id`.** Single-tenant | Product ambition is real but deferred until the platform is built and in use. See §Deferred multi-tenancy for the zero-cost hedges |

### A note on the prefix

In a dedicated project the prefix is doing less work than it would in a shared one — that is what the separate project already buys. It is still fine to have: it makes table names unambiguous in logs, in the Supabase dashboard, and in any future consolidation. Two things to keep consistent:

- **Prefix the enum types too.** Postgres types share the schema namespace with tables. `vizserve_pms_user_role`, `vizserve_pms_request_status`, `vizserve_pms_task_status`, `vizserve_pms_internal_request_type`, `vizserve_pms_client_decision`, `vizserve_pms_notification_type`.
- **Do not prefix columns.** `vizserve_pms_requests.status`, not `vizserve_pms_requests.vizserve_pms_status`.

---

## Auth

Both providers enabled on Supabase Auth:

- **Microsoft / Entra** — the path of least friction for staff, since the team already lives in M365. Offboarding becomes one action in M365.
- **Email + password** — fallback, and the only workable path for anyone without an M365 account.

Two consequences worth handling deliberately in Phase 0:

1. **One human, one `vizserve_pms_users` row.** If someone signs in with Entra on Monday and email/password on Tuesday, Supabase can create two `auth.users` rows for the same person. Match on verified email and link identities; do not let a duplicate profile appear.
2. **Password policy and reset flow exist** because email/password is enabled. That is real Phase 0 work (`P0-03`) rather than something Entra absorbs.

**Clients never authenticate at all.** Public form submission and client approval are session-less by design — see §Public access.

### Auth metadata: `app_access` and `role`

Every user — test and production — carries two claims in `raw_user_meta_data`, so a shared auth surface can gate which VizServe app they may enter and at what level:

```sql
update auth.users
set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb)
    || '{"app_access": ["vizserve-pms"], "role": "team_leader"}'::jsonb
where email = 'test.tl.vizbytes@example.com';
```

> **Note the `coalesce`.** In Postgres `NULL || '{...}'::jsonb` evaluates to `NULL`, so the statement silently wipes the column whenever it starts null — and the `UPDATE` still reports success. Quiet failure; keep the `coalesce`.

#### The one rule that makes this safe

**Nothing in the authorization path may read `user_metadata`. Ever.**

This is not about the admin UI. `raw_user_meta_data` is writable by the user through **Supabase's own auth server**, not through this application:

```bash
# Any logged-in member, using their own access token from browser storage
curl -X PUT 'https://<project>.supabase.co/auth/v1/user' \
  -H "apikey: <public-anon-key>" \
  -H "Authorization: Bearer <their-own-access-token>" \
  -H "Content-Type: application/json" \
  -d '{"data": {"role": "admin", "app_access": ["vizserve-pms"]}}'
```

That endpoint is part of GoTrue and ships with Supabase Auth. It is not ours to remove, and it does not route through our code — so "we only expose the field to admins in our UI" is a client-side control over a server endpoint we do not own. The access token is sitting in the user's browser; the anon key is public by design.

Supabase's documentation states the rule plainly: *do not use `user_metadata` in a security-sensitive context (such as in RLS policies or authorization logic), as this value is editable by the user without any checks.*

**So the convention stays, and it is fine — because nothing trusts it.**

| Layer | Reads | Spoofable? |
|---|---|---|
| **RLS policies** | `vizserve_pms_users.role` + `vizserve_pms_user_managed_departments` | **No.** The table is the source of truth |
| **Server actions / route handlers** | the same helper (`P0-05`) | No |
| **Middleware app gate** | `user_metadata.app_access` | Yes — see below |
| **UI affordances** | session claims | Yes, and it does not matter |

`user_metadata` is a **display and convenience layer**: it tells the shell which nav to render and which app to route to. It is never the answer to "may this person do this."

#### What a spoofed claim actually buys an attacker

Worth being precise rather than alarmist. If a member rewrites their own `role` to `admin`:

- They see the admin navigation. Cosmetic.
- Every query still returns only their own rows, because RLS reads the table. **No data leaks.**
- Every server action re-checks via `P0-05`. **No writes succeed.**

The damage is zero *only while that second column stays "No" all the way down*. The moment one convenient `if (session.user.user_metadata.role === 'admin')` appears in a server action — and in a year of maintenance, it will be tempting — it becomes a full privilege escalation with no audit trail. That single line is the whole risk.

#### Two cheap defences

1. **A lint rule or a grep in CI** that fails the build if `user_metadata` appears anywhere outside presentation code. This is the highest-value five minutes in Phase 0.
2. **Optional belt-and-braces:** a trigger on `auth.users` that reverts changes to the `role` and `app_access` keys unless the writer is `service_role`. Stops the spoof at the source rather than relying on every future reader behaving.

If either feels like too much friction later, the alternative is moving these two keys to `raw_app_meta_data`, which is service-role-only and not user-writable. Same JSON, same convention, no trust assumptions required.

#### Keeping it in sync

`user_metadata.role` mirrors `vizserve_pms_users.role`, so the two will drift. Add a trigger on `vizserve_pms_users` that updates `auth.users` whenever `role` changes, so a role is set in exactly one place. Two hand-maintained copies of the same fact is a bug waiting for a quiet afternoon.

### A question this raises about Q11

`app_access: ["vizserve-pms"]` only earns its keep if the auth surface is **shared** across several VizServe apps. But D9 put this on a **new, dedicated Supabase project**, where every user in the project is by definition a PMS user.

Both can be true — the claim costs nothing and is good forward-planning if more apps land in this project, or if a shared identity provider arrives later. Worth being deliberate about which it is, though: if auth is genuinely meant to be shared with the SIS or a future app, that is a different architecture from D9 and should be decided on purpose rather than implied by a metadata key.

---

## Core tables

### `vizserve_pms_departments`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text | Confirmed list: **VizBytes, VizAssists, VizBooks, VizMedia** |
| is_active | bool | |

**Seed data (confirmed):**

| Department | Team Leader |
|---|---|
| VizBytes | Amier Ordonez |
| VizAssists | Joel Castro |
| VizBooks | Joel Castro |
| VizMedia | John Lloyd Tulang |

Overall Team Manager: **Joel Castro**.

### `vizserve_pms_users`
Mirrors `auth.users`. Amier listed the fields at ~25:30: *"username or email, tapos password, role, department."*

| column | type | notes |
|---|---|---|
| id | uuid pk | = `auth.users.id` |
| email | citext unique | |
| full_name | text | |
| role | `vizserve_pms_user_role` | `member` \| `team_leader` \| `manager` \| `admin`. **Inclusive hierarchy** — see below |
| primary_department_id | uuid fk | the department the user *belongs to* |
| is_active | bool | |

#### Roles are inclusive, not exclusive

The real roster forces this. Amier Ordonez is an **admin** *and* the Team Leader of VizBytes. Joel Castro is the **Team Manager** *and* the TL of two departments. A single exclusive role per user cannot express either.

So: `admin` ⊇ `manager` ⊇ `team_leader` ⊇ `member`. A user has **one** role — the highest they hold — and `vizserve_pms_user_managed_departments` decides *which* departments they lead or oversee. An admin with VizBytes in their managed set is that department's approver; an admin with an empty managed set simply sees everything without being anyone's TL.

This keeps the four-role decision (D6) intact while matching how the team actually works, and it means the authorization helper (`P0-05`) checks `role >= required_role`, not `role == required_role`.

### `vizserve_pms_user_managed_departments`
The many-to-many that makes a TL/manager's scope work. Amier, ~26:00: *"checkbox, multiple."*

| column | type |
|---|---|
| user_id | uuid fk |
| department_id | uuid fk |
| PK (user_id, department_id) | |

---

## Forms and requests

### `vizserve_pms_forms`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | text | "Collateral Request Form", "User Support" |
| slug | text unique | drives the public URL |
| description | text | |
| department_id | uuid fk | routes to that dept's TL |
| default_list_id | uuid fk | which task list approved requests land in |
| is_public | bool | **true for client forms, false for internal.** The whole auth model hangs off this flag |
| is_active | bool | |
| requires_attachment | bool | true for collateral, false for user support — Amier, ~51:30 |
| sla_days | int | drives the SLA timer |
| created_by | uuid fk | |

### `vizserve_pms_form_fields`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| form_id | uuid fk | |
| label | text | |
| field_key | text | stable key used for task column mapping. **Immutable once the form has a submission** — labels stay editable, the key does not follow them |
| field_type | enum | `text` \| `textarea` \| `date` \| `select` \| `multiselect` \| `file` \| `email` \| `number` |
| options | jsonb | for select types |
| is_required | bool | **default true** — see §Completeness |
| is_active | bool | soft-archive. **A field with data is never hard-deleted** — forms are dynamic (D20) and historical `field_values` are keyed to it. See `R5` |
| sort_order | int | |

### `vizserve_pms_requests`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| form_id | uuid fk | |
| reference_no | text unique | human-readable, e.g. `COL-2026-0142` |
| requester_name | text | |
| requester_email | citext | **the identity used at the client approval gate** |
| requester_org | text | e.g. "HFSE". Plain text — HFSE is the only client at launch (D13). Becomes a controlled list only if ISA/GEG/external clients come into scope |
| title | text | |
| description | text | |
| target_date | date | the date the client asked for |
| approved_target_date | date | the date the TL negotiated to — may differ |
| field_values | jsonb | keyed by `vizserve_pms_form_fields.field_key` |
| status | `vizserve_pms_request_status` | `DRAFT` \| `SUBMITTED` \| `PENDING_REVIEW` \| `APPROVED` \| `RETURNED` \| `REJECTED` |
| decision_reason | text | **required** when status is `RETURNED` or `REJECTED` |
| reviewed_by | uuid fk | |
| reviewed_at | timestamptz | |
| sla_started_at | timestamptz | |
| submitted_at | timestamptz | |

> `approved_target_date` as a separate column is deliberate. The TL's negotiation feature (~39:30) is only measurable if you keep both what the client asked for and what was agreed. Overwriting `target_date` destroys the evidence that negotiation happened — which is the exact metric that proves the TL gate is working.

### `vizserve_pms_request_attachments` / `vizserve_pms_task_attachments`
| column | type |
|---|---|
| id | uuid pk |
| request_id / task_id | uuid fk |
| storage_path | text (Supabase Storage) |
| filename, mime_type, size_bytes | |
| uploaded_by | uuid fk nullable — null when uploaded by a client |

---

## Tasks

### `vizserve_pms_lists`
Amier, ~33:00 — a list per helpdesk area or per project, ClickUp-style.

| column | type |
|---|---|
| id | uuid pk |
| name | text |
| department_id | uuid fk |
| is_active | bool |

### `vizserve_pms_tasks`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| list_id | uuid fk | |
| request_id | uuid fk nullable | **null for manually created tasks** — Amier, ~33:20 |
| title, description | text | inherited from the request |
| due_date | date | = `approved_target_date` |
| assignee_id (PIC) | uuid fk | set by TL at approval |
| qa_assignee_id | uuid fk | **defaults to the approving TL**, overridable |
| status | `vizserve_pms_task_status` | `OPEN` \| `ONGOING` \| `WAITING_FOR_INFO` \| `FOR_QA` \| `QA_IN_PROGRESS` \| `FOR_CLIENT_APPROVAL` \| `COMPLETED` \| `COMPLETED_NO_RESPONSE` |
| resolution | text | **required before status can leave `ONGOING` for `FOR_QA`** — Amier, ~52:30 |
| output_link | text | "please see link" — his literal example at ~53:00 |
| field_values | jsonb | mirrored from the request so task columns match form fields |
| completed_at | timestamptz | |

**Enforce the resolution rule in the database, not just the UI.** A `CHECK` constraint or trigger — the front end will eventually be bypassed by an automation, and this field is what makes the client approval email worth reading.

### `vizserve_pms_task_status_history`
| column | type | notes |
|---|---|---|
| id, task_id | | |
| from_status, to_status | enum | |
| changed_by | uuid fk nullable | null = system (auto-complete) |
| comment | text | required on any backward transition |
| changed_at | timestamptz | |

`WAITING_FOR_INFO` duration is derived from this table — the SLA-pause audit trail (`R4`).

---

## Client approval (no login)

### `vizserve_pms_approval_tokens`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| task_id | uuid fk | |
| token_hash | text | **store a hash, never the raw token** |
| bound_email | citext | = `requests.requester_email`. Enforces "only the requestor may approve" |
| expires_at | timestamptz | |
| consumed_at | timestamptz nullable | |
| auto_complete_at | timestamptz | when the 3-day timer fires |

### `vizserve_pms_client_decisions`
| column | type |
|---|---|
| id, task_id | |
| decision | `vizserve_pms_client_decision`: `APPROVED` \| `REJECTED` \| `AUTO_COMPLETED` |
| comment | text |
| decided_at | timestamptz |
| decided_via_token | uuid fk nullable |
| ip_address, user_agent | text — audit evidence for disputed auto-completes |

### `vizserve_pms_feedback`
| column | type | notes |
|---|---|---|
| id, task_id, request_id | | |
| rating | int 1–5 | |
| comment | text | |
| submitted_at | timestamptz | |

Sent **per completed request**, not periodically. Amier, ~54:30.

---

## Cross-cutting

### `vizserve_pms_audit_logs`
| column | type |
|---|---|
| id | uuid pk |
| entity_type | text (`request` \| `task` \| `dtr_entry` \| `user`) |
| entity_id | uuid |
| action | text |
| actor_id | uuid fk nullable |
| before, after | jsonb |
| created_at | timestamptz |

### `vizserve_pms_notifications`
| column | type |
|---|---|
| id, user_id | |
| type | `vizserve_pms_notification_type`: `pending_approval`, `assigned`, `status_changed`, `qa_requested`, `client_decision` |
| send_email | bool | whether this type also emails. Per-type flag from day one, not a hardcoded `if` — see `12-ui-and-notifications.md` |
| entity_type, entity_id | |
| title, body | text |
| read_at | timestamptz nullable |

---

## Phase 5 tables (define the shape now, build later)

### `vizserve_pms_dtr_entries`
| column | type | notes |
|---|---|---|
| id, user_id | | |
| work_date | date | the date the punch **attaches to**, not necessarily the wall-clock date |
| time_in | timestamptz nullable | earliest wins — never overwritten once set |
| time_out | timestamptz nullable | latest wins — overwritten by a later punch |
| UNIQUE (user_id, work_date) | | one row per person per work date |

### `vizserve_pms_internal_requests`
| column | type |
|---|---|
| id, requester_id | |
| type | `vizserve_pms_internal_request_type`: `LEAVE` \| `NO_TIME_IN` \| `NO_TIME_OUT` \| `REIMBURSEMENT` |
| payload | jsonb |
| status | `SUBMITTED` \| `PENDING_APPROVAL` \| `APPROVED` \| `REJECTED` |
| approver_id, decided_at, decision_reason | |

No leave-balance table in v1. Deliberate — Amier, ~22:40.

### `vizserve_pms_timesheet_entries`
| column | type | notes |
|---|---|---|
| id, user_id | | |
| task_id | uuid fk **NOT NULL** | free-text logging is not allowed — Amier, ~34:30 |
| work_date, hours, notes | | |

---

## Deferred multi-tenancy (Q3)

The decision is to build single-tenant and revisit selling the product once the platform is real and in use. That is a defensible call — the ambition is worth nothing if the thing never ships.

The cost is not zero, though, and it is worth naming precisely so it is a known debt rather than a surprise: **adding a tenant dimension later means touching every query and every RLS policy, against live data.** The bill arrives all at once.

**Three hedges that cost nothing now and cut that bill substantially.** None of them add a column or a concept:

1. **Keep all scoping in the single authorization helper** (`P0-05`). If every query derives its scope from one function, a tenant dimension is added in one place instead of a hundred.
2. **Know which unique constraints are global.** `vizserve_pms_forms.slug` and `vizserve_pms_requests.reference_no` are unique across the whole database today. In a multi-tenant world they would need to be unique *per tenant*. Write that down; do not discover it during a migration.
3. **Keep the RLS policies shaped around a `WHERE` clause that could take one more condition** rather than around assumptions that only hold for a single tenant.

**Revisit trigger:** the moment a second organization is a real conversation and not a hypothetical, this becomes a scheduled piece of work — not something to squeeze into a phase.

---

## RLS strategy

Supabase RLS is the enforcement layer. The app must never be the only thing checking scope.

| Table | Policy shape |
|---|---|
| `vizserve_pms_requests` | member: own submissions; TL/manager: `form.department_id IN (select department_id from vizserve_pms_user_managed_departments where user_id = auth.uid())`; admin: all |
| `vizserve_pms_tasks` | member: `assignee_id = auth.uid() OR qa_assignee_id = auth.uid()`; TL/manager: department scope; admin: all |
| `vizserve_pms_dtr_entries` | member: `user_id = auth.uid()`; TL/manager: department scope; admin: all |
| `vizserve_pms_audit_logs` | admin only |

### Public access — the part that needs care

Two things happen **without a session**: client form submission, and client approval.

- **Form submission** → a Postgres function with `SECURITY DEFINER`, called through an anon-key endpoint, that validates required fields server-side and inserts. Never expose `vizserve_pms_requests` to `anon` directly.
- **Approval page** → a server-side Next.js route that takes the raw token, hashes it, looks up `vizserve_pms_approval_tokens`, and renders. The `anon` role gets **no** table access here.

Rate-limit both. A public URL with no auth is a public URL with no auth. See `R1` and `R2`.

---

## Completeness enforcement — where it actually lives

This is the feature Amier cares most about (§4 of `01-updated-workflow.md`). It needs three layers, because one is not enough:

1. **Form builder default** — `is_required` defaults to `true`. Staff must consciously make a field optional.
2. **Server-side validation** in the submission function — reject the insert, do not save a partial.
3. **A "complete" check at the TL gate** — the TL can still return a request whose fields are technically filled but substantively useless. That is human judgement, and the reason Gate 1 exists.

Client-side validation alone is not enforcement. It is a suggestion.
