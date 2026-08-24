# Implementation Status

**As of 24 August 2026.** What is actually built, what is deliberately absent, and what is owed. Read this before assuming a feature exists or is missing.

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
| **6 — Timesheet, Reporting, Archive** | **Started.** P6-01/02/03 built, applied and green, and rebuilt as a **week grid** on 18 Aug. **P6-05 done 19 Aug** (`/timesheet/team` + `/reports`). P6-04/06/07/08/09 not begun |
| **7 — Personal tasks, overtime, timesheet approval** | **Done — backend and screens.** Eighteen migrations live. **Three more written and NOT yet applied**: P7-32 gender, P7-33 leave balances, P7-34 leave audit PDF — see below |

`npm run verify` is green: **747 passed, 2 skipped, 0 failures** (20 Aug, after
P7-31). The 2 skips are still the opt-in email deliverability tests. Unit tests
are at 366 across 19 files; `tests/db` is 381 across 18. Lint reports **0 errors
and 4 warnings**, all pre-existing and all in the orphaned `supabase/middleware.ts`.

The 19 Aug run — **562 passed, 2 skipped**, with 7 lint warnings — closed one
long-standing gap and found two pre-existing failures:

- **`p7_12`'s eight leave-type db cases executed for the first time** and all pass.
  They had been skipping on a stale PostgREST schema cache since 18 Aug, so the
  migration was only ever verified by direct query.
- **Three `phase5` DTR-correction cases were clock-dependent** — they corrected
  *today* at 09:30 / 07:45 / 06:00, and the function refuses a time that has not
  happened yet, so each passed only after its own hour. The same defect `4e0caea`
  fixed in a neighbouring test. Re-dated to yesterday.
- **`utils/supabase/middleware.test.ts` still asserted `/` was public**, which
  stopped being true when P7-10 made `/` the staff home and emptied
  `PUBLIC_EXACT`.

---

## Phase 7 is complete — backend and screens

**This section used to say "a backend and no front end".** It was true from 18 Aug
until the screens landed on 19 Aug, and it is recorded here rather than deleted
because anybody working from a stale copy of this file will have read it.

Eighteen migrations are applied and every screen the plan owed is built. The
design, the traps, and what is still owed are in the plan file:
`~/.claude/plans/shiny-beaming-crab.md` — its **STATUS** block is the authority,
and it is where the loose ends live.

**Every db suite now proves its own migration.** `p7_12`'s eight leave-type cases
had been skipping on a stale PostgREST schema cache and the migration was verified
by direct query instead; as of 19 Aug all eight execute and pass. Read the warning
immediately below before running a db suite yourself.

The leave-type list that was blocking slice G **arrived on 18 Aug** and is applied
as `p7_12`: Vacation, Sick, Service Incentive, Birthday, Maternity, Paternity,
Solo Parent, Special Leave for Women, seeded in that order (usage, not alphabet).

Settled 18 Aug: **"billed time" means the time entered against a task on the timesheet** — not client-chargeable. There is no billable/non-billable split in the schema and none is being built.

## ✅ FIXED — internal request submission was broken by P7-16 (found and repaired 19 Aug)

