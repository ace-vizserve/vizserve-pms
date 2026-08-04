# Smoke Test — Phases 0 to 4

**What this is for.** 254 automated tests prove the database is the enforcement layer. None of them opens a browser. This walks the whole client lifecycle by hand, which is the only way to find the things tests do not look at: a button that does nothing, copy that reads wrongly to a client, a page that falls apart on a phone.

**Before you start**

```bash
PORT=3177 npm run dev     # port 3000 is the HFSE SIS app on this machine
```

Sign-in for every test account: `VizServe2026!dev`

Two things are **expected to be broken** and are not bugs:

- **No email arrives, anywhere.** `RESEND_API_KEY` is unset, so the mailer renders and logs and sends nothing. Watch the dev-server console — each would-be send prints `[email:dry-run] → …`. Step 8 gets you the client link without email.
- **DTR, Approvals and Timesheet** are greyed out in the nav with a phase label. That is Phases 5 and 6.

---

## 1 · Sign in and the app-access gate

- [ ] `/login` renders with the VizServe mark and the brand-blue panel
- [ ] Signing in as `test.admin@example.com` lands on `/dashboard`
- [ ] The left nav shows **Dashboard, Forms, Requests, Tasks, Inbox, Users** as live, and **DTR, Approvals, Timesheet** greyed with a phase badge
- [ ] Sign out, sign in as `test.member1.vizbytes@example.com` — **Forms, Requests and Users are gone**, Tasks and Inbox remain
- [ ] On a phone width (or dev-tools ~390px), the hamburger opens the nav and no page scrolls sideways

**The access gate.** As admin, open **Users**, edit `test.member1.vizmedia@example.com`, and turn **Can use VizServe PMS** off.

- [ ] Sign in as that person → you land on `/no-access`, not a login loop
- [ ] The page explains it and offers Sign out
- [ ] Turn it back on as admin; they can sign in again **without** anything being reset

> Worth understanding: that toggle writes one column. Every policy in the system funnels through `vizserve_pms_current_role()`, so revoking it closes every table at once rather than hiding menu items.

---

## 2 · Build a form (P1-16 — this closes an open exit criterion)

As `test.tl.vizbytes@example.com`. **Forms → New form.**

- [ ] Name `Collateral Request`, slug `collateral-request`, department **VizBytes**, prefix `COL`
- [ ] Save, then add fields: `Deliverable` (text, required), `Channel` (select: Facebook / Instagram, required), `Brief` (file, optional), `Notes` (textarea, optional)
- [ ] Reorder two fields with the up/down buttons
- [ ] Set **Published** on and save

- [ ] Try to publish a form with **no department** — it should refuse
- [ ] Create a second form with prefix `COL` again — it should refuse, naming the **prefix** and not the slug

> That last one is a bug found by the test suite this week: two forms sharing a prefix both mint `COL-2026-0001`, and the second client submission died as a 500 on the public form.

---

## 3 · Submit as a client (no login)

Open `/f/collateral-request` in a **private window** — a signed-in one proves nothing.

- [ ] The form renders with your fields and no navigation chrome
- [ ] Submit with **Deliverable empty** → rejected, error against that field
- [ ] Put `   ` (spaces) in Deliverable → still rejected
- [ ] Attach a file to **Brief** → it uploads on selection and shows name and size
- [ ] Rename a `.txt` to `.pdf` and attach it → **rejected**, the contents do not match the extension
- [ ] Submit completely → confirmation shows a reference like `COL-2026-0001`

---

## 4 · Gate 1 — the Team Leader review

As `test.tl.vizbytes@example.com`, **Requests**.

- [ ] The request is there, awaiting review
- [ ] Open it. The **capacity panel** is beside the decision, listing VizBytes members with open counts
- [ ] The attachment downloads (opens in a new tab)
- [ ] Choose a PIC by clicking a name in the capacity panel
- [ ] QA defaults to **you**; change it to a different member
- [ ] Move the delivery date later — the copy says the original is kept
- [ ] **Approve** → toast, and the request now shows the decision

- [ ] Sign in as `test.tl.vizassists@example.com` and open the same request URL → **404**, not a permission error

**Return and reject** (submit two more requests first):