From 19 Aug until both repairs below were applied that same day,
`vizserve_pms_submit_internal_request` raised on **every** request type — leave,
reimbursement, overtime and both time corrections. Two distinct faults, both
introduced by `20260819090000_p7_16_leave_halves.sql`, which rewrote the function
whole and, contrary to its own header ("unchanged apart from the two parameters,
the LEAVE validation block and the two insert columns"), changed two more things:

| # | What P7-16 changed without saying so | Symptom | Repair |
|---|---|---|---|
| 1 | Audit call, six arguments to four — a `jsonb` in the helper's `p_actor_id uuid` slot | `42883: function vizserve_pms_write_audit_log(unknown, uuid, unknown, jsonb) does not exist` | `20260819110000_p7_16a` ✅ applied |
| 2 | Approver notification rewritten entire, sending a type that is not in the enum | `invalid input value for enum vizserve_pms_notification_type: "request_submitted"` | `20260819120000_p7_16b` ✅ applied |

Both raise *after* the insert, so the row rolls back with them.

**Why it applied cleanly and hand-verification missed it**, and this generalises:
plpgsql resolves the functions a body calls at **first execution**, not at
`create or replace` time. Inspecting the new columns, the enum and the
constraint — all correct — proves nothing about the body. Only a round trip
through the RPC does.

**`p7_16a` was an incomplete repair, and that is the more useful lesson.** It
fixed the line the error named and shipped; the error names the *first*
statement that fails, not the last one that is wrong, so fixing it only moved the
failure eight lines down. The whole body should have been diffed against `p7_12`
the first time. It has been now — `p7_16b` restores both blocks, and a
comment-stripped `diff` of `p7_12` against it shows only the two new parameters,
the single-day LEAVE check and the three insert columns. Exactly, and only, what
P7-16 set out to do. There is no third fault.

`p7_16b` supersedes `p7_16a`; applying only `p7_16b` is also correct. It uses
`create or replace` with **no drop** — the signature is unchanged, so a drop
would only risk stranding the EXECUTE grant.

**Rejected fix, recorded so it is not retried:** adding `'request_submitted'` to
`vizserve_pms_notification_type`. `vizserve_pms_notify` wraps the settings lookup
in `coalesce(v_send_email, false)` (p0_10:89-96), so a new enum value with no
settings row is not an error — it is a notification type whose email is silently
and permanently off. The leads would stop being emailed about pending approvals
and nothing would say so.

Both repairs are applied and the 29 db cases below are green. Nothing about the
halves, the enum or the constraint was ever wrong; all three were correct from
the first paste, which is exactly why reading the migration could not find this.

## Two new db suites, 19 Aug

`p7_16` and `p7_17` were applied and hand-verified but had no tests. They do now.

| File | Cases | Covers |
|---|---|---|
| `tests/db/leave-halves.test.ts` | 15 | P7-16. The CHECK constraint (reached by direct insert, function bypassed) and the raised sentence, asserted separately — a constraint name is not something a person can act on. Also: the defaults, the dropped nine-argument overload, coercion to null on non-LEAVE types, null halves on pre-P7-16 rows staying decidable, and that the leave calendar deliberately does **not** learn the halves |
| `tests/db/department-visibility.test.ts` | 14 | P7-17. Colleagues visible, department work visible, and the two things deliberately **not** widened: a colleague's `is_personal` task stays private, and SELECT widening did not widen UPDATE or `transition_task`. Also the SECURITY DEFINER recursion guard, and that `managerAll` (no department of their own) still reads through the untouched lead policy |

Status: **29/29 green** — 15 + 14, verified 19 Aug against the live project.

`department-visibility.test.ts` creates and deletes its own throwaway
`test.p7-17.*@example.com` account rather than flipping `is_active` on a seeded
one: the run shares a project with the browsed app, and a run that died between
the flip and the restore would leave a real account unable to log in.

## P7-18 — folders (task groups), 19 Aug

Applied. `vizserve_pms_task_groups` sits between departments and lists, so the
tree is now **Department → Folder → List → Task → Subtask** — ClickUp's five
levels, of which three already existed.

**This reverses the decision recorded at `components/app-shell/nav-projects.tsx:36-40`**
("a department is the folder and a list is the project"). That call did not
survive an example: the folder people want is *"VIZSERVE PROJECTS"*, which is not
a department. Departments are a fixed admin-managed list of *who does the work*;
folders are how a team groups *what the work is for*. The comment is due to be
rewritten when the sidebar lands — until then it contradicts the schema.

Rules, all enforced in the database:

- **Folders do not nest.** No `parent_group_id`, matching ClickUp; depth past one
  folder level comes from subtasks.
- **`lists.group_id` is nullable** — a ClickUp "Folderless List", and the state of
  every list that existed before this migration. No backfill of guesses.
- **One reserved `is_system` folder per department, "Client Requests"**, holding
  one auto-created list per form. It cannot be renamed, archived, deleted, or have
  its flag flipped either way, and it accepts only lists with a `form_id`.

**The keystone: `vizserve_pms_approve_request` is not touched at all.** A trigger
on `vizserve_pms_forms` creates each form's inbox list and points
`forms.default_list_id` at it — and the approval transaction already files
approved requests into that column (P2-06). So client work files itself into the
right folder with zero change to the one function that must not grow.
`default_list_id` is set **only when null**, so a lead's explicit choice survives.

### The tests were written before the paste, deliberately

`tests/db/task-groups.test.ts` — **24 cases, green on the first run after
applying.** It was committed while the migration was still unapplied (it skips
with a printed reason), because of what P7-16 had just taught: plpgsql resolves
the functions a body calls at **first execution**, so a migration can apply
cleanly and be broken on every code path. This one ships two SECURITY DEFINER
functions, three triggers and a `DO` block backfill.

One defect was caught by writing the tests rather than by running them — a
**race in `vizserve_pms_ensure_client_folder`**. `on conflict … do nothing …
returning id` yields NULL on conflict, and the obvious `select` fallback cannot
see a concurrent transaction's *uncommitted* row. Two leads creating a form for
the same department at the same moment would have failed the whole form INSERT.
Fixed to `do update set name = excluded.name`, which takes the row lock and
returns the winner. The suite only dodged it because `fileParallelism: false`.

### It also found three stale tests from P7-17

`tests/db/tasks.test.ts` had **three cases still asserting the pre-P7-17 rule** —
including one whose comment read *"being in the same department is not enough"*,
which is exactly what P7-17 reversed. They had been failing since that migration
was pasted and nobody re-ran the file; `department-visibility.test.ts` asserts the
opposite and passes, so two suites in this repo were contradicting each other.

Rewritten rather than deleted — **the scope boundary did not disappear, it moved
up a level**, from the task to the department. The two P7-13 assignee cases now
assert on *moving* the task instead of *seeing* it, since P7-17 widened SELECT and
deliberately left UPDATE and `transition_task` alone. That is a stronger check
than the one it replaces: visibility no longer distinguishes an assignee from any
colleague, but the right to move it still does.

**Accepted behaviour change:** every form now has a `default_list_id`, so
`vizserve_pms_approve_request` returns a non-null `list_id` where it used to
return null. No test asserts on it (checked across `tests/`), but it is real.

### Backend state

Done: the migration, `lib/database.types.ts` (hand-edited — that file is
hand-written and `npm run db:types` needs Docker), `listSchema.group_id` +
`taskGroupSchema`, `saveTaskGroup`, and `scripts/purge-test-data.mjs`.

`vizserve_pms_task_groups` is in the purge script's **`KEEP`** set and must never
move to `PURGE`: the generic delete would hit the system-folder guard, record a
failure and `exit(1)`. The script now also rebuilds each surviving form's inbox
list after a purge, by calling `vizserve_pms_ensure_form_list` — the same
function the trigger calls, so there is one definition of what a form's list is.
Nothing re-fired on its own, because that trigger only watches insert and
`department_id`.

Also worth knowing: **`saveList` refuses to archive a form's inbox list** (rename
is still allowed). The database guards structure but not `is_active`, and
archiving a live form's inbox would leave client work landing where nobody can
see it.

### Frontend state — built

- **`/tasks/lists`** now manages folders as well as lists. One screen, not a
  sibling route: the first thing anyone does after making a folder is put a list
  in it. The reserved folder gets no pencil, and a form's inbox list shows a
  "From a form" pill with its folder picker and Available switch disabled.
- **Sidebar** renders Department → Folder → List, collapsing at every level.
  Folderless lists sort **above** folders, and the reserved folder sorts **last**
  and is hidden while empty — otherwise every department grows a permanently
  empty CLIENT REQUESTS the day the SQL is pasted.
- **`?group=`** filters the board via a conditional PostgREST embed
  (`vizserve_pms_lists!inner(group_id)`), because tasks carry `list_id` and never
  `group_id`. Folder and List clear each other in the URL.
- **`nav-projects.tsx`'s comment is rewritten** — it argued against this table
  and now records why that call was reversed.

Two things worth knowing for the next person in these files:

**`defaultOpen` was already a bug and is now fixed.** It applies only at mount,
and the app shell does not remount across client navigations — so arriving at a
list from the filter panel left the department holding it collapsed. Both levels
are controlled now, forced open on arrival and never forced shut. The fix adjusts
state **during render** rather than in an effect: React's own lint refuses the
effect version, and it renders the closed state once before correcting it, which
is a visible flicker on every navigation.

**Three shadcn sidebar props are silently dead below the top level**, all because
they key on `group/menu-item` while a nested row carries `group/menu-sub-item`:
`SidebarMenuAction`'s `showOnHover`, the `pr-8` action reservation in
`sidebarMenuButtonVariants`, and `SidebarMenuBadge`'s `top-*` offsets. All three
are supplied by hand in `nav-projects.tsx`. Separately, `SidebarMenuSubButton`
defaults to `<a>` — wrapping one in a `CollapsibleTrigger` without
`render={<button type="button" />}` yields an unfocusable `<a aria-expanded>`
with no href that still works on a mouse click, which is how it would ship
unnoticed.

**Still owed:** nothing in the plan. The task-group work is complete end to end.
Plan: `~/.claude/plans/silly-stargazing-oasis.md`.

## P7-19 / P7-20 — deleting a task, dragging a card, and a design sweep, 19 Aug

### The design sweep

Native controls replaced with the vendored primitives, per the design skill §2
("a raw `<button>`, `<input>`, `<select>` or `<textarea>` in a page is a bug"):

| Fixed | Count |
|---|---|
| Native `<select>` → `Select` | 5 |
| Native date inputs → new `DatePicker` | **20**, across 11 files |
| `<details>/<summary>` → `Collapsible` | 2 |
| Selects rendering a raw UUID or enum in the closed trigger | 16 |

**`components/ui/calendar.tsx` and `react-day-picker` were already in the repo
and nothing imported either.** Every date field was `<Input type="date">` — the
browser's own control, which is three different widgets across Chrome, Safari and
Firefox, none carrying our tokens or a dark mode. `components/ui/date-picker.tsx`
wraps the calendar that was already there.

⚠️ **The value is a bare `YYYY-MM-DD` string and both boundaries convert
explicitly.** In through `parseDateOnly` (midday UTC — midnight lands on the
previous day in a negative offset); out through the picked Date's LOCAL
components, deliberately **not** `toAppDateString`, which answers "what is the
date in Manila for this instant" and would shift the day for anyone browsing from
another timezone. That is also exactly what `<input type="date">` did, so no
stored value moved.

**Left native on purpose:** the `sr-only` file input (no File primitive), the
timesheet grid cell (seven per row — a 40px Input would wreck the grid, and the
existing comment says so), and `/approve/[token]`'s `<details>` (a server
component on the Gate 3 client page — native disclosure needs zero JS, and making
a client's approval page depend on JS is a downgrade).

**A real gap, not a lazy call site: there is no Radio primitive** in
`components/ui/`. Two call sites hand-roll `<input type="radio">` with
`accent-primary`. Base UI has `Radio`/`RadioGroup`; wrapping it is owed.

### Three dead dropdowns on the Gate 1 screen

Found while sweeping, unrelated to any of the above and **committed since
`f4abc5c`**. All three Selects in `app/(app)/requests/[id]/review-panel.tsx` had:

```tsx
onValueChange={(v) => v !== null && (v)}
```

which evaluates the value and discards it. A Team Leader could not change the
PIC, the QA reviewer or the list on the Gate 1 review screen. The PIC had a
second route in (clicking a row in the capacity table); the other two had none.
Swept the codebase — no other no-op handlers exist.

### P7-19 — deleting an internal task

`20260819140000_p7_19_delete_internal_task.sql`, applied, **13/13 tests green on
the first run** (`tests/db/task-delete.test.ts`, written before the paste).

**Internal work only.** A task cascades to nine tables; three of them
(`client_decisions`, `approval_tokens`, `feedback`) exist only on request-backed
work, so scoping to `request_id is null` means those cascades can never fire.
What still goes: timesheet entries, status history, comments, attachments,
assignees — **and every subtask, silently**, via `parent_task_id`.

`vizserve_pms_task_delete_impact` counts the whole subtree so the dialog can name
the damage; the confirm button stays disabled until it comes back, because a
confirm that can be pressed before it knows what it destroys is only pretending
to ask. The audit row is written **before** the delete, with the counts, since
afterwards there is nothing left to count.

**There is still no DELETE policy on `vizserve_pms_tasks`, and there must not
be.** A policy would be a second route that skips the audit row and the
`request_id` guard. `vizserve_pms_delete_task` is the only door, and a direct
`DELETE` through PostgREST still affects zero rows — asserted.

Lists and folders remain archive-only (`is_active`): `tasks.list_id` is
`ON DELETE SET NULL`, so deleting a list would silently unfile every task in it.

### P7-20 — dragging a card on the board

`@dnd-kit/core` added — the one new dependency, and justified by §5.3: HTML5
native drag has no keyboard story, and dnd-kit's `KeyboardSensor` does.