- [ ] Return with a reason under 10 characters → the button stays disabled
- [ ] Return with a real reason → console shows a dry-run email to the requester
- [ ] Reject → the warning says it is final

---

## 5 · Lists

As the VizBytes TL: **Tasks → Lists → New list**.

- [ ] Create `Collateral` for VizBytes
- [ ] It appears grouped under VizBytes with an open count
- [ ] Edit it — the department selector is **locked** (moving it would strand its tasks)
- [ ] Go to **Forms → Collateral Request** and set **Default list** to it
- [ ] Approve another request — the review screen pre-fills that list, and the task lands in it

---

## 6 · Gate 2 — doing the work and QA

Sign in as the **PIC** you assigned.

- [ ] **Tasks** shows the task; the **Mine** tab filters to it
- [ ] The dashboard **My tasks** card shows a count
- [ ] Open the task — the client's original specs are shown above your working area
- [ ] **Start work** → Ongoing
- [ ] **Waiting for info** → it demands a note; add one, then resume
- [ ] With the resolution **empty**, "Send for QA" is disabled and says why
- [ ] Fill the resolution, upload an output file, save
- [ ] **Send for QA** now works

Sign in as the **QA reviewer**.

- [ ] Dashboard shows **Waiting on my QA**; the Tasks page has a matching tab
- [ ] Open it → **Start review**
- [ ] **Send back to PIC** demands a comment. Send it back
- [ ] As the PIC: the comment is visible in History and in the Inbox; send it for QA again
- [ ] As QA: **Pass QA**

> If it moves to *For client approval*, Gate 3 just fired and the approval email was rendered. Check the console for `[email:dry-run]`.

**The board:** `/tasks/board`

- [ ] Columns by stage, terminal states absent, cards link to the task
- [ ] Scrolls sideways inside itself; the page does not

---

## 7 · The state machine holds

As the PIC, on a task in **For client approval**:

- [ ] There are no buttons to complete it — that is the client's decision
- [ ] As a TL, **Force a different status** exists, demands a reason of real length, and appears in History marked **Forced**

---

## 8 · Gate 3 — the client approves (the important one)

```bash
npm run smoke:approval-link
```

Open the printed URL in a **private window**.

- [ ] The page shows reference, title, both dates, **What was done**, output files, and **Your original specs** collapsed
- [ ] It shows the deadline in plain language, not small print
- [ ] The output file downloads
- [ ] **Request changes** demands a comment
- [ ] Do it → confirmation; as the PIC the task is back to **Ongoing** with the comment in History and an inbox notification

Run the flow again to `FOR_CLIENT_APPROVAL`, get a fresh link, and this time:

- [ ] Enter a name and **Approve** → confirmation
- [ ] The task is **Completed**; PIC and QA are both notified

**Security — reuse the link you just consumed:**

- [ ] Reload it → "already been answered", not a second decision
- [ ] Change one character in the token → "not valid"
- [ ] Delete the token entirely (`/approve/`) → 404

---

## 9 · Feedback

- [ ] Console shows a dry-run feedback email after approval. Take the `/feedback/<token>` URL from it
- [ ] Ratings are labelled 1–5, not bare stars
- [ ] Submit → thank you
- [ ] Reload → "we already have your feedback"

---

## 10 · Cron

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3177/api/cron/client-approvals
curl -s http://localhost:3177/api/cron/client-approvals    # no header
```

- [ ] With the header: JSON with counts
- [ ] Without: **404** — and specifically not a redirect to `/login`

> Set `CRON_SECRET` in `.env.local` first; with it unset the route is closed, not open.

---

## What is deliberately not covered

| | Why |
|---|---|
| Real email delivery | No `RESEND_API_KEY`. **P4-14 is the highest-value thing left** — if the approval email lands in spam, a ticket auto-completes with nobody having looked |
| Entra SSO | No tenant has been pointed at it. Identity linking is a project setting, not something a migration can enforce |
| Auto-complete firing on time | The window is business days out. Force it by ageing `auto_complete_at`, or trust `tests/db/client-approval.test.ts` which does exactly that |
| DTR, internal approvals, timesheet | Phases 5 and 6 |

---

## Reporting what you find

Note the **step number**, what you expected, what happened. If it is a permissions oddity, say **which account** — nearly every surface behaves differently for member, TL and admin, and that is usually the answer.