**The board decides nothing about what is legal.** Each card is handed the output
of `availableTransitions()`, the same function the status dropdown uses, which
mirrors `vizserve_pms_transition_task`. So the rule is the one `p7_13a` already
set: **internal work moves anywhere** (its own comment calls the result "a board
card people drag about" — this feature is what it was for), except
`FOR_CLIENT_APPROVAL`, which is a dead end rather than a gate; client work still
follows its table.

A column that cannot take the card dims and refuses the drop, rather than
accepting it and springing back on a server error.

Two things that are load-bearing: an 8px pointer activation distance, or every
click on a card's link would start a drag instead; and a **dedicated grip
handle** rather than a draggable card, because the keyboard sensor would
otherwise steal Space and the arrow keys from the status dropdown inside it.

### The selection bar

`/tasks` rows carry a checkbox and a floating "N tasks selected" bar — the
reference's shape, with one action instead of nine. Delete is what was missing;
the rest either exist inline on the row already or are not features this app has.

**A checkbox appears only on rows that can actually be deleted**, and
`deleteTasks` decides each task on its own rather than wrapping the selection in
a transaction: a selection can legitimately mix work the caller may delete with
work they may not, and one refusal rolling back the other nine is worse than a
partial result honestly reported.

## P7-09 revisited — a subtask sits under its parent, 19 Aug

Three fixes, all reported from the running app.

**The DND payload was wrong on the first try.** `transitionTask` answered *"Check
the highlighted fields"* on every drag — a form error, on a drag with no form.
`transitionPayloadSchema` types `comment` as `.optional()`, **not**
`.nullable()`, so the `{ comment: null }` the board sent failed zod before it
reached the database. The field is omitted now.

**A subtask no longer leaves its parent when its own status changes.** It used to
be pushed into the group for its own status, so moving one to Ongoing tore it out
of the piece of work it belongs to and stranded it three headings away — which
reads as the subtask having been promoted to a task of its own. It now renders
indented **in the parent's group**, whatever its own status, with two exceptions:

- a **finished** subtask leaves the nest for its own terminal group, which is
  what "done" means on a checklist;
- a subtask whose **parent is not on screen** stays top level, because filters
  and the kind tabs can hide a parent and nesting a row under something unrendered
  would delete it from the view.

**The indent replaces the label.** The row used to say "⊢ subtask" in its meta
line and sit flush with its parent, which reads as two tasks that happen to
mention each other. The parent link survives only for the two cases the indent
cannot express — an off-screen parent, and a finished subtask.

**The list row now shows its stage.** It never did — the only status control on
a row is `TaskStatusSelect variant="compact"`, which renders `ArrowRightLeft`
(the same "move" glyph for every stage), is hidden until hover, and returns
`null` outright when there is nowhere legal to move to. A row at rest said
nothing about where it was.

That was defensible while the group heading directly above every row said it, and
the code said so. **Nesting subtasks is what broke it**: a subtask sits in its
parent's group whatever its own status, so the heading now describes the parent
rather than the row. `TaskStatusGlyph` in `components/status-badge.tsx` — the
only file allowed to turn a status into a colour — renders the stage icon in the
stage's tone, before the title, always visible. It is deliberately NOT the status
control: that one moves the task and vanishes when there is nowhere to move to,
which is precisely when a reader still needs to know where the task is.

**The board renders them too.** It used to drop subtasks outright
(`!task.parent_task_id`), so "10 subtasks" was the only trace of ten pieces of
work — countable and unreachable. They fold out under the parent card now,
collapsed by default. They are **not draggable**: their stage follows the work
they belong to, and dragging one to another column is the exact move the nesting
prevents. The count comes from the unfiltered query, so a card reads "10
subtasks" and unfolds the seven still outstanding.

## P7-34 — the leave audit PDF, 24 Aug

**Written, NOT YET APPLIED** — `20260824110000_p7_34_leave_report.sql`, by hand
in the Supabase SQL editor like every other P7 migration. The button exists and
will fail on a missing function until it is pasted.

**Why it exists.** Run it in December, before January, to see how much unused
leave each person is carrying so bonuses can be settled. It gets printed,
checked against HR's manual count, signed and filed — so it is a FILE, not a
screen, and the page states the rules it counted by. Without that, when the two
counts disagree there is no way to tell which is wrong.

**One function, not thirty calls.** `vizserve_pms_leave_report(p_year)` returns a
row per person per leave type in one pass.
`vizserve_pms_leave_balance_summary` answers "what is MY balance" and does an
authority check per call; looping it over the staff list would be thirty round
trips and thirty checks to build one table.

**Scope is by what the caller leads** — admin everyone, lead their departments,
member an empty set rather than an error. **Leavers are included** where they
took leave in the year and flagged `is_active = false`, because their absences
belong to the year being audited. See `D30`.

**The PDF is written here, with no dependency** — see `D29`. `lib/pdf.ts` is a
minimal PDF 1.4 writer: text, rules, a shaded band, Helvetica and
Helvetica-Bold, which are base-14 and need no embedding.
`lib/reports/leave-report.ts` does the layout and knows nothing about bytes.
Table: Employee · Leave type · Allocated · Used · Unused, blocked by person with
a total, and **a person is never split across a page break** — a name on one
sheet and a total on the next is how a bonus gets calculated against the wrong
employee.

**Types with no allocation and no usage are dropped from the print** (eight lines
of zeroes per person would make a three-page audit fifteen), but **a person with
nothing still gets a line saying so** — an absence from an audit table cannot be
told apart from somebody being missed.

**Returned as base64 across the server-action boundary.** A `Uint8Array` does not
survive it, and a "binary string" gets re-encoded as UTF-8 somewhere in the
middle and arrives as a subtly unopenable file.

**Tests.** `tests/unit/leave-report.test.ts`, 32 cases. The one that matters
walks the cross-reference table and asserts every byte offset lands on the
object it claims — which is exactly what a reader does, and the only failure
mode worth automating, since a malformed PDF opens blank with no diagnosis.
Stream lengths, bracket escaping and Latin-1 byte counts are pinned too. Unit
suite is 410 across 20 files. **No `tests/db` coverage** for the function until
the migration is applied.

## P7-32 / P7-33 — gender and leave balances, 24 Aug

**Written, NOT YET APPLIED.** Two migrations —
`20260824090000_p7_32_gender.sql` and `20260824100000_p7_33_leave_balances.sql`
— are in the repo and, like every other P7 migration, have to be pasted into the
Supabase SQL editor by hand. Until that happens the screens below will fail on a
missing column and a missing function. Nothing else in the app reads either.

**P7-33 reverses a standing decision, and the reversal is the headline.**
Balances were waved off in Phase 5 and guarded by a build-failing test. Amier
asked for them per leave type on 24 Aug; the guard was deleted in the same
commit, which is what the test itself instructed. See `D27`.

**Nothing decrements.** `vizserve_pms_leave_balances` stores one fact — days
ALLOCATED, per person per type per year — and
`vizserve_pms_leave_balance_summary` computes usage from approved requests on
every read. A stored counter would have to stay correct across approve, reject,
reverse, edit and reassign, and the first path anybody forgets leaves an
entitlement figure that is wrong and quoted at people. There is consequently no
re-credit path anywhere, because there is nothing to credit back.

**Still out of scope: accrual, carry-over, pro-rating** — and any notion of
REFUSING an overdraw. A request past somebody's allocation submits, approves,
and shows a negative remaining figure to the three people entitled to see it.
HR is the authority on entitlement; this is the record of what they decided.

**Working days, in halves.** `vizserve_pms_leave_days` counts weekdays minus
proclaimed holidays, sharing `vizserve_pms_holidays` with P4's
`add_business_days` so the two cannot drift, and deducts a half only when the
day it describes was itself counted. The asymmetry from P7-16 holds: MORNING is
a whole first day and half a last one.

**Where it surfaces.** `/admin/users` — an allocation panel per leave type in
the editor dialog, with used/remaining fetched by `readLeaveBalances` when the
dialog opens rather than for every row on the page. `/approvals` — the filer
sees their own remaining days beside the type they picked. **Not yet on
`/approvals/[id]`**, where the lead deciding a request would arguably want it
most; that is the obvious next hook and was left out of this pass deliberately.

**P7-32 is unrelated and small.** `vizserve_pms_users.gender`, an enum of
`MALE`/`FEMALE`. **Required in the form, nullable in the database** — the auth
trigger creates profile rows the moment an Entra identity signs in and has
nothing to supply, so NOT NULL there would surface as "SSO is broken". Existing
accounts read "Not set" in the list and are filled in one at a time by an admin
who knows the answer. The 16 seeded test accounts carry alternating values. See
`D28`.

**Tests.** `tests/unit/no-leave-balance.test.ts` deleted;
`tests/unit/leave-balances.test.ts` added in its place, pinning the validation
that lives in TypeScript rather than duplicating the SQL arithmetic. Unit suite
is 378 across 19 files. **No `tests/db` coverage yet** for either migration —
it cannot be written honestly until they are applied.

## P7-31 — the SLA is a duration, 20 Aug

Applied. `vizserve_pms_forms.sla_days` is now **`sla_minutes`**, and the settings
field takes ClickUp's notation — `5d`, `8h`, `2d 4h`. Came out of the 20 Aug
meeting; D21 permits it, because what carries over is the *shape* of a feature
people already know and never its data.

**`1d` is 480 minutes, not 1440.** A working day, which is what "five days" has
always meant on this field, and the working day this schema already assumes —
D24 caps overtime at 960 because that is exactly `1440 − 480`. The default 5
became 2400. Both live forms converted and read back as `5d`.

**Why it was cheap, and why that stops being true.** Nothing reads this column.
It is written in form settings, selected into two page queries, and never once
used in a calculation — the task's deadline comes from the client instead
(`coalesce(p_approved_target_date, target_date)`), and `sla_started_at` is
stamped at submission and never read. No function, policy, index or `select *`
touches it, so the rename could not break anything. **The day the SLA grows
teeth, this is no longer true** — that is the moment to get the unit right, and
it has now passed.

**The parser is deliberately NOT `parseCellDuration`.** `lib/schemas/duration.ts`
is separate, and the two grammars disagree:

| | `parseCellDuration` (timesheet) | `parseSlaDuration` |
|---|---|---|
| bare `5` | 5 **hours** | 5 **days** |
| units | `h` `m` `s` | `d` `h` `m` |
| `2d 4` | 4 minutes | rejected |

A cell holds part of one working day; an SLA is a turnaround standard in days,
and reading `5` as five hours would have cut every existing SLA to an eighth.
`tests/unit/duration.test.ts` has a `unit-divergence` block pinning both
readings so nobody reconciles them without reading why. The `2d 4` case is
stricter here on purpose: the timesheet resolves a unit-less number to minutes,
but next to `d` there is no honest default and the gap is sixtyfold.

**Still true after this, and load-bearing:** the SLA is invisible to the client.
`vizserve_pms_get_public_form` does not return it and
`tests/db/submission.test.ts` asserts so — *"Department, SLA and author are
internal. A public endpoint that leaks the org chart is a small thing that
compounds."*

**Notation only.** Whether the SLA grows a clock, a breach state, or a line on
the Gate 1 review panel is a separate decision and was left open. So is whether
the client should see it at all — the work is usually agreed in chat before the
form is even sent, so a printed turnaround risks contradicting what the TL just
promised.

`client_approval_days` was left alone: it is live, the hourly Gate 3 cron
enforces it on PH business days, and hours there would need working-*hours*
arithmetic rather than the business-*day* calendar that exists.

## ⚠️ The db tests share a project with the running app

`npm run verify` creates and deletes tasks, requests and DTR rows in the **same Supabase project the app is browsed against**. A task can appear in somebody's timesheet picker and be deleted from under them mid-edit. That has already been reported once as a bug and was not one.

A separate dev project is the fix. It is not planned yet.

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
| P1-06 | Public form page | ✅ `/request/[slug]`, no session. `/f/[slug]` 308s to it (P7-29) |
| P1-07 | Submission endpoint | ✅ `SECURITY DEFINER`, server-side validation, structured field errors |
| P1-08 | Requester identity capture | ✅ Email mandatory, not staff-editable |
| P1-09 | Attachment upload | ✅ Two-step receipt handshake — see below |
| P1-10 | Reference numbers | ✅ `COL-2026-0142`, gapless per form per year |
| P1-11 | SLA timer | ✅ `sla_started_at` set on submission. **Nothing consumes it yet** — and `sla_minutes` (P7-31) is not read either |
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
- [x] ~~No leave-balance logic exists anywhere — asserted by `tests/unit/no-leave-balance.test.ts`~~ **Withdrawn 24 Aug 2026 (`D27`).** Balances are in scope per type; the guard test was deleted deliberately, as it asked to be. Green when the phase closed, and recorded rather than removed because a criterion that was met and later reversed is different from one that never existed
- [x] Payroll can export a month of DTR as CSV

All six were green as of 17 Aug 2026: `tests/db/phase5.test.ts` runs its 20 cases against the live project rather than skipping. The fifth has since been withdrawn — see above.

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

**The timesheet is built and VERIFIED against the linked project.** `tests/db/timesheet.test.ts` — 13 cases, run as genuinely signed-in users through RLS — passes, as do the 27 unit cases in `tests/unit/timesheet.test.ts` covering the week maths, the cell parser and the schema.

| ID | Item | State |
|----|------|-------|
| P6-01 | `vizserve_pms_timesheet_entries` migration, `task_id NOT NULL` | ✅ Plus RLS, grants, the day-total trigger |
| P6-02 | Timesheet week grid, add-task picker scoped to assigned tasks | ✅ `/timesheet` — task rows × day columns, picker only, no free text |
| P6-03 | Week navigation, totals, per-cell notes and splits | ✅ Monday-start, week in the URL, typed in the cell |
| P6-04 | Turnaround time reporting | ⛔ Not started |
| P6-05 | Status/volume dashboards per department | ✅ `/timesheet/team` (E1) + `/reports` (E2), 19 Aug. The **narrow** reading only — tasks by stage, requests by status, overdue, hours per department |
| P6-06 | Negotiation and auto-complete split reports | ⛔ Not started |
| P6-07 | Feedback results report | ⛔ Not started |
| P6-08 | Archive | ⛔ Not started |
| P6-09 | CSV export across reports | ⛔ Not started |
| ~~P6-10~~ | ~~ClickUp migration + cutover~~ | ❌ **Withdrawn 18 Aug 2026 (D21)** — no sync, no import, nothing to build |

### The timesheet is a week grid (18 Aug 2026)

Rebuilt from a rail-plus-day-list into ClickUp's shape: tasks down the side, days across the top, a duration typed into the cell, totals on both axes. `D21` is the reason — ClickUp is a *feature* reference now, and this is the interaction the team already knows.

Three things worth knowing before changing it:

- **A cell is a sum.** Several entries per task per day are allowed by the migration *because their notes differ*. A cell holding more than one goes **read-only** and defers to its popover — one typed number cannot honestly replace two entries with two notes.
- **A bare number in a cell is HOURS.** `1.5` → 90 minutes. That is the ambiguity `toMinutes` was split into two fields to avoid, accepted here because a grid has one field per day and reversed by feedback: the cell re-renders as `1:30` on save, so the reading it got is visible where it was typed. `parseCellDuration` in `lib/schemas/timesheet.ts` is the only place this is decided, and it is unit-tested.
- **Empty rows live in `sessionStorage`, not the database.** A task pulled into a week with no time on it yet is not a fact worth a table. Read through `useSyncExternalStore` — an effect that setStates on mount trips `react-hooks/set-state-in-effect`, which is an error in this repo, not a warning.

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
- [x] A week of one member's work can be entered from the grid without leaving it
- [ ] All seven metrics reportable with a date range — P6-04/06/07 not started
- [ ] Archived requests remain queryable — P6-08 not started
- [ ] Every report the team reads in ClickUp has an equivalent here — waits on P6-04/05/07. No cutover plan is owed; `D21` withdrew it

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
and 16 more assertions stop skipping. Reporting and archive (P6-04 onward) are
the rest of the phase and have not been started. There is no migration work left
after them — `P6-10` was withdrawn with `D21`, so what stands between here and
cancelling ClickUp is reports, not records.

Two things still need a human and neither blocks Phase 6:

- **Point an Entra tenant at the login and sign in once.** Identity linking is a
  project setting, not something a migration can enforce.
- **`EMAIL_TEST_RECIPIENT=you@… npm run email:test`**, then check it landed in an
  inbox rather than spam. P4-14 repeats this against a client-domain address —
  deliverability is the one item where a late failure has no workaround.

---

## Phase 7 — personal tasks, overtime, timesheet approval (18–19 Aug 2026)

Backend and screens complete. Eighteen migrations, all applied by hand through the
Supabase SQL editor in filename order — **not** recorded in
`supabase_migrations.schema_migrations`, so `npm run db:push` will trip on them
(see the note at `:267`).

| ID | Item | State |
|----|------|-------|
| P7-00 | Ownership-guard fix in `vizserve_pms_transition_task` | ✅ **Security fix — see below** |
| P7-01 | `is_personal` column + `vizserve_pms_create_personal_task` | ✅ A member creates work for themselves |
| P7-02 | `applies_to` on the transition table + the three completion paths | ✅ |
| P7-03/04 | `OVERTIME` internal request type, day + minutes | ✅ Capped at 960, which is `1440 − 480` |
| P7-05 | `vizserve_pms_timesheet_weeks`, submit/decide, entry locking | ✅ Third consumer of the P2-00 engine, engine untouched |
| P7-06 | Free status movement for internal work, `start_date` | ✅ |
| P7-07/08 | Task comments + `commented` notification type | ✅ Flat, author-only edit, inbox-only |
| P7-09 | Subtasks via `parent_task_id` | ✅ One level, enforced by trigger. **`+` on any row calls it** (19 Aug) — it had no UI at all until then |
| P7-11 | Task priority, nullable, in the column UPDATE grant | ✅ Picker, badge, sort and filter |
| P7-12 | Leave types as an admin-editable table | ✅ applied, and **its eight db cases now execute and pass** (19 Aug) — they had been skipping on a stale PostgREST schema cache |
| P7-13/13a | Several assignees; internal work moves freely | ✅ `FOR_CLIENT_APPROVAL` is a dead end, not a gate. Every move still writes history |
| P7-14 | A member creates and reassigns inside their own department | ✅ The **actions** caught up on 19 Aug — both still carried `requireRole("team_leader")`, so the applied migration was unreachable from the app |
| P7-15 | `estimate_minutes` + `vizserve_pms_task_time_tracked()` | ✅ The rollup is `SECURITY DEFINER` because the timesheet policy is per-person |
| P7-16 | Half-day leave — `start_half` / `end_half` | ✅ applied. MORNING declared first so the single-day rule is a direct enum comparison. Rows written before it keep null halves and read as whole spans |
| P7-17 | A department can see itself | ✅ applied and verified live — see below |

### 🐛 P7-17 — a member could not see their own colleagues

Worth recording as a bug rather than a feature, because it is the third of the
same shape found in two days.

`vizserve_pms_users` was readable as *yourself, or anyone in a department you
**manage**, or everything if admin* (P0-06). A member manages nothing, so they
read exactly one row: their own. **P7-14 then gave members the right to create
and reassign work to a colleague in their own department and never widened
this** — so the assignee picker was empty for exactly the people that migration
was written for. The capability was real and unusable.

The same migration lets a department see its own work. Verified live, as real
member accounts, with the probe rows deleted afterwards:

| | |
|---|---|
| a member sees their department's colleagues | ✅ and only their own department's |
| a member sees shared work they are not on | ✅ |
| a member sees another department's work | ✅ no |
| a colleague sees somebody's **personal** task | ✅ no |
| the owner and the department lead see it | ✅ yes, unchanged |
| a member EDITS work they are not on | ✅ refused, zero rows |

**Personal tasks are the deliberate exception.** `is_personal` means "work I
recorded for myself" (P7-01); publishing it department-wide would turn a private
to-do list into a public one. The UPDATE policy is untouched — seeing your
department's work is not editing it, and widening both together would have made
every member an editor of everything in their department.

**The first paste of P7-17 failed** on `42704: policy ... does not exist` — the
file said `tasks visible by…` and the policy is `tasks readable by…`. That was
the lucky outcome: a DROP that silently matches nothing leaves the old policy
alive beside the new one, and two permissive policies are OR-ed into something
wider than either was meant to be. Both drops are now `if exists`.

### Screens (19 Aug 2026)

| Slice | What shipped |
|---|---|
| K3 | The status **dropdown** — one control on the detail, the list row and the board card. Internal work offers every status but `FOR_CLIENT_APPROVAL`; client work only its legal moves, and no illegal move is rendered greyed |
| K3 | Inline edit of title, both dates, priority and the estimate. Every editor `.select()`s and rolls the field back on a zero-row refusal (trap 9) |
| K3 | Inline creation is a **whole fillable row** (list) or card (board) — name, assignee, both dates, priority, estimate — at **every** stage but `FOR_CLIENT_APPROVAL`. The plan said first-group-only; that was reversed 19 Aug, because everything it creates is internal or personal work and P7-13a lets that move freely |
| K3 | **A subtask is just another task, nested.** The `+` on a row opens the same composer with `parent_task_id` set. The separate `createSubtask` action is gone — two forms for "make a task" is how the subtask one ends up without the fields the other grew |
| K4 | Comment thread, in a popover from the row and inline on the detail — one component, used twice |
| K5 | Progress, time tracked, time estimate and latest comment on the row |
| J | Priority sort and filter |
| F | The missed-punch shortcut from a DTR row into `/approvals?type=&date=` |
| I2/I3/I4 | The dashboard: timesheet strip, "Needs you" as rows ordered by urgency, the lead's band |
| E1/E2 | `/timesheet/team` and **`/reports`** |
| K1 | **Several assignees have a screen at last** — the join table, `is_on_task` and its four policy sites shipped 18 Aug and nothing had ever called them. Monogram stack + searchable picker, name on hover |
| — | The task list's columns are Amier's reference set: name · progress · assignee · priority · start · due · date closed · estimate · tracked · latest comment. Date closed is read from the status history, never a column |
| — | **Sidebar:** groups collapse; child routes are nested (Tasks → List/Board/Lists, Timesheet → My week/Team week); a **project tree** (departments as folders, lists inside) replaces the filter panel as the way to reach a list |
| H | The timesheet cell says it saved, and no longer loses an abandoned draft |

**The board's cards are `<div>`s, not `<Link>`s.** An interactive control inside an
anchor swallows its own clicks, so the whole-card link was replaced by a link on
the title. Worth knowing before "restoring" it.

### ⚠️ The recurring failure: a migration lands, the layer that reaches it does not

**Four instances in two days**, all found by hand and none by a test — because the
db suites exercise SQL directly and never the path a person takes. Check this
explicitly whenever a migration is applied: *what screen or action makes this
reachable, and does it exist?*

| Applied | What stayed unreachable |
|---|---|
| `p7_14` — a member may create and reassign work in their own department | `createTask` and `reassignTask` both still called `requireRole("team_leader")` |
| `p7_14` again | `vizserve_pms_users` was readable only as self-or-managed, so a member could not **see** a colleague to assign to (fixed by `p7_17`) |
| `p7_11` / `p7_15` — `priority`, `estimate_minutes` | Both sat in `taskDetailsSchema` and nothing ever wrote them; the detail form parsed and dropped them |
| `p7_09` / `p7_13` — subtasks, several assignees | Neither had ever been called by any UI at all |

The mirror of it also happened once, in the other direction: the sidebar's
"Create a list" row linked **every** member to `/tasks/lists`, which is
`requireRole("team_leader")` — a door offered to people it does not open for.
Hiding a link protects nobody (the page re-checks, RLS re-checks under it); it
just stops advertising a dead end.

### 🔒 P7-00 — a live authorization hole, found and closed

`vizserve_pms_transition_task` decided who may move a task with:

```sql
v_is_qa := v_task.qa_assignee_id = v_actor;   -- NULL when the column is NULL
if not (v_is_pic or v_is_qa or v_leads) then  -- false OR NULL OR false = NULL
```

`NOT NULL` is `NULL`, and `IF NULL THEN` does not fire. **On any task with no QA reviewer, an unrelated signed-in user passed the ownership guard** and could walk it `FOR_QA → QA_IN_PROGRESS → FOR_CLIENT_APPROVAL` — the transition that emails the real client.

Demonstrated before it was fixed: a member of another department moved a QA-less task and the call returned no error. Fixed with `coalesce(…, false)` on all three. **Any future `create or replace` of that function must carry the coalesce forward** — `tests/db/tasks.test.ts`, "the ownership guard holds when a seat is empty", is what catches a regression.

Three-valued logic reads as correct forever. It is worth grepping for `not (` around nullable columns elsewhere.

### The three kinds of task

The distinction settled on 18 Aug, and what the transition rules key on:

| | `request_id` | `is_personal` | Comes from | Finishes via |
|---|---|---|---|---|
| **Client** | set | false | a shared form, approved at Gate 1 | the client gate |
| **Internal** | null | false | the TL, by hand | its QA reviewer |
| **Personal** | null | **true** | the member, for themselves | the member |

`is_personal` is a **stored column, deliberately not derived**. `created_by = assignee_id` would flip category the moment a task is reassigned, changing which transitions are legal to work somebody is halfway through. It is also kept out of the column-level UPDATE grant, exactly like `status`, so a member cannot reclassify assigned work as personal and close it without review.

### Data-layer bugs found and fixed the same day

All surfaced while investigating "I cannot see my logged time".

1. **DTR was hard-broken and looked empty.** `vizserve_pms_dtr_entries` has **two** FKs to `vizserve_pms_users` (`user_id`, `corrected_by`), so the unqualified embed was refused by PostgREST every time. The page read `data ?? []`, so a total failure rendered as "No entries in this range" — and the empty-state copy actively explained it away. **The payroll CSV export had the same broken embed.** Both now name the constraint; `tests/db/phase5.test.ts` asserts the select strings parse.
2. **The timesheet lost hours.** `!inner` on tasks meant that once a task was reassigned away, the person's own logged time vanished from their week and every total derived from it. Now a left embed; pinned by a test.
3. **No list page checked `.error`.** Every one did `data ?? []`, so any query failure rendered as an empty list. `components/query-error.tsx` now covers DTR, timesheet, tasks, requests and approvals — and it is what exposed bug 1 within minutes of existing.
4. **Silent truncation.** DTR capped at 500 rows while computing "Total in range" from the truncated slice — a payroll number that quietly understated. Approvals capped at 200 in silence. Both now fetch one extra row, detect it, and say so.
5. **Inverted date ranges** on DTR matched nothing and rendered as empty. Now explained, with a one-click swap.
6. **A phantom security failure.** Two Phase 4 tests began failing with "an expired token was accepted". The cause was **clock skew: the database ran 1.13 s behind the test runner**, and the tests aged tokens by exactly 1 s. The product was never wrong. Those tests now age by an hour, with the measurement in the comment.

### Traps this phase added

- **Three migrations had to be split in two** because Postgres forbids *using* an enum value in the transaction that adds it. `p7_03`/`p7_04` and `p7_07`/`p7_08` are the worked examples, alongside the Phase 5 original.
- **A signature change means drop and re-grant.** `create or replace` with a longer argument list creates a *second* function, and PostgREST resolves overloads by argument name — so both match and the call fails as ambiguous.
- **`vizserve_pms_timesheet_week_locked` must stay granted to `authenticated`.** It runs inside a policy, and policy expressions run as the querying role.
- **A policy-refused UPDATE or DELETE is not an error.** PostgREST returns success with zero rows, so the actions ask for `.select("id")` and treat an empty result as a refusal. INSERT differs — `WITH CHECK` raises 42501.
- **The transition mirror test's skip gate must move forward** with every migration that adds a transition row, or it runs against a database that cannot agree with it.
